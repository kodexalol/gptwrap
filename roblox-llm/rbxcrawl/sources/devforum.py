"""Roblox DevForum (Discourse) crawler.

Why not just page through category listings? Discourse caps listing pages at ~2000
(~60k topics per ordering) while `scripting-support` alone has ~230k topics. Instead we
enumerate with date-windowed *search* (50 results/page), adaptively bisecting any window
that saturates the per-query result cap, and only keep threads that have replies
(`min_posts`). Phase 2 fetches each topic, rebuilds the thread with the accepted solution
(fetched separately if it is beyond the first page of posts) and emits one record.

Phases (each resumable through marker files):
    discover  -> <data>/devforum/frontier/<cat>/<window>.jsonl
    fetch     -> <data>/devforum/raw/<cat>-<chunk>-NNNNN.jsonl.zst
"""
from __future__ import annotations

import asyncio
import datetime as dt
import json
import logging
from pathlib import Path

from ..htmlmd import html_to_md
from ..http import Fetcher
from ..records import ShardWriter, is_done, make_record, mark_done, sha1

log = logging.getLogger("rbxcrawl.devforum")

BASE = "https://devforum.roblox.com"
FIRST_DAY = dt.date(2013, 1, 1)
MAX_SEARCH_PAGES = 10  # Discourse search stops serving results past ~500 per query

CATEGORIES: dict[str, dict] = {
    "scripting-support": dict(id=55, parent="help-and-feedback", kind="qa", min_posts=2),
    "code-review": dict(id=75, parent="help-and-feedback", kind="qa", min_posts=2),
    "community-tutorials": dict(id=46, parent="resources", kind="doc", min_posts=1),
    "community-resources": dict(id=74, parent="resources", kind="doc", min_posts=1),
}
# Tier 2: only crawled on request (`--cats tier2`/`all`), after tier 1 has proven worthwhile.
CATEGORIES.update({
    "release-notes": dict(id=62, parent="updates", kind="doc", min_posts=1),
    "announcements": dict(id=36, parent="updates", kind="doc", min_posts=1),
    "documentation-issues": dict(id=72, parent="bug-reports", kind="doc", min_posts=1),
    "engine-bugs": dict(id=28, parent="bug-reports", kind="doc", min_posts=2),
    "studio-bugs": dict(id=29, parent="bug-reports", kind="doc", min_posts=2),
})
TIER1 = ["scripting-support", "code-review", "community-tutorials", "community-resources"]
TIER2 = ["release-notes", "announcements", "documentation-issues", "engine-bugs", "studio-bugs"]


def resolve_cats(spec: str | None) -> list[str]:
    """'' -> tier 1; 'tier2'; 'all'; or a comma list of category slugs."""
    if not spec:
        return list(TIER1)
    if spec == "tier2":
        return list(TIER2)
    if spec == "all":
        return TIER1 + TIER2
    cats = [c.strip() for c in spec.split(",") if c.strip()]
    bad = [c for c in cats if c not in CATEGORIES]
    if bad:
        raise ValueError(f"unknown categories {bad}; known: {list(CATEGORIES)}")
    return cats


# Single-day windows that still saturate are split by these extra filters.
REFINEMENTS = [
    "status:solved",
    "status:unsolved max_posts:2",
    "status:unsolved min_posts:3 max_posts:5",
    "status:unsolved min_posts:6",
]


def cat_query(cat: str) -> str:
    c = CATEGORIES[cat]
    return f"#{c['parent']}:{cat}"


def tag_names(tags) -> list[str]:
    """Discourse returns tags as strings or as {id, name, slug} objects depending on version."""
    out = []
    for t in tags or []:
        name = t.get("name") if isinstance(t, dict) else t
        if isinstance(name, str) and name:
            out.append(name)
    return out


def _slim(t: dict, cat: str) -> dict:
    return {
        "id": t["id"], "cat": cat, "title": t.get("title"), "created": (t.get("created_at") or "")[:10],
        "posts": t.get("posts_count"), "solved": bool(t.get("has_accepted_answer")), "tags": tag_names(t.get("tags")),
    }


# ----------------------------------------------------------------------------- discovery

async def search_window(fx: Fetcher, cat: str, a: dt.date, b: dt.date, extra: str = "",
                        probe: bool = False) -> tuple[dict[int, dict], bool]:
    """All topics created in [a, b). Returns (topics, saturated).

    With probe=True the last servable page is requested first: if it has results the window holds more
    than ~450 topics, so we report it saturated immediately instead of paying for pages 1-9 that the
    caller is about to throw away by splitting the window. Use it only when the window can be split.
    """
    c = CATEGORIES[cat]
    # A refinement that sets its own min_posts replaces the base one: two min_posts operators in
    # one query is ambiguous (one silently wins) and would make buckets overlap or leave gaps.
    base_min = "" if "min_posts:" in extra else f"min_posts:{c['min_posts']}"
    q = f"{cat_query(cat)} in:first {base_min} after:{a} before:{b} {extra} order:latest"
    q = " ".join(q.split())
    found: dict[int, dict] = {}
    if probe:
        r = await fx.get(f"{BASE}/search.json", params={"q": q, "page": MAX_SEARCH_PAGES})
        if r.ok and (r.data or {}).get("topics"):
            return found, True
    for page in range(1, MAX_SEARCH_PAGES + 1):
        r = await fx.get(f"{BASE}/search.json", params={"q": q, "page": page})
        if not r.ok:
            return found, False
        topics = (r.data or {}).get("topics") or []
        new = 0
        for t in topics:
            if t["id"] not in found:
                found[t["id"]] = _slim(t, cat)
                new += 1
        more = ((r.data or {}).get("grouped_search_result") or {}).get("more_full_page_results")
        if not more or new == 0:
            return found, False
    return found, True  # hit the page cap with results still pending


async def enumerate_window(fx: Fetcher, cat: str, a: dt.date, b: dt.date, out: dict[int, dict], stats: dict) -> None:
    span = (b - a).days
    # Splittable windows are probed cheaply; a single day cannot be split, so it is fetched in full
    # (keeping its first ~500 topics) before the refinement filters run.
    topics, saturated = await search_window(fx, cat, a, b, probe=span > 1)
    out.update(topics)
    if not saturated:
        return
    stats["saturated"] = stats.get("saturated", 0) + 1
    if span > 1:
        mid = a + dt.timedelta(days=span // 2)
        await enumerate_window(fx, cat, a, mid, out, stats)
        await enumerate_window(fx, cat, mid, b, out, stats)
        return
    for extra in REFINEMENTS:
        sub, sat = await search_window(fx, cat, a, b, extra)
        out.update(sub)
        if sat:
            stats["unresolved_days"] = stats.get("unresolved_days", 0) + 1
            log.warning("day %s %s still saturated for filter %r", cat, a, extra)


def month_windows(start: dt.date, end: dt.date) -> list[tuple[dt.date, dt.date]]:
    """Calendar-month windows [a, b) covering exactly [start, end); the first/last are clamped."""
    out, cur = [], dt.date(start.year, start.month, 1)
    while cur < end:
        nxt = dt.date(cur.year + (cur.month == 12), (cur.month % 12) + 1, 1)
        a, b = max(cur, start), min(nxt, end)
        if a < b:
            out.append((a, b))
        cur = nxt
    return out


async def discover(fx: Fetcher, cat: str, data_dir: str | Path, start: dt.date = FIRST_DAY,
                   end: dt.date | None = None, parallel: int = 3) -> dict:
    end = end or (dt.date.today() + dt.timedelta(days=1))
    root = Path(data_dir) / "devforum"
    fdir, mdir = root / "frontier" / cat, root / "markers" / f"discover-{cat}"
    sem = asyncio.Semaphore(parallel)
    totals = {"windows": 0, "topics": 0, "saturated": 0, "unresolved_days": 0, "skipped": 0}

    async def one(a: dt.date, b: dt.date) -> None:
        name = a.isoformat()
        if is_done(mdir, name):
            totals["skipped"] += 1
            return
        async with sem:
            out: dict[int, dict] = {}
            stats: dict = {}
            await enumerate_window(fx, cat, a, min(b, end), out, stats)
        fdir.mkdir(parents=True, exist_ok=True)
        tmp = fdir / f"{name}.jsonl.tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            for t in out.values():
                f.write(json.dumps(t, ensure_ascii=False) + "\n")
        tmp.replace(fdir / f"{name}.jsonl")
        mark_done(mdir, name, topics=len(out), **stats)
        totals["windows"] += 1
        totals["topics"] += len(out)
        totals["saturated"] += stats.get("saturated", 0)
        totals["unresolved_days"] += stats.get("unresolved_days", 0)
        log.info("discover %s %s: %d topics (%s)", cat, name, len(out), stats or "ok")

    await asyncio.gather(*(one(a, b) for a, b in month_windows(start, end)))
    return totals


CHUNK = 500


def value_order(topics: list[dict]) -> list[dict]:
    """Most valuable first (solved, then longer threads), so stopping early still keeps the best data."""
    return sorted(topics, key=lambda t: (not t.get("solved"), -(t.get("posts") or 0), t["id"]))


def load_frontier(data_dir: str | Path, cat: str) -> list[dict]:
    seen, out = set(), []
    for p in sorted((Path(data_dir) / "devforum" / "frontier" / cat).glob("*.jsonl")):
        for line in open(p, encoding="utf-8"):
            if line.strip():
                t = json.loads(line)
                if t["id"] not in seen:
                    seen.add(t["id"])
                    out.append(t)
    return out


# ----------------------------------------------------------------------------- threads

def _likes(post: dict) -> int:
    for a in post.get("actions_summary") or []:
        if a.get("id") == 2:
            return int(a.get("count") or 0)
    return 0


def clean_posts(posts: list[dict]) -> list[dict]:
    out = []
    for p in posts:
        if p.get("deleted_at") or p.get("hidden") or p.get("user_deleted"):
            continue
        if p.get("post_type") not in (None, 1):  # keep regular posts only
            continue
        md, images = html_to_md(p.get("cooked") or "")
        if len(md.strip()) < 3:
            continue
        out.append({
            "n": p.get("post_number"), "md": md, "likes": _likes(p), "images": images,
            "solution": bool(p.get("accepted_answer")), "reply_to": p.get("reply_to_post_number"),
            "staff": bool(p.get("staff") or p.get("moderator") or p.get("admin")),
        })
    return sorted(out, key=lambda x: x["n"] or 0)


def build_thread_record(topic: dict, posts: list[dict], cat: str, min_reply_chars: int = 120) -> dict | None:
    cfg = CATEGORIES[cat]
    thread = clean_posts(posts)
    if not thread or thread[0]["n"] != 1:
        return None  # first post missing/removed: no question to learn from
    op, replies = thread[0], thread[1:]
    solved = any(p["solution"] for p in thread)
    if cfg["kind"] == "qa":
        if not replies:
            return None
        if not solved and sum(len(p["md"]) for p in replies) < min_reply_chars:
            return None
    tags = tag_names(topic.get("tags"))
    title = topic.get("title") or topic.get("fancy_title") or ""
    lines = [f"# {title}", f"category: {cat}" + (f" | tags: {', '.join(tags)}" if tags else ""), "", "## Question", op["md"]]
    sols = [p for p in replies if p["solution"]]
    others = [p for p in replies if not p["solution"]]
    if cfg["kind"] == "qa":
        for p in sols:
            lines += ["", "## Accepted solution", p["md"]]
        if others:
            lines += ["", "## Other replies"]
            for i, p in enumerate(others, 1):
                lines += ["", f"### Reply {i}" + (f" (+{p['likes']})" if p["likes"] else ""), p["md"]]
    images = [u for p in thread for u in p["images"]][:8]
    return make_record(
        "devforum", "qa" if cfg["kind"] == "qa" else "doc", f"t/{topic['id']}", "\n".join(lines).strip(),
        title=title, category=cat, tags=tags, created_at=(topic.get("created_at") or "")[:10],
        views=topic.get("views"), likes=topic.get("like_count"), posts=topic.get("posts_count"),
        solved=solved, n_replies=len(replies), images=images,
        thread=[{"role": "question" if p is op else "solution" if p["solution"] else "reply",
                 "md": p["md"], "likes": p["likes"]} for p in thread],
    )


async def fetch_thread(fx: Fetcher, tid: int, cat: str, max_posts: int = 40) -> tuple[dict | None, str]:
    r = await fx.get(f"{BASE}/t/{tid}.json")
    if not r.ok:
        return None, f"http_{r.status}"
    t = r.data
    ps = t.get("post_stream") or {}
    posts = list(ps.get("posts") or [])
    have = {p["id"] for p in posts}
    stream = ps.get("stream") or []
    # Remaining posts, in chunks of 20, up to max_posts total.
    missing = [i for i in stream if i not in have][: max(0, max_posts - len(posts))]
    for i in range(0, len(missing), 20):
        rr = await fx.get(f"{BASE}/t/{tid}/posts.json", params=[("post_ids[]", x) for x in missing[i:i + 20]])
        if rr.ok:
            posts += ((rr.data or {}).get("post_stream") or {}).get("posts") or []
    # Make sure the accepted solution is present even when it is deep in a long thread.
    have_nums = {p.get("post_number") for p in posts}
    for ans in (t.get("accepted_answers") or []):
        pn = ans.get("post_number")
        if pn and pn not in have_nums:
            rr = await fx.get(f"{BASE}/posts/by_number/{tid}/{pn}.json")
            if rr.ok and rr.data:
                posts.append(rr.data)
                have_nums.add(pn)
    rec = build_thread_record(t, posts, cat)
    return (rec, "ok") if rec else (None, "filtered")


async def fetch_partition(fx: Fetcher, topics: list[dict], cat: str, data_dir: str | Path,
                          name: str, concurrency: int = 8) -> dict:
    root = Path(data_dir) / "devforum"
    mdir = root / "markers" / f"fetch-{cat}"
    # The marker name carries a signature of the exact topic ids in this chunk. A chunk index alone is
    # unsafe: if the frontier or ordering ever changes, "chunk 3" would silently refer to different topics.
    name = f"{name}-{sha1(','.join(str(t['id']) for t in topics))[:8]}"
    if is_done(mdir, name):
        return {"skipped": True}
    sem = asyncio.Semaphore(concurrency)
    counts: dict[str, int] = {}
    recs: list[dict] = []

    async def one(t: dict) -> None:
        async with sem:
            rec, why = await fetch_thread(fx, t["id"], cat)
        counts[why] = counts.get(why, 0) + 1
        if rec:
            recs.append(rec)

    await asyncio.gather(*(one(t) for t in topics))
    recs.sort(key=lambda r: r["key"])
    with ShardWriter(root / "raw", f"{cat}-{name}") as w:
        for r in recs:
            w.write(r)
    mark_done(mdir, name, records=len(recs), **counts)
    return {"records": len(recs), **counts}


async def fetch_all(fx: Fetcher, cat: str, data_dir: str | Path, chunk: int = CHUNK,
                    limit: int | None = None) -> dict:
    topics = value_order(load_frontier(data_dir, cat))
    if limit:
        topics = topics[:limit]
    totals: dict[str, int] = {}
    for i in range(0, len(topics), chunk):
        res = await fetch_partition(fx, topics[i:i + chunk], cat, data_dir, f"{i // chunk:05d}")
        for k, v in res.items():
            if isinstance(v, int):
                totals[k] = totals.get(k, 0) + v
        log.info("fetch %s chunk %d/%d %s", cat, i // chunk + 1, -(-len(topics) // chunk), res)
    return totals
