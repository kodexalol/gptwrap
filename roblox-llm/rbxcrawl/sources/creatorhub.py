"""Roblox Creator Hub documentation (create.roblox.com/docs) as Markdown.

The Creator Hub publishes every page as Markdown with a YAML-style header, and an index at
/docs/llms.txt that links all of them. This source:

  1. downloads the index and extracts the unique `/docs/en-us/...md` links (about 2,350 pages,
     covering guides, the Studio/engine reference and the Open Cloud API reference);
  2. fetches each page at a polite rate and strips the header (keeping title, summary and tags);
  3. writes records in partitions of PAGES_PER_CHUNK pages, marked done per partition, so an
     interrupted run resumes where it stopped.

Kinds: engine reference pages (`/reference/engine/`) are "api", everything else is "doc".
"""
from __future__ import annotations

import hashlib
import logging
import re
from pathlib import Path

from ..http import Fetcher
from ..records import ShardWriter, is_done, make_record, mark_done

log = logging.getLogger("rbxcrawl.creatorhub")

BASE = "https://create.roblox.com"
INDEX = f"{BASE}/docs/llms.txt"
PAGES_PER_CHUNK = 250
MIN_BODY_CHARS = 80

_LINK = re.compile(r"\(/docs/en-us/[^)\s]+?\.md\)")
_FRONT = re.compile(r"\A---\s*\n(.*?)\n---\s*\n", re.S)


def page_paths(index_text: str) -> list[str]:
    """Unique `/docs/en-us/....md` paths, in index order."""
    seen: dict[str, None] = {}
    for m in _LINK.finditer(index_text):
        seen.setdefault(m.group(0)[1:-1], None)
    return list(seen)


def parse_page(raw: str) -> tuple[dict, str]:
    """Split a page into (metadata, body). Header fields are simple `key: value` lines or `- item` lists."""
    meta: dict = {}
    m = _FRONT.match(raw)
    if not m:
        return meta, raw.strip()
    key = None
    for line in m.group(1).splitlines():
        if re.match(r"^\s+-\s+", line) and key:
            meta.setdefault(key, [])
            if isinstance(meta[key], list):
                meta[key].append(line.split("-", 1)[1].strip().strip('"'))
        elif ":" in line and not line.startswith(" "):
            k, _, v = line.partition(":")
            key = k.strip()
            v = v.strip().strip('"')
            meta[key] = v if v else []
    return meta, raw[m.end():].strip()


def build_page_record(path: str, raw: str) -> dict | None:
    meta, body = parse_page(raw)
    if len(body) < MIN_BODY_CHARS:
        return None
    title = str(meta.get("title") or path.rsplit("/", 1)[-1].removesuffix(".md"))
    kind = "api" if "/reference/engine/" in path else "doc"
    text = body if body.lstrip().startswith("#") else f"# {title}\n\n{body}"
    return make_record(
        "creatorhub", kind, path, text,
        title=title,
        summary=str(meta.get("summary") or "") or None,
        tags=meta.get("tags") if isinstance(meta.get("tags"), list) else None,
        last_updated=str(meta.get("last_updated") or "") or None,
        url=f"{BASE}{path[:-3]}",
        roblox_repo=True,  # official Roblox documentation: Luau/Roblox by construction
    )


def chunk_signature(paths: list[str]) -> str:
    return hashlib.sha1(",".join(paths).encode()).hexdigest()[:8]


async def run(fx: Fetcher, data_dir: str | Path, limit: int | None = None) -> dict:
    root = Path(data_dir) / "creatorhub"
    mdir = root / "markers"
    idx = await fx.get(INDEX, as_json=False)
    if not idx.ok:
        raise RuntimeError(f"could not download the Creator Hub index: HTTP {idx.status}")
    paths = page_paths(idx.data.decode("utf-8", "replace"))
    if limit:
        paths = paths[:limit]
    log.info("creatorhub: %d pages in the index", len(paths))
    totals = {"pages": len(paths), "records": 0, "skipped_chunks": 0, "failed": 0}
    for ci, start in enumerate(range(0, len(paths), PAGES_PER_CHUNK)):
        part = paths[start:start + PAGES_PER_CHUNK]
        name = f"{ci:05d}-{chunk_signature(part)}"
        if is_done(mdir, name):
            totals["skipped_chunks"] += 1
            continue
        recs, failed = [], []
        for p in part:
            r = await fx.get(f"{BASE}{p}", as_json=False)
            if not r.ok or not r.data:
                failed.append(p)
                continue
            rec = build_page_record(p, r.data.decode("utf-8", "replace"))
            if rec:
                recs.append(rec)
        with ShardWriter(root / "raw", f"creatorhub-{ci:05d}") as w:
            for rec in recs:
                w.write(rec)
        # Failed pages are NOT marked done: a rerun of this chunk retries them. Only a clean chunk is marked.
        if not failed:
            mark_done(mdir, name, records=len(recs), pages=len(part))
        else:
            totals["failed"] += len(failed)
            log.warning("creatorhub chunk %s: %d pages failed, will retry on next run", name, len(failed))
        totals["records"] += len(recs)
        log.info("creatorhub chunk %s: %d records (%d failed)", name, len(recs), len(failed))
    return totals
