import datetime as dt
import io
import json
import re
import tarfile

import httpx
import pytest

from rbxcrawl.http import Fetcher
from rbxcrawl.records import iter_records
from rbxcrawl.sources import devforum, github, hf, rbxapi


def fetcher(handler):
    return Fetcher(default_rate=10_000.0, transport=httpx.MockTransport(handler), concurrency=8)


# ================================================================ DevForum

def make_universe(per_day: dict[dt.date, int]):
    """Synthetic forum: topics with ids, dates, post counts and solved flags."""
    topics, tid = [], 1000
    for day, n in per_day.items():
        for i in range(n):
            tid += 1
            topics.append({"id": tid, "created_at": f"{day}T10:00:00Z", "posts_count": 2 + (i % 8),
                           "has_accepted_answer": i % 3 == 0, "title": f"t{tid}", "tags": []})
    return topics


def search_server(universe, page_cap_results=500):
    """Mimics Discourse search: 50/page, results truncated at page_cap_results per query."""
    def handler(req: httpx.Request):
        q = req.url.params["q"]
        page = int(req.url.params.get("page", 1))
        a = dt.date.fromisoformat(re.search(r"after:(\S+)", q).group(1))
        b = dt.date.fromisoformat(re.search(r"before:(\S+)", q).group(1))
        lo = int(m.group(1)) if (m := re.search(r"min_posts:(\d+)", q)) else 0
        hi = int(m.group(1)) if (m := re.search(r"max_posts:(\d+)", q)) else 10**9
        res = [t for t in universe if a <= dt.date.fromisoformat(t["created_at"][:10]) < b and lo <= t["posts_count"] <= hi]
        if "status:solved" in q:
            res = [t for t in res if t["has_accepted_answer"]]
        if "status:unsolved" in q:
            res = [t for t in res if not t["has_accepted_answer"]]
        full = len(res)
        res = res[:page_cap_results]
        chunk = res[(page - 1) * 50: page * 50]
        more = page * 50 < full  # Discourse keeps saying "more" even though it stops serving past the cap
        return httpx.Response(200, json={"topics": chunk, "posts": [],
                                         "grouped_search_result": {"more_full_page_results": more}})
    return handler


async def test_search_window_not_saturated():
    uni = make_universe({dt.date(2020, 3, 1): 120})
    async with fetcher(search_server(uni)) as fx:
        found, sat = await devforum.search_window(fx, "scripting-support", dt.date(2020, 3, 1), dt.date(2020, 3, 2))
    assert len(found) == 120 and not sat


async def test_bisect_recovers_everything_when_a_month_saturates():
    days = {dt.date(2021, 3, d): 90 for d in range(1, 29)}  # 2520 topics in the month > 500 per query
    uni = make_universe(days)
    out, stats = {}, {}
    async with fetcher(search_server(uni)) as fx:
        await devforum.enumerate_window(fx, "scripting-support", dt.date(2021, 3, 1), dt.date(2021, 4, 1), out, stats)
    assert set(out) == {t["id"] for t in uni}
    assert stats["saturated"] >= 1 and stats.get("unresolved_days", 0) == 0


async def test_single_heavy_day_is_split_by_refinement_filters():
    uni = make_universe({dt.date(2021, 3, 5): 900})  # one day, far over the cap
    out, stats = {}, {}
    async with fetcher(search_server(uni)) as fx:
        await devforum.enumerate_window(fx, "scripting-support", dt.date(2021, 3, 5), dt.date(2021, 3, 6), out, stats)
    assert len(out) == 900 and stats.get("unresolved_days", 0) == 0


async def test_unresolvable_day_is_reported_not_hidden():
    uni = make_universe({dt.date(2021, 3, 5): 5000})
    out, stats = {}, {}
    async with fetcher(search_server(uni)) as fx:
        await devforum.enumerate_window(fx, "scripting-support", dt.date(2021, 3, 5), dt.date(2021, 3, 6), out, stats)
    assert stats["unresolved_days"] >= 1 and 0 < len(out) < 5000


def test_month_windows_cover_range_without_gaps():
    w = devforum.month_windows(dt.date(2013, 1, 1), dt.date(2013, 4, 2))
    assert w[0][0] == dt.date(2013, 1, 1) and w[-1] == (dt.date(2013, 4, 1), dt.date(2013, 4, 2))
    assert all(a[1] == b[0] for a, b in zip(w, w[1:]))
    assert devforum.month_windows(dt.date(2013, 11, 15), dt.date(2014, 1, 3))[1] == (dt.date(2013, 12, 1), dt.date(2014, 1, 1))


def test_month_windows_clamp_to_requested_range():
    # regression: a mid-month --start/--end used to crawl the whole calendar month
    assert devforum.month_windows(dt.date(2021, 3, 9), dt.date(2021, 3, 12)) == [(dt.date(2021, 3, 9), dt.date(2021, 3, 12))]
    assert devforum.month_windows(dt.date(2021, 3, 9), dt.date(2021, 3, 9)) == []


def test_tag_objects_and_strings_are_normalised():
    # regression: Discourse returns tags as {id, name, slug} objects on some endpoints
    assert devforum.tag_names([{"id": 1, "name": "scripting", "slug": "scripting"}, "gui", {"id": 2}, None]) == ["scripting", "gui"]
    topic = {"id": 3, "title": "t", "tags": [{"id": 1, "name": "scripting"}], "posts_count": 2}
    rec = devforum.build_thread_record(topic, [post(1, "<p>question body</p>"), post(2, "<p>" + "answer " * 30 + "</p>")], "scripting-support")
    assert rec["meta"]["tags"] == ["scripting"] and "tags: scripting" in rec["text"]


def post(n, html, **kw):
    return {"id": 100 + n, "post_number": n, "cooked": html, "post_type": 1, **kw}


def test_build_thread_record_qa_with_solution():
    topic = {"id": 7, "title": "How to loop players?", "tags": ["scripting"], "views": 900, "like_count": 4,
             "posts_count": 3, "created_at": "2024-01-02T00:00:00Z"}
    posts = [post(1, '<p>Help</p><pre><code class="lang-lua">for i=1,3 do end</code></pre>'),
             post(2, "<p>Try this maybe</p>", actions_summary=[{"id": 2, "count": 3}]),
             post(3, "<p>Use GetPlayers</p>", accepted_answer=True)]
    rec = devforum.build_thread_record(topic, posts, "scripting-support")
    assert rec["kind"] == "qa" and rec["meta"]["solved"] and rec["meta"]["n_replies"] == 2
    t = rec["text"]
    assert t.index("## Question") < t.index("## Accepted solution") < t.index("## Other replies")
    assert "```lua" in t and "Use GetPlayers" in t and "(+3)" in t
    assert [x["role"] for x in rec["meta"]["thread"]] == ["question", "reply", "solution"]
    assert "username" not in str(rec)  # no user identity is stored


def test_build_thread_record_skips_unanswered_hidden_and_headless():
    topic = {"id": 8, "title": "x"}
    assert devforum.build_thread_record(topic, [post(1, "<p>only question here</p>")], "scripting-support") is None
    assert devforum.build_thread_record(topic, [post(2, "<p>reply without the question</p>")], "scripting-support") is None
    posts = [post(1, "<p>question text</p>"), post(2, "<p>ok</p>", hidden=True), post(3, "<p>x</p>", post_type=4)]
    assert devforum.build_thread_record(topic, posts, "scripting-support") is None
    # a short unsolved reply is not enough; a long one is
    short = [post(1, "<p>question text</p>"), post(2, "<p>no idea</p>")]
    assert devforum.build_thread_record(topic, short, "scripting-support") is None
    long = [post(1, "<p>question text</p>"), post(2, "<p>" + "useful advice " * 20 + "</p>")]
    assert devforum.build_thread_record(topic, long, "scripting-support") is not None


def test_tutorial_category_keeps_single_post_as_doc():
    topic = {"id": 9, "title": "Tutorial: DataStores"}
    rec = devforum.build_thread_record(topic, [post(1, "<p>" + "step by step " * 30 + "</p>")], "community-tutorials")
    assert rec["kind"] == "doc" and "## Question" in rec["text"]


async def test_fetch_thread_pulls_deep_solution_and_extra_pages():
    stream = list(range(101, 131))  # 30 posts: first 20 inline, 10 more via posts.json
    first20 = [post(n, f"<p>reply number {n} with some text</p>") for n in range(1, 21)]
    first20[0] = post(1, "<p>the question body</p>")
    deep = post(25, "<p>the accepted fix is here</p>", accepted_answer=True)
    calls = []

    def handler(req: httpx.Request):
        calls.append(str(req.url))
        if req.url.path == "/t/55.json":
            return httpx.Response(200, json={"id": 55, "title": "t", "post_stream": {"posts": first20, "stream": stream},
                                             "accepted_answers": [{"post_number": 25}], "views": 1})
        if req.url.path == "/t/55/posts.json":
            return httpx.Response(200, json={"post_stream": {"posts": [post(n, f"<p>more {n} text</p>") for n in range(21, 25)]}})
        if req.url.path == "/posts/by_number/55/25.json":
            return httpx.Response(200, json=deep)
        return httpx.Response(404)

    async with fetcher(handler) as fx:
        rec, why = await devforum.fetch_thread(fx, 55, "scripting-support")
    assert why == "ok" and rec["meta"]["solved"]
    assert "the accepted fix is here" in rec["text"]
    assert any("/posts/by_number/55/25.json" in c for c in calls)


async def test_fetch_thread_reports_forbidden():
    async with fetcher(lambda req: httpx.Response(403)) as fx:
        rec, why = await devforum.fetch_thread(fx, 1, "scripting-support")
    assert rec is None and why == "http_403"


# ================================================================ GitHub

def repo_item(name, stars=1, lic="MIT"):
    return {"full_name": name, "stargazers_count": stars, "fork": False, "size": 100, "default_branch": "main",
            "license": {"spdx_id": lic}, "pushed_at": "2024-01-01T00:00:00Z", "created_at": "2020-01-01T00:00:00Z",
            "topics": ["roblox"], "language": "Luau", "description": "d"}


async def test_github_bisect_splits_windows_over_1000_hits():
    world = {f"o/r{i}": dt.datetime(2020, 1, 1, tzinfo=dt.timezone.utc) + dt.timedelta(hours=i * 7) for i in range(2500)}

    def handler(req: httpx.Request):
        q = req.url.params["q"]
        a, b = re.search(r"created:(\S+)\.\.(\S+)", q).groups()
        a = dt.datetime.strptime(a, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=dt.timezone.utc)
        b = dt.datetime.strptime(b, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=dt.timezone.utc)
        hits = [n for n, t in world.items() if a <= t <= b]
        page, per = int(req.url.params["page"]), int(req.url.params["per_page"])
        items = [repo_item(n) for n in hits[(page - 1) * per: page * per]] if len(hits) <= 1000 else [repo_item(hits[0])]
        return httpx.Response(200, json={"total_count": len(hits), "items": items})

    out, stats = {}, {}
    async with fetcher(handler) as fx:
        await github.bisect_search(fx, "tok", "language:Luau", dt.datetime(2020, 1, 1, tzinfo=dt.timezone.utc),
                                   dt.datetime(2022, 12, 31, tzinfo=dt.timezone.utc), out, stats)
    assert set(out) == set(world) and stats["splits"] >= 2


async def test_github_search_sends_auth_and_reports_failure():
    seen = {}

    def handler(req):
        seen["auth"] = req.headers.get("authorization")
        return httpx.Response(422, json={"message": "bad"})

    out, stats = {}, {}
    async with fetcher(handler) as fx:
        await github.bisect_search(fx, "tok123", "q", dt.datetime(2020, 1, 1, tzinfo=dt.timezone.utc),
                                   dt.datetime(2020, 2, 1, tzinfo=dt.timezone.utc), out, stats)
    assert seen["auth"] == "Bearer tok123" and stats["errors"] == 1 and not out


def build_tar(path, files: dict[str, bytes | str]):
    with tarfile.open(path, "w:gz") as tf:
        for name, content in files.items():
            data = content.encode() if isinstance(content, str) else content
            ti = tarfile.TarInfo(f"repo-main/{name}")
            ti.size = len(data)
            tf.addfile(ti, io.BytesIO(data))


def test_extract_repo_filters_vendored_min_big_and_binary(tmp_path):
    p = tmp_path / "r.tar.gz"
    build_tar(p, {
        "src/server/Main.server.luau": "print('hi')\n",
        "src/Util.lua": "return {}\n",
        "Packages/Promise.lua": "return 1\n",                       # vendored
        "src/node_modules/x.lua": "return 1\n",                     # vendored
        "lib/jquery.min.lua": "return 1\n",                         # minified
        "src/Huge.lua": "a" * (300 * 1024),                          # too big
        "src/Bin.lua": b"\x00\x01\x02binary",                        # binary
        "src/notes.txt": "not lua",
        "default.project.json": "{}",
        "README.md": "# Cool game\nA roblox game",
    })
    repo = {"full_name": "o/r", "stars": 42, "license": "MIT", "pushed_at": "2024-05-01", "topics": []}
    recs = github.extract_repo(str(p), repo)
    code = {r["meta"]["path"] for r in recs if r["kind"] == "code"}
    assert code == {"src/server/Main.server.luau", "src/Util.lua"}
    doc = [r for r in recs if r["kind"] == "doc"][0]
    assert "Cool game" in doc["text"] and "Packages/Promise.lua" not in doc["meta"]["tree"]
    assert all(r["meta"]["roblox_repo"] and r["meta"]["stars"] == 42 and r["meta"]["license"] == "MIT" for r in recs)


async def test_fetch_repo_handles_errors_and_size_cap(tmp_path):
    good = tmp_path / "g.tar.gz"
    build_tar(good, {"a.luau": "print(1)\n", "default.project.json": "{}"})
    blob = good.read_bytes()

    def handler(req):
        if "missing" in req.url.path:
            return httpx.Response(404)
        if "corrupt" in req.url.path:
            return httpx.Response(200, content=b"not a tarball")
        return httpx.Response(200, content=blob)

    repo = lambda n, kb=10: {"full_name": n, "size_kb": kb, "branch": "main", "stars": 1, "license": None, "pushed_at": "", "topics": []}
    async with fetcher(handler) as fx:
        assert (await github.fetch_repo(fx, repo("o/ok"), 1000))[1] == "ok"
        assert (await github.fetch_repo(fx, repo("o/missing"), 1000))[1] == "http_404"
        assert (await github.fetch_repo(fx, repo("o/corrupt"), 1000))[1] == "bad_tar"
        assert (await github.fetch_repo(fx, repo("o/big", 5000), 1000))[1] == "too_big"


# ================================================================ rbxapi / hf

def test_rbxapi_build_records_and_deprecations():
    dump = {"Classes": [
        {"Name": "Instance", "Superclass": "<<<ROOT>>>", "Members": [
            {"MemberType": "Property", "Name": "Name", "ValueType": {"Name": "string", "Category": "Primitive"}, "Tags": []},
            {"MemberType": "Function", "Name": "Destroy", "Parameters": [], "ReturnType": {"Name": "null"}, "Tags": []},
            {"MemberType": "Function", "Name": "remove", "Parameters": [], "ReturnType": {"Name": "null"}, "Tags": ["Deprecated"]},
            {"MemberType": "Property", "Name": "Secret", "ValueType": {"Name": "int"}, "Tags": [], "Security": {"Read": "RobloxScriptSecurity", "Write": "RobloxScriptSecurity"}},
        ]},
        {"Name": "BodyVelocity", "Superclass": "BodyMover", "Tags": ["Deprecated"], "Members": [
            {"MemberType": "Event", "Name": "Touched", "Parameters": [{"Name": "part", "Type": {"Name": "BasePart"}}], "Tags": []}]},
    ], "Enums": [{"Name": "PartType", "Items": [{"Name": "Ball", "Value": 0}, {"Name": "Block", "Value": 1}]}]}
    # regression: some Tags entries are objects, not strings
    dump["Classes"][0]["Members"][0]["Tags"] = [{"PreferredDescriptorName": "Name"}]
    recs, dep = rbxapi.build(dump, "version-x")
    assert dep["classes"] == ["BodyVelocity"] and dep["members"] == {"Instance": ["remove"]}
    inst = next(r for r in recs if r["key"] == "class/Instance")["text"]
    assert "Name: string" in inst and "Destroy() -> null" in inst and "remove() -> null [deprecated]" in inst
    assert "Secret" not in inst  # engine-internal members are not exposed
    assert "Touched(part: BasePart)" in next(r for r in recs if r["key"] == "class/BodyVelocity")["text"]
    assert next(r for r in recs if r["key"] == "enum/PartType")["text"] == "enum Enum.PartType: Ball=0, Block=1"


def test_hf_adapters_match_real_schemas():
    n = hf.normalize_row
    r = n("Roblox/luau_corpus", {"prompt": "--(\"x\")", "completion": "\nlocal a = 1"})
    assert r["kind"] == "code" and r["text"] == '--("x")\nlocal a = 1'
    r = n("Pinkstack/unf", {"repo_path": "o/r", "file_path": "a.luau", "language": "Luau", "content": "print(1)",
                            "license_type": "mit", "luau_syntax_score": 5, "roblox_api_score": 9, "from_roblox_flagged_repo": "True"})
    assert r["meta"]["repo"] == "o/r" and r["meta"]["roblox_repo"] is True and r["meta"]["license"] == "mit"
    assert n("x/y", {"repo": "o/r", "language": "JSON", "file_path": "a.json", "content": "{}"}) is None
    r = n("T/reason", {"code": "c", "prompt": "write c", "chain_of_thought": "think", "explanation": "e"})
    assert r["kind"] == "instruct" and r["meta"]["cot"] == "think"
    r = n("P/sft", {"conversations": [{"from": "system", "value": "s"}, {"from": "human", "value": "q"}, {"from": "gpt", "value": "a"}]})
    assert r["kind"] == "chat" and [m["role"] for m in r["meta"]["messages"]] == ["system", "user", "assistant"]
    r = n("j/x", {"instruction": "Explain", "input": "src", "output": "code"})
    assert r["kind"] == "instruct" and r["meta"]["prompt"].startswith("Explain")
    r = n("k/devforum", {"source": "https://devforum.roblox.com/t/1", "topic_id": "1", "title": "T", "content": "# T\nbody", "views": 3})
    assert r["kind"] == "doc" and r["meta"]["title"] == "T"
    assert n("x/y", {"nothing": 1}) is None


async def test_discover_is_resumable_and_skips_finished_windows(tmp_path):
    uni = make_universe({dt.date(2021, 3, 5): 30, dt.date(2021, 4, 5): 20})
    calls = {"n": 0}
    base = search_server(uni)

    def counting(req):
        calls["n"] += 1
        return base(req)

    async with fetcher(counting) as fx:
        first = await devforum.discover(fx, "scripting-support", tmp_path, dt.date(2021, 3, 1), dt.date(2021, 5, 1))
        n_first = calls["n"]
        second = await devforum.discover(fx, "scripting-support", tmp_path, dt.date(2021, 3, 1), dt.date(2021, 5, 1))
    assert first["topics"] == 50 and first["windows"] == 2
    assert second["skipped"] == 2 and second["windows"] == 0 and calls["n"] == n_first  # no new requests
    assert {t["id"] for t in devforum.load_frontier(tmp_path, "scripting-support")} == {t["id"] for t in uni}


def test_value_order_puts_solved_and_long_threads_first():
    ts = [{"id": 1, "solved": False, "posts": 9}, {"id": 2, "solved": True, "posts": 2},
          {"id": 3, "solved": True, "posts": 7}, {"id": 4, "solved": False, "posts": 3}]
    assert [t["id"] for t in devforum.value_order(ts)] == [3, 2, 1, 4]


async def test_fetch_partition_marker_is_bound_to_chunk_contents(tmp_path):
    # regression: a stale "chunk 00000" marker (e.g. from a --limit smoke run) must not skip a different chunk 00000
    def handler(req):
        tid = int(req.url.path.split("/")[2].split(".")[0])
        posts = [post(1, f"<p>question {tid}</p>"), post(2, "<p>" + "an answer " * 30 + "</p>")]
        return httpx.Response(200, json={"id": tid, "title": f"t{tid}", "post_stream": {"posts": posts, "stream": [101, 102]}})

    a = [{"id": 1}, {"id": 2}]
    b = [{"id": 3}, {"id": 4}]
    async with fetcher(handler) as fx:
        r1 = await devforum.fetch_partition(fx, a, "scripting-support", tmp_path, "00000")
        r2 = await devforum.fetch_partition(fx, a, "scripting-support", tmp_path, "00000")   # same content: skipped
        r3 = await devforum.fetch_partition(fx, b, "scripting-support", tmp_path, "00000")   # different content: runs
    assert r1["records"] == 2 and r2 == {"skipped": True} and r3["records"] == 2
    assert {r["key"] for r in iter_records(tmp_path / "devforum" / "raw")} == {"t/1", "t/2", "t/3", "t/4"}


def test_resolve_cats():
    assert devforum.resolve_cats("") == devforum.TIER1 and "engine-bugs" not in devforum.TIER1
    assert devforum.resolve_cats("tier2") == devforum.TIER2
    assert devforum.resolve_cats("all") == devforum.TIER1 + devforum.TIER2
    assert devforum.resolve_cats("code-review, engine-bugs") == ["code-review", "engine-bugs"]
    with pytest.raises(ValueError):
        devforum.resolve_cats("nope")
    assert all(c in devforum.CATEGORIES for c in devforum.TIER1 + devforum.TIER2)


def test_extract_repo_caps_total_bytes(tmp_path):
    p = tmp_path / "r.tar.gz"
    build_tar(p, {f"src/f{i}.lua": "x = 1\n" * 40_000 for i in range(10)})   # ~240 KB each
    repo = {"full_name": "o/r", "stars": 1, "license": None, "pushed_at": "", "topics": []}
    recs = github.extract_repo(str(p), repo, max_total_bytes=600_000)
    assert 1 <= sum(r["kind"] == "code" for r in recs) <= 3


async def test_github_fetch_all_markers_bound_to_chunk_contents(tmp_path):
    good = tmp_path / "g.tar.gz"
    build_tar(good, {"a.luau": "print(1)\n", "default.project.json": "{}"})
    blob = good.read_bytes()
    data = tmp_path / "data"

    def write_repos(names):
        d = data / "github" / "repos"
        d.mkdir(parents=True, exist_ok=True)
        with open(d / "q.jsonl", "w") as f:
            for n in names:
                f.write(json.dumps({"full_name": n, "stars": 1, "fork": False, "archived": False, "size_kb": 10,
                                    "branch": "main", "license": "MIT", "pushed_at": "", "topics": []}) + "\n")

    async with fetcher(lambda req: httpx.Response(200, content=blob)) as fx:
        write_repos(["o/a", "o/b"])
        t1 = await github.fetch_all(fx, data, chunk=2)
        t2 = await github.fetch_all(fx, data, chunk=2)                     # identical: nothing to redo
        write_repos(["o/c", "o/d"])                                        # different repos, same chunk index
        t3 = await github.fetch_all(fx, data, chunk=2)
    assert t1["records"] > 0 and t2 == {} and t3["records"] == t1["records"]


def test_hf_adapters_for_previously_unmatched_schemas():
    # regression: these five datasets (about 190k rows) produced zero records in the first full import
    n = hf.normalize_row
    r = n("k/luau_github", {"file_path": "awesome\\.config\\helpers.lua", "repo_name": "o/dotfiles", "repo_description": "d",
                            "file_content": "local a = 1", "license": "The MIT License (MIT)\n\nCopyright"})
    assert r["kind"] == "code" and r["meta"]["path"] == "awesome/.config/helpers.lua" and r["meta"]["license"] == "The MIT License (MIT)"
    r = n("T/RobloxQA", {"grounding_doc_id": "docs/x.md", "question": "Which property holds code?", "answer": "Source",
                         "incorrect_0": "Code", "incorrect_1": "Text", "incorrect_2": "Content"})
    assert r["kind"] == "instruct" and r["meta"]["completion"] == "Source" and r["meta"]["distractors"] == ["Code", "Text", "Content"]
    r = n("T/Leet", {"problem_description": "Two sum", "starter_code": "local function twoSum()", "solution": "return {}",
                     "test": "-- jest", "difficulty": "Easy", "tags": ["Array"]})
    assert r["kind"] == "instruct" and "local function twoSum()" in r["meta"]["prompt"] and r["meta"]["difficulty"] == "Easy"
    r = n("P/luaucoder", {"system_prompt": ["You are an expert."], "input_1": "make tracer", "reasoning_1": " think ", "output_1": " ```lua\nx\n``` ",
                          "input_2": "thanks", "reasoning_2": "", "output_2": "welcome"})
    assert r["kind"] == "chat" and [m["role"] for m in r["meta"]["messages"]] == ["system", "user", "assistant", "user", "assistant"]
    assert r["meta"]["reasoning"] == ["think", ""]
    assert n("P/luaucoder", {"system_prompt": [], "input_1": "", "output_1": ""}) is None
    r = n("r/min", {"input": "function f(R)local p=1 end", "output": "function f(child)\n\tlocal p = 1\nend"})
    assert r["kind"] == "code" and "\n\tlocal p" in r["text"] and r["meta"]["minified_source_len"] > 0


async def test_probe_cuts_requests_but_not_coverage():
    days = {dt.date(2021, 3, d): 90 for d in range(1, 29)}     # 2520 topics: needs splitting
    uni = make_universe(days)
    calls = {"probe": 0, "naive": 0}

    def run(kind):
        base = search_server(uni)

        def h(req):
            calls[kind] += 1
            return base(req)
        return h

    out_p, out_n, st = {}, {}, {}
    async with fetcher(run("probe")) as fx:
        await devforum.enumerate_window(fx, "scripting-support", dt.date(2021, 3, 1), dt.date(2021, 4, 1), out_p, st)
    async with fetcher(run("naive")) as fx:      # same walk, but never using the probe
        orig = devforum.search_window

        async def no_probe(*a, **kw):
            kw["probe"] = False
            return await orig(*a, **kw)
        devforum.search_window = no_probe
        try:
            await devforum.enumerate_window(fx, "scripting-support", dt.date(2021, 3, 1), dt.date(2021, 4, 1), out_n, {})
        finally:
            devforum.search_window = orig
    assert set(out_p) == set(out_n) == {t["id"] for t in uni}      # identical coverage
    assert calls["probe"] < 0.75 * calls["naive"]                   # materially fewer requests
