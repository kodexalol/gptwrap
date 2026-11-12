"""Async HTTP client with per-host adaptive rate limiting.

Design goals
  * Never exceed the configured rate for a host (the configured rate is a ceiling).
  * Back off immediately and multiplicatively when a host says "slow down" (429, or
    403 with an exhausted rate-limit header), honour Retry-After / reset hints, then
    creep back up toward the ceiling after a run of clean responses (AIMD).
  * Retry transient failures (network errors, 5xx) with exponential backoff + jitter.
  * Do NOT retry or work around real refusals (401/403/404/410): return the status.
"""
from __future__ import annotations

import asyncio
import collections
import random
import time
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlsplit

import httpx

DEFAULT_UA = "rbxcrawl/0.1 (personal research crawler; low rate)"


@dataclass
class Resp:
    status: int
    data: Any
    headers: dict
    url: str

    @property
    def ok(self) -> bool:
        return self.status == 200


class Limiter:
    """Token-spacing limiter with AIMD: rate never exceeds `ceiling`."""

    def __init__(self, rate: float, min_rate: float = 0.2, ok_before_raise: int = 40):
        self.ceiling = float(rate)
        self.rate = float(rate)
        self.min_rate = min(min_rate, self.ceiling)
        self.ok_before_raise = ok_before_raise
        self._next = 0.0
        self._cool = 0.0
        self._ok = 0
        self._strikes = 0
        self._last_cut = -1e9
        self.cut_grace = 15.0   # one multiplicative decrease per congestion event, not per in-flight request
        self._lock = asyncio.Lock()

    async def acquire(self) -> None:
        async with self._lock:
            loop = asyncio.get_running_loop()
            now = loop.time()
            t = max(now, self._next, self._cool)
            self._next = t + 1.0 / self.rate
        if t > now:
            await asyncio.sleep(t - now)

    def success(self) -> None:
        self._ok += 1
        if self._ok >= 10:
            self._strikes = 0
        if self._ok >= self.ok_before_raise and self.rate < self.ceiling:
            self.rate = min(self.ceiling, self.rate * 1.15)
            self._ok = 0

    def throttle(self, wait: float | None = None) -> float:
        """Register a slow-down signal. The first signal of an event halves the rate; further signals within
        `cut_grace` seconds (the other requests that were already in flight) only extend the cooldown.
        Otherwise a burst of N concurrent responses would cut the rate N times and cost ~25 min to recover."""
        loop = asyncio.get_running_loop()
        now = loop.time()
        self._ok = 0
        if now - self._last_cut >= self.cut_grace:
            self._strikes += 1
            self.rate = max(self.min_rate, self.rate * 0.5)
            self._last_cut = now
        w = wait if wait and wait > 0 else min(600.0, 5.0 * 2 ** self._strikes)
        w = min(w, 3600.0)
        self._cool = max(self._cool, now + w)
        return w


def _wait_hint(r: httpx.Response) -> float | None:
    """Seconds the server asked us to wait, from headers or a Discourse JSON body."""
    ra = r.headers.get("retry-after")
    if ra:
        try:
            return float(ra)
        except ValueError:
            pass
    if r.headers.get("x-ratelimit-remaining") == "0":
        reset = r.headers.get("x-ratelimit-reset")
        if reset and reset.isdigit():
            return max(1.0, int(reset) - time.time() + 1)
    try:
        j = r.json()
        w = (j.get("extras") or {}).get("wait_seconds")
        if w:
            return float(w) + 1
    except Exception:
        pass
    return None


def _is_throttle(r: httpx.Response) -> bool:
    if r.status_code == 429:
        return True
    if r.status_code == 403 and (
        r.headers.get("x-ratelimit-remaining") == "0" or r.headers.get("retry-after")
    ):
        return True
    return False


class Fetcher:
    def __init__(
        self,
        rates: dict[str, float] | None = None,
        default_rate: float = 2.0,
        concurrency: int = 16,
        user_agent: str = DEFAULT_UA,
        timeout: float = 30.0,
        max_attempts: int = 6,
        max_throttles: int = 25,
        headers: dict | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
    ):
        self.rates = rates or {}
        self.default_rate = default_rate
        self.concurrency = concurrency
        self.timeout = timeout
        self.max_attempts = max_attempts
        self.max_throttles = max_throttles
        self.headers = {"User-Agent": user_agent, **(headers or {})}
        self._transport = transport
        self._limiters: dict[str, Limiter] = {}
        self._sem: asyncio.Semaphore | None = None
        self._client: httpx.AsyncClient | None = None
        self.stats: collections.Counter = collections.Counter()
        self.samples: list[dict] = []   # first few unusual responses (status, body), for diagnosis
        self.soft_retries = 3

    async def __aenter__(self) -> "Fetcher":
        self._sem = asyncio.Semaphore(self.concurrency)
        self._client = httpx.AsyncClient(
            timeout=httpx.Timeout(self.timeout),
            follow_redirects=True,
            headers=self.headers,
            transport=self._transport,
            limits=httpx.Limits(
                max_connections=self.concurrency * 2,
                max_keepalive_connections=self.concurrency,
            ),
        )
        return self

    async def __aexit__(self, *exc) -> None:
        if self._client:
            await self._client.aclose()

    def snapshot(self) -> dict:
        """Counters plus each host's current rate / cooldown, for periodic logging."""
        now = asyncio.get_running_loop().time()
        return {
            "stats": dict(self.stats),
            "samples": self.samples[:3],
            "hosts": {h: {"rate": round(l.rate, 2), "ceiling": l.ceiling,
                          "cooldown_s": round(max(0.0, l._cool - now), 1), "strikes": l._strikes}
                      for h, l in self._limiters.items()},
        }

    def limiter(self, host: str) -> Limiter:
        if host not in self._limiters:
            self._limiters[host] = Limiter(self.rates.get(host, self.default_rate))
        return self._limiters[host]

    @staticmethod
    def _backoff(attempt: int) -> float:
        return min(60.0, 2.0 ** attempt) * (0.5 + random.random())

    async def get(
        self,
        url: str,
        params: dict | list | None = None,
        headers: dict | None = None,
        as_json: bool = True,
    ) -> Resp:
        assert self._client is not None and self._sem is not None, "use `async with Fetcher()`"
        lim = self.limiter(urlsplit(url).netloc)
        attempt = 0
        throttles = 0
        soft = 0
        while True:
            attempt += 1
            await lim.acquire()
            try:
                async with self._sem:
                    r = await self._client.get(url, params=params, headers=headers)
            except (httpx.TransportError, httpx.TimeoutException):
                self.stats["neterr"] += 1
                if attempt >= self.max_attempts:
                    return Resp(0, None, {}, url)
                await asyncio.sleep(self._backoff(attempt))
                continue

            if _is_throttle(r):
                self.stats["throttled"] += 1
                throttles += 1
                lim.throttle(_wait_hint(r))
                if throttles > self.max_throttles:
                    return Resp(r.status_code, None, dict(r.headers), url)
                continue  # the limiter's cooldown makes the next acquire() sleep
            if r.status_code == 202:
                # An empty-bodied 202 from the load balancer (server: awselb) is bot-defense, not data.
                # Treat it like a 429: slow down (halve the rate, growing cooldown), then retry a few times.
                # We never try to answer the challenge; if it persists we give up and let `repair` retry later.
                self.stats["http_202"] += 1
                if len(self.samples) < 5:
                    self.samples.append({"status": 202, "url": str(r.url), "body": r.text[:200],
                                         "headers": {k: v for k, v in r.headers.items()
                                                     if k.lower() in ("retry-after", "content-type", "server", "cf-ray", "x-discourse-route")}})
                soft += 1
                lim.throttle(_wait_hint(r) or 10.0 * soft)
                if soft > self.soft_retries:
                    return Resp(202, None, dict(r.headers), url)
                continue
            if r.status_code >= 500:
                self.stats["5xx"] += 1
                if attempt >= self.max_attempts:
                    return Resp(r.status_code, None, dict(r.headers), url)
                await asyncio.sleep(self._backoff(attempt))
                continue

            lim.success()
            self.stats["ok" if r.status_code == 200 else f"http_{r.status_code}"] += 1
            data = None
            if r.status_code == 200:
                if as_json:
                    try:
                        data = r.json()
                    except ValueError:
                        return Resp(0, None, dict(r.headers), url)
                else:
                    data = r.content
            return Resp(r.status_code, data, dict(r.headers), str(r.url))

    async def download(self, url: str, dest: str, max_bytes: int = 200_000_000,
                       headers: dict | None = None) -> int:
        """Stream `url` to `dest`. Returns the HTTP status (413 if over max_bytes)."""
        assert self._client is not None and self._sem is not None
        lim = self.limiter(urlsplit(url).netloc)
        for attempt in range(1, self.max_attempts + 1):
            await lim.acquire()
            try:
                async with self._sem:
                    async with self._client.stream("GET", url, headers=headers) as r:
                        if _is_throttle(r):
                            await r.aread()
                            lim.throttle(_wait_hint(r))
                            self.stats["throttled"] += 1
                            continue
                        if r.status_code != 200:
                            self.stats[f"http_{r.status_code}"] += 1
                            return r.status_code
                        n = 0
                        with open(dest, "wb") as f:
                            async for chunk in r.aiter_bytes(65536):
                                n += len(chunk)
                                if n > max_bytes:
                                    return 413
                                f.write(chunk)
                        lim.success()
                        self.stats["ok"] += 1
                        return 200
            except (httpx.TransportError, httpx.TimeoutException):
                self.stats["neterr"] += 1
                await asyncio.sleep(self._backoff(attempt))
        return 0
