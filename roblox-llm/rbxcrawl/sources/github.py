"""GitHub crawler: find Roblox/Luau repos, then pull whole repos as tarballs.

Discovery uses the repository Search API. It returns at most 1000 hits per query, so each
(query, created-window) is recursively bisected whenever `total_count > 1000`.

Fetching deliberately avoids the REST API: one `codeload.github.com` tarball per repo
(not counted against API quotas), streamed to disk and filtered while extracting.

Needs a token (public read, no scopes) for the Search API's 30 req/min budget:
    modal secret create github-token GITHUB_TOKEN=<token>
"""
from __future__ import annotations

import asyncio
import datetime as dt
import json
import logging
import os
import re
import tarfile
import tempfile
from pathlib import Path

from ..http import Fetcher
from ..records import ShardWriter, is_done, make_record, mark_done, sha1

log = logging.getLogger("rbxcrawl.github")

API = "https://api.github.com"
CODELOAD = "https://codeload.github.com"

QUERIES = [
    "language:Luau",
    "language:Lua topic:roblox",
    "language:Lua topic:roblox-studio",
    "language:Lua topic:roblox-lua",
    "language:Lua topic:roblox-game",
    "language:Lua topic:roblox-plugin",
    "language:Lua topic:rojo",
    "language:Lua topic:wally",
    "language:Lua topic:luau",
    "language:Lua topic:roact",
    "language:Lua roblox in:name,description",
    "language:Lua roblox in:readme",
    "language:Lua rojo in:readme",
    "language:Lua wally in:readme",
    "language:Luau roblox in:readme",
]
FIRST = dt.datetime(2008, 1, 1, tzinfo=dt.timezone.utc)

KEEP_EXT = (".lua", ".luau")
PROJECT_FILES = {"default.project.json", "wally.toml", "aftman.toml", "rokit.toml", "foreman.toml",
                 "selene.toml", "stylua.toml", ".luaurc", "rojo.json", "sourcemap.json"}
SKIP_DIRS = {"node_modules", "packages", "devpackages", "serverpackages", "roblox_packages", "wally_packages",
             ".git", "vendor", "third_party", "thirdparty", "dist", "build", "out", "__pycache__", ".lune"}
MAX_FILE = 256 * 1024


def _iso(t: dt.datetime) -> str:
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


def _headers(token: str | None) -> dict:
    h = {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"}
    if token:
        h["Authorization"] = f"Bearer {token}"
    return h


def _slim(it: dict) -> dict:
    return {
        "full_name": it["full_name"], "stars": it.get("stargazers_count", 0), "fork": bool(it.get("fork")),
        "archived": bool(it.get("archived")), "size_kb": it.get("size", 0), "branch": it.get("default_branch") or "main",
        "license": (it.get("license") or {}).get("spdx_id"), "pushed_at": (it.get("pushed_at") or "")[:10],
        "created_at": (it.get("created_at") or "")[:10], "topics": it.get("topics") or [],
        "description": it.get("description"), "language": it.get("language"),
    }


async def bisect_search(fx: Fetcher, token: str | None, query: str, a: dt.datetime, b: dt.datetime,
                        out: dict[str, dict], stats: dict) -> None:
    """Collect every repo matching `query` created in [a, b], splitting windows over 1000 hits."""
    q = f"{query} created:{_iso(a)}..{_iso(b)}"
    r = await fx.get(f"{API}/search/repositories", params={"q": q, "per_page": 100, "page": 1,
                                                          "sort": "updated"}, headers=_headers(token))
    if not r.ok:
        stats["errors"] = stats.get("errors", 0) + 1
        log.warning("search failed (%s) for %s", r.status, q)
        return
    total = r.data.get("total_count", 0)
    if total == 0:
        return
    if total > 1000 and (b - a) > dt.timedelta(seconds=2):
        mid = a + (b - a) / 2
        await bisect_search(fx, token, query, a, mid.replace(microsecond=0), out, stats)
        await bisect_search(fx, token, query, mid.replace(microsecond=0) + dt.timedelta(seconds=1), b, out, stats)
        stats["splits"] = stats.get("splits", 0) + 1
        return
    items = list(r.data.get("items") or [])
    for page in range(2, min(10, -(-total // 100)) + 1):
        rr = await fx.get(f"{API}/search/repositories", params={"q": q, "per_page": 100, "page": page,
                                                               "sort": "updated"}, headers=_headers(token))
        if not rr.ok:
            stats["errors"] = stats.get("errors", 0) + 1
            break
        items += rr.data.get("items") or []
    for it in items:
        out.setdefault(it["full_name"], _slim(it))


async def discover(fx: Fetcher, token: str | None, data_dir: str | Path, queries: list[str] | None = None,
                   end: dt.datetime | None = None) -> dict:
    end = end or dt.datetime.now(dt.timezone.utc)
    root = Path(data_dir) / "github"
    rdir, mdir = root / "repos", root / "markers" / "discover"
    totals = {"repos": 0, "queries": 0, "skipped": 0}
    for query in (queries or QUERIES):
        qid = sha1(query)[:8]
        for year in range(FIRST.year, end.year + 1):
            a = max(FIRST, dt.datetime(year, 1, 1, tzinfo=dt.timezone.utc))
            b = min(end, dt.datetime(year, 12, 31, 23, 59, 59, tzinfo=dt.timezone.utc))
            name = f"{qid}-{year}"
            if is_done(mdir, name):
                totals["skipped"] += 1
                continue
            out: dict[str, dict] = {}
            stats: dict = {}
            await bisect_search(fx, token, query, a, b, out, stats)
            rdir.mkdir(parents=True, exist_ok=True)
            with open(rdir / f"{name}.jsonl", "w", encoding="utf-8") as f:
                for v in out.values():
                    f.write(json.dumps({**v, "query": query}) + "\n")
            if not stats.get("errors"):
                mark_done(mdir, name, repos=len(out), **stats)
            totals["repos"] += len(out)
            log.info("discover %r %s: %d repos %s", query, year, len(out), stats or "")
        totals["queries"] += 1
    return totals


def load_repos(data_dir: str | Path) -> list[dict]:
    seen: dict[str, dict] = {}
    for p in sorted((Path(data_dir) / "github" / "repos").glob("*.jsonl")):
        for line in open(p, encoding="utf-8"):
            if line.strip():
                r = json.loads(line)
                seen.setdefault(r["full_name"], r)
    return list(seen.values())


# ----------------------------------------------------------------------------- fetching

def _skip_path(parts: list[str]) -> bool:
    return any(p.lower() in SKIP_DIRS for p in parts[:-1])


def extract_repo(tar_path: str, repo: dict, max_files: int = 4000) -> list[dict]:
    """Records for the Luau files, plus one README/doc record with the file tree."""
    full = repo["full_name"]
    files: list[tuple[str, str]] = []
    tree: list[str] = []
    readme = ""
    project_markers: set[str] = set()
    with tarfile.open(tar_path, "r:gz") as tf:
        for m in tf:
            if not m.isfile():
                continue
            parts = m.name.split("/")[1:]  # drop the "<repo>-<ref>/" prefix
            if not parts:
                continue
            rel = "/".join(parts)
            base = parts[-1]
            low = base.lower()
            if len(tree) < 400 and not _skip_path(parts):
                tree.append(rel)
            if base in PROJECT_FILES or low.endswith(".project.json"):
                project_markers.add(base)
            if len(parts) == 1 and low.startswith("readme") and m.size < 200_000:
                readme = (tf.extractfile(m).read().decode("utf-8", "replace"))[:20000]
                continue
            if not low.endswith(KEEP_EXT) or low.endswith(".min.lua") or _skip_path(parts):
                continue
            if m.size == 0 or m.size > MAX_FILE or len(files) >= max_files:
                continue
            raw = tf.extractfile(m).read()
            if b"\x00" in raw[:2048]:
                continue
            files.append((rel, raw.decode("utf-8", "replace")))
    roblox_repo = bool(project_markers) or "roblox" in " ".join(repo.get("topics") or []).lower()
    base_meta = dict(repo=full, stars=repo.get("stars"), license=repo.get("license"),
                     pushed_at=repo.get("pushed_at"), topics=repo.get("topics"), roblox_repo=roblox_repo)
    recs = [make_record("github", "code", f"{full}:{rel}", text, path=rel, **base_meta) for rel, text in files]
    if readme.strip() or repo.get("description"):
        recs.append(make_record("github", "doc", f"{full}:README", readme or repo.get("description") or "",
                                tree=tree, n_lua_files=len(files), description=repo.get("description"), **base_meta))
    return recs


async def fetch_repo(fx: Fetcher, repo: dict, max_repo_kb: int) -> tuple[list[dict], str]:
    if repo["size_kb"] > max_repo_kb:
        return [], "too_big"
    url = f"{CODELOAD}/{repo['full_name']}/tar.gz/refs/heads/{repo['branch']}"
    fd, path = tempfile.mkstemp(suffix=".tar.gz", prefix="rbx-")
    os.close(fd)
    try:
        st = await fx.download(url, path, max_bytes=max_repo_kb * 1024)
        if st != 200:
            return [], f"http_{st}"
        return await asyncio.to_thread(extract_repo, path, repo), "ok"
    except (tarfile.TarError, EOFError, OSError):
        return [], "bad_tar"
    finally:
        try:
            os.remove(path)
        except OSError:
            pass


async def fetch_all(fx: Fetcher, data_dir: str | Path, chunk: int = 100, concurrency: int = 4,
                    max_repo_kb: int = 150_000, min_stars: int = 0, skip_forks: bool = True,
                    limit: int | None = None) -> dict:
    repos = [r for r in load_repos(data_dir)
             if not (skip_forks and r["fork"]) and r["stars"] >= min_stars]
    repos.sort(key=lambda r: (-r["stars"], r["full_name"]))
    if limit:
        repos = repos[:limit]
    root = Path(data_dir) / "github"
    mdir = root / "markers" / "fetch"
    totals: dict[str, int] = {}
    sem = asyncio.Semaphore(concurrency)
    for i in range(0, len(repos), chunk):
        name = f"{i // chunk:05d}"
        if is_done(mdir, name):
            continue
        part = repos[i:i + chunk]
        counts: dict[str, int] = {}
        recs: list[dict] = []

        async def one(rp: dict) -> None:
            async with sem:
                rs, why = await fetch_repo(fx, rp, max_repo_kb)
            counts[why] = counts.get(why, 0) + 1
            recs.extend(rs)

        await asyncio.gather(*(one(r) for r in part))
        with ShardWriter(root / "raw", f"repos-{name}") as w:
            for r in sorted(recs, key=lambda r: r["key"]):
                w.write(r)
        mark_done(mdir, name, records=len(recs), **counts)
        for k, v in {**counts, "records": len(recs)}.items():
            totals[k] = totals.get(k, 0) + v
        log.info("fetch chunk %s: %d records %s", name, len(recs), counts)
    return totals
