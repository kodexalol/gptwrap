import httpx

from rbxcrawl.http import Fetcher
from rbxcrawl.records import iter_records
from rbxcrawl.sources import creatorhub as C

INDEX = """<!-- Last updated: x -->
# Roblox Creator Documentation
- [Players](/docs/en-us/reference/engine/classes/Players.md)
- [Limited use license](/docs/en-us/resources/limited-use-license.md)
- [Players](/docs/en-us/reference/engine/classes/Players.md)
| I want to... | [Engine API index](/docs/reference/engine/llms.txt) |
- [Cloud API](/docs/en-us/cloud.md)
"""

PAGE = """---
title: "Players"
url: /docs/en-us/reference/engine/classes/Players
last_updated: 2026-11-12T20:56:10Z
inherits:
  - Instance
  - Object
type: class
tags:
  - NotCreatable
  - Service
summary: "A service that contains presently connected Player objects."
---

# Class: Players

> A service that contains presently connected Player objects.

Use `Players:GetPlayers()` to list everyone in the server, and `PlayerAdded` to react to joins.
"""


def test_index_yields_unique_en_us_markdown_pages_only():
    paths = C.page_paths(INDEX)
    assert paths == [
        "/docs/en-us/reference/engine/classes/Players.md",
        "/docs/en-us/resources/limited-use-license.md",
        "/docs/en-us/cloud.md",
    ]


def test_parse_page_reads_header_lists_and_body():
    meta, body = C.parse_page(PAGE)
    assert meta["title"] == "Players"
    assert meta["tags"] == ["NotCreatable", "Service"]
    assert meta["summary"].startswith("A service")
    assert body.startswith("# Class: Players")
    assert "PlayerAdded" in body and "---" not in body[:5]


def test_record_kind_and_fields():
    rec = C.build_page_record("/docs/en-us/reference/engine/classes/Players.md", PAGE)
    assert rec["source"] == "creatorhub" and rec["kind"] == "api"
    assert rec["meta"]["title"] == "Players" and rec["meta"]["roblox_repo"] is True
    assert rec["meta"]["url"] == "https://create.roblox.com/docs/en-us/reference/engine/classes/Players"
    guide = C.build_page_record("/docs/en-us/cloud/guides/x.md", PAGE.replace("Players", "Guide"))
    assert guide["kind"] == "doc"


def test_tiny_pages_are_skipped():
    assert C.build_page_record("/docs/en-us/x.md", "---\ntitle: x\n---\n\n# x\n") is None


def test_page_without_header_keeps_its_body():
    rec = C.build_page_record("/docs/en-us/guides/plain.md", "# Plain guide\n\n" + "Text about tweens. " * 10)
    assert rec["text"].startswith("# Plain guide") and rec["meta"]["title"] == "plain"


async def test_run_writes_records_and_resumes_without_refetching(tmp_path, monkeypatch):
    pages = {
        "/docs/llms.txt": INDEX.encode(),
        "/docs/en-us/reference/engine/classes/Players.md": PAGE.encode(),
        "/docs/en-us/resources/limited-use-license.md": PAGE.replace("Players", "License").encode(),
        "/docs/en-us/cloud.md": PAGE.replace("Players", "Cloud").encode(),
    }
    calls = {"n": 0}

    def handler(req: httpx.Request):
        calls["n"] += 1
        body = pages.get(req.url.path)
        return httpx.Response(200, content=body) if body else httpx.Response(404)

    async with Fetcher(default_rate=10_000.0, transport=httpx.MockTransport(handler)) as fx:
        monkeypatch.setattr(C, "INDEX", "https://create.roblox.com/docs/llms.txt")
        first = await C.run(fx, tmp_path)
        after_first = calls["n"]
        second = await C.run(fx, tmp_path)
    assert first["records"] == 3 and first["failed"] == 0
    assert second["skipped_chunks"] == 1 and calls["n"] == after_first + 1   # only the index was re-downloaded
    recs = list(iter_records(tmp_path / "creatorhub" / "raw"))
    assert {r["kind"] for r in recs} == {"api", "doc"} and len(recs) == 3


async def test_failed_pages_are_retried_next_run(tmp_path, monkeypatch):
    state = {"fail": True}
    pages = {
        "/docs/llms.txt": INDEX.encode(),
        "/docs/en-us/reference/engine/classes/Players.md": PAGE.encode(),
        "/docs/en-us/resources/limited-use-license.md": PAGE.encode(),
        "/docs/en-us/cloud.md": PAGE.encode(),
    }

    def handler(req: httpx.Request):
        if req.url.path == "/docs/en-us/cloud.md" and state["fail"]:
            return httpx.Response(404)
        body = pages.get(req.url.path)
        return httpx.Response(200, content=body) if body else httpx.Response(404)

    monkeypatch.setattr(C, "INDEX", "https://create.roblox.com/docs/llms.txt")
    async with Fetcher(default_rate=10_000.0, transport=httpx.MockTransport(handler)) as fx:
        r1 = await C.run(fx, tmp_path)
        state["fail"] = False
        r2 = await C.run(fx, tmp_path)
    assert r1["failed"] == 1 and r2["skipped_chunks"] == 0 and r2["records"] == 3
