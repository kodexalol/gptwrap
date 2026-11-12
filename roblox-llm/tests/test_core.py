import asyncio
import httpx
import pytest

from rbxcrawl.dedup import Deduper, normalize
from rbxcrawl.htmlmd import html_to_md
from rbxcrawl.http import Fetcher
from rbxcrawl.records import ShardWriter, is_done, iter_records, make_record, mark_done, read_shard


# ---------------------------------------------------------------- records / shards

def test_shard_roundtrip_rotation_and_atomicity(tmp_path):
    recs = [make_record("t", "code", f"k{i}", f"print({i})", n=i) for i in range(25)]
    with ShardWriter(tmp_path, "x", max_records=10) as w:
        for r in recs:
            w.write(r)
    names = sorted(p.name for p in tmp_path.iterdir())
    assert names == ["x-00000.jsonl.zst", "x-00001.jsonl.zst", "x-00002.jsonl.zst"]  # no .tmp left behind
    assert [r["key"] for r in iter_records(tmp_path)] == [f"k{i}" for i in range(25)]
    assert len(list(read_shard(tmp_path / "x-00002.jsonl.zst"))) == 5


def test_unclosed_writer_leaves_no_complete_looking_shard(tmp_path):
    w = ShardWriter(tmp_path, "y", max_records=100)
    w.write(make_record("t", "code", "a", "x"))
    assert not list(tmp_path.glob("*.jsonl.zst"))  # only a .tmp exists until closed
    w.close()
    assert len(list(tmp_path.glob("*.jsonl.zst"))) == 1


def test_markers(tmp_path):
    assert not is_done(tmp_path, "p1")
    mark_done(tmp_path, "p1", n=3)
    assert is_done(tmp_path, "p1")


def test_record_ids_are_stable():
    a = make_record("s", "code", "k", "x")
    b = make_record("s", "code", "k", "different text")
    assert a["id"] == b["id"] and len(a["id"]) == 20


# ---------------------------------------------------------------- html -> markdown

COOKED = (
    '<p>I want to <b>disable</b> collisions, see <a href="https://create.roblox.com/docs">docs</a>.</p>'
    '<pre><code class="lang-lua">local x = 1\nprint(x)\n</code></pre>'
    '<aside class="quote"><blockquote><p>quoted line</p></blockquote></aside>'
    '<img src="https://img/shot.png" class="emoji" alt=":smile:">'
    '<div class="lightbox-wrapper"><a class="lightbox" href="x"><img src="https://img/studio.png"></a></div>'
    '<ul><li>one</li><li>two</li></ul>'
    '<p>use <code>task.wait()</code></p>'
)


def test_html_to_md():
    md, images = html_to_md(COOKED)
    assert "```lua\nlocal x = 1\nprint(x)\n```" in md
    assert "**disable**" in md and "[docs](https://create.roblox.com/docs)" in md
    assert "> quoted line" in md
    assert "- one" in md and "- two" in md
    assert "`task.wait()`" in md
    assert images == ["https://img/studio.png"]  # emoji excluded, content image kept
    assert ":smile:" in md


def test_html_to_md_empty():
    assert html_to_md("") == ("", [])


# ---------------------------------------------------------------- dedup

def test_dedup_exact_ignores_comments_and_whitespace():
    d = Deduper(near=False)
    a = make_record("s", "code", "1", "-- hello\nlocal x = 1\nprint(x)")
    b = make_record("s", "code", "2", "local   x=1\n\nprint( x )  -- other comment")
    assert normalize(a["text"], "code") == normalize(b["text"].replace("( x )", "(x)").replace("x=1", "x = 1"), "code")
    assert d.check(a) is None
    assert d.check(make_record("s", "code", "3", a["text"])) == "exact_dup"


def test_dedup_near_duplicate():
    base = "\n".join(f"local v{i} = game:GetService('Players'):GetPlayers()[{i}] -- item" for i in range(60))
    d = Deduper(near=True, threshold=0.8)
    assert d.check(make_record("s", "code", "a", base)) is None
    assert d.check(make_record("s", "code", "b", base + "\nprint('one extra line')")) == "near_dup"
    other = "\n".join(f"function Other{i}(a, b) return a * {i} + b end" for i in range(60))
    assert d.check(make_record("s", "code", "c", other)) is None


# ---------------------------------------------------------------- http client

def _fetcher(handler, **kw):
    return Fetcher(default_rate=1000.0, transport=httpx.MockTransport(handler), **kw)


async def test_retries_5xx_then_succeeds(monkeypatch):
    calls = {"n": 0}

    def handler(req):
        calls["n"] += 1
        return httpx.Response(503) if calls["n"] < 3 else httpx.Response(200, json={"ok": 1})

    monkeypatch.setattr(Fetcher, "_backoff", staticmethod(lambda a: 0.001))
    async with _fetcher(handler) as fx:
        r = await fx.get("https://h.test/x")
    assert r.ok and r.data == {"ok": 1} and calls["n"] == 3


async def test_throttle_halves_rate_honours_retry_after_and_recovers():
    seen = {"n": 0}

    def handler(req):
        seen["n"] += 1
        if seen["n"] == 1:
            return httpx.Response(429, headers={"retry-after": "0.05"}, json={})
        return httpx.Response(200, json={"n": seen["n"]})

    async with _fetcher(handler) as fx:
        r = await fx.get("https://h.test/x")
        lim = fx.limiter("h.test")
    assert r.ok and fx.stats["throttled"] == 1
    assert lim.rate == pytest.approx(500.0)  # halved from the 1000 ceiling, never above it


async def test_discourse_wait_seconds_body_is_used():
    from rbxcrawl.http import _wait_hint
    r = httpx.Response(429, json={"extras": {"wait_seconds": 7}})
    assert _wait_hint(r) == 8.0


async def test_404_not_retried():
    calls = {"n": 0}

    def handler(req):
        calls["n"] += 1
        return httpx.Response(404)

    async with _fetcher(handler) as fx:
        r = await fx.get("https://h.test/x")
    assert r.status == 404 and calls["n"] == 1


async def test_gives_up_after_max_throttles():
    def handler(req):
        return httpx.Response(429, headers={"retry-after": "0.001"})

    async with _fetcher(handler, max_throttles=3) as fx:
        r = await fx.get("https://h.test/x")
    assert r.status == 429 and r.data is None


async def test_snapshot_reports_rate_and_cooldown():
    def handler(req):
        return httpx.Response(429, headers={"retry-after": "30"}) if "slow" in req.url.path else httpx.Response(200, json={})

    async with _fetcher(handler, max_throttles=0) as fx:
        await fx.get("https://h.test/ok")
        await fx.get("https://h.test/slow")
        snap = fx.snapshot()
    h = snap["hosts"]["h.test"]
    assert snap["stats"]["ok"] == 1 and snap["stats"]["throttled"] == 1
    assert h["rate"] < h["ceiling"] and 25 < h["cooldown_s"] <= 30 and h["strikes"] == 1


async def test_202_slows_the_host_down_is_retried_and_samples_are_kept(monkeypatch):
    calls = {"n": 0}

    def handler(req):
        calls["n"] += 1
        return httpx.Response(202, text="", headers={"server": "awselb/2.0"}) if calls["n"] <= 2 else httpx.Response(200, json={"ok": 1})

    real_sleep = asyncio.sleep
    monkeypatch.setattr(asyncio, "sleep", lambda s: real_sleep(0))
    async with _fetcher(handler) as fx:
        r = await fx.get("https://h.test/t/1.json")
        snap = fx.snapshot()
    assert r.ok and r.data == {"ok": 1} and calls["n"] == 3
    assert snap["stats"]["http_202"] == 2 and snap["samples"][0]["headers"]["server"] == "awselb/2.0"
    h = snap["hosts"]["h.test"]
    assert h["rate"] < h["ceiling"] and h["cooldown_s"] > 0          # treated as a slow-down signal


async def test_persistent_202_returns_202_not_data(monkeypatch):
    real_sleep = asyncio.sleep
    monkeypatch.setattr(asyncio, "sleep", lambda s: real_sleep(0))
    async with _fetcher(lambda req: httpx.Response(202)) as fx:
        r = await fx.get("https://h.test/x")
    assert r.status == 202 and r.data is None
