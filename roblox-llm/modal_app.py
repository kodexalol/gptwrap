"""Run the crawlers on Modal CPU containers, persisting everything to one Volume.

    modal run modal_app.py --job smoke                       # ~1 min, a few cents: verifies plumbing
    modal run --detach modal_app.py --job rbxapi
    modal run --detach modal_app.py --job devforum           # discover + fetch, self-resuming (~1 USD of CPU)
    modal run --detach modal_app.py --job hf                 # import the inventoried HF datasets
    GITHUB_TOKEN=... modal run --detach modal_app.py --job github
    modal run --detach modal_app.py --job build              # filter + dedup -> /data/clean
    modal run modal_app.py --job status

Everything is resumable: partition marker files live on the Volume, so re-running a job (or a
container being preempted) only redoes the partition that was in flight.

Why one container per source and not a fleet? The politeness budget is per host, not per
container; a single async worker at a few requests/second is CPU-trivial (~$0.03/hour), and
fanning out across containers would only buy extra source IPs, which is not something we want.
"""
from __future__ import annotations

import asyncio
import json
import os
import time

import modal

APP = "rbx-crawl"
app = modal.App(APP)
vol = modal.Volume.from_name("rbx-crawl", create_if_missing=True)
DATA = "/data"

image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install(
        "httpx>=0.27", "selectolax>=0.3.21", "zstandard>=0.22", "pyarrow>=15",
        "datasketch>=1.6", "huggingface_hub>=0.24", "numpy",
    )
    .add_local_python_source("rbxcrawl")
    .add_local_file("inventory.json", "/app/inventory.json")
)

# Secrets are optional: a missing one must not stop jobs that do not need it.
hf_secret = [modal.Secret.from_name("huggingface-secret")]
if os.environ.get("RBX_GITHUB_SECRET"):  # name of an existing Modal secret holding GITHUB_TOKEN
    gh_secret = [modal.Secret.from_name(os.environ["RBX_GITHUB_SECRET"])]
elif os.environ.get("GITHUB_TOKEN"):     # or pass it from your shell for this run only
    gh_secret = [modal.Secret.from_dict({"GITHUB_TOKEN": os.environ["GITHUB_TOKEN"]})]
else:
    gh_secret = []

COMMON = dict(image=image, volumes={DATA: vol})
RETRY = modal.Retries(max_retries=3, initial_delay=60.0, backoff_coefficient=2.0)


async def _committer(stop: asyncio.Event, every: float = 120.0) -> None:
    """Persist partial progress so a preempted container loses at most a couple of minutes."""
    while not stop.is_set():
        try:
            await asyncio.wait_for(stop.wait(), timeout=every)
        except asyncio.TimeoutError:
            await vol.commit.aio()
    await vol.commit.aio()


# --------------------------------------------------------------------------- DevForum

@app.function(**COMMON, cpu=0.5, memory=1024, timeout=24 * 3600, retries=RETRY)
async def devforum_job(cats: list[str], phase: str = "all", rate: float = 2.5, hours: float = 22.0,
                       start: str | None = None, end: str | None = None, limit: int | None = None) -> dict:
    import datetime as dt
    from rbxcrawl.http import Fetcher
    from rbxcrawl.sources import devforum as D

    await vol.reload.aio()
    deadline = time.time() + hours * 3600
    stop = asyncio.Event()
    commit = asyncio.create_task(_committer(stop))
    out: dict = {}
    try:
        async with Fetcher(rates={"devforum.roblox.com": rate}, default_rate=rate, concurrency=8) as fx:
            # 1) discover EVERY category first, so a deadline respawn never leaves one undiscovered.
            if phase in ("discover", "all"):
                s = dt.date.fromisoformat(start) if start else D.FIRST_DAY
                e = dt.date.fromisoformat(end) if end else None
                for cat in cats:
                    out[f"{cat}/discover"] = await D.discover(fx, cat, DATA, s, e)
            # 2) fetch the small, high-value categories (code review, tutorials) before the 230k-topic one.
            if phase in ("fetch", "all"):
                frontier = {c: D.value_order(D.load_frontier(DATA, c)) for c in cats}
                for cat in sorted(cats, key=lambda c: len(frontier[c])):
                    topics = frontier[cat][:limit] if limit else frontier[cat]
                    for i in range(0, len(topics), D.CHUNK):
                        if time.time() > deadline:
                            out["deadline"] = True
                            break
                        res = await D.fetch_partition(fx, topics[i:i + D.CHUNK], cat, DATA, f"{i // D.CHUNK:05d}")
                        for k, v in res.items():
                            if isinstance(v, int):
                                out[f"{cat}/{k}"] = out.get(f"{cat}/{k}", 0) + v
                    if out.get("deadline"):
                        break
            out["http"] = dict(fx.stats)
    finally:
        stop.set()
        await commit
    if out.get("deadline"):  # time budget ran out before the work did: continue in a fresh container
        devforum_job.spawn(cats, "fetch", rate, hours, None, None, limit)
        out["respawned"] = True
    return out


# --------------------------------------------------------------------------- others

@app.function(**COMMON, cpu=0.25, memory=512, timeout=1800)
async def rbxapi_job() -> dict:
    from rbxcrawl.http import Fetcher
    from rbxcrawl.sources import rbxapi
    async with Fetcher(default_rate=2.0) as fx:
        out = await rbxapi.run(fx, DATA)
    await vol.commit.aio()
    return out


@app.function(**COMMON, secrets=gh_secret, cpu=0.5, memory=2048, timeout=24 * 3600, retries=RETRY)
async def github_job(phase: str = "all", rate: float = 2.0, hours: float = 22.0, limit: int | None = None,
                     queries: list[str] | None = None) -> dict:
    from rbxcrawl.http import Fetcher
    from rbxcrawl.sources import github as G
    token = os.environ.get("GITHUB_TOKEN")
    if phase in ("discover", "all") and not token:
        raise RuntimeError("GITHUB_TOKEN missing: run with GITHUB_TOKEN=... or RBX_GITHUB_SECRET=<modal secret name>")
    await vol.reload.aio()
    stop = asyncio.Event()
    commit = asyncio.create_task(_committer(stop))
    out: dict = {}
    try:
        rates = {"api.github.com": 0.45, "codeload.github.com": rate}
        async with Fetcher(rates=rates, default_rate=rate, concurrency=8) as fx:
            if phase in ("discover", "all"):
                out["discover"] = await asyncio.wait_for(G.discover(fx, token, DATA, queries), hours * 3600)
            if phase in ("fetch", "all"):
                out["fetch"] = await G.fetch_all(fx, DATA, limit=limit)
            out["http"] = dict(fx.stats)
    finally:
        stop.set()
        await commit
    return out


@app.function(**COMMON, secrets=hf_secret, cpu=2, memory=8192, timeout=6 * 3600, retries=RETRY)
def hf_job(datasets: list[str] | None = None, max_rows: int | None = None) -> list[dict]:
    from rbxcrawl.sources import hf
    token = next((os.environ[k] for k in ("HF_TOKEN", "HUGGINGFACE_TOKEN", "HUGGING_FACE_HUB_TOKEN") if os.environ.get(k)), None)
    ids = datasets or [r["id"] for r in json.load(open("/app/inventory.json")) if r.get("rows") and not r.get("gated")]
    results = []
    for ds in ids:
        try:
            results.append(hf.import_dataset(ds, f"{DATA}/hf/raw", token, max_rows))
        except Exception as e:  # one gated/broken dataset must not stop the rest
            results.append({"dataset": ds, "error": str(e)[:200]})
        vol.commit()
    return results


@app.function(**COMMON, cpu=8, memory=16384, timeout=12 * 3600)
def build_job(min_quality: float = 0.0, max_deprecated_per_kb: float = 1e9, near: bool = True) -> dict:
    from pathlib import Path
    from rbxcrawl import filters, pipeline
    vol.reload()
    root = Path(DATA)
    # Priority order: first copy wins in dedup, so our own crawls come before bulk imports.
    inputs = [p for p in (root / "devforum" / "raw", root / "github" / "raw", root / "rbxapi" / "raw", root / "hf" / "raw") if p.exists()]
    cfg = filters.Config(min_quality=min_quality, max_deprecated_per_kb=max_deprecated_per_kb)
    rep_f = pipeline.run_filter(inputs, root / "filtered", cfg, workers=8)
    rep_d = pipeline.run_dedup([root / "filtered"], root / "clean", near=near)
    pipeline.dump_report({"filter": rep_f, "dedup": rep_d}, root / "clean" / "report.json")
    vol.commit()
    return {"filter": {k: rep_f[k] for k in ("seen", "kept", "reasons")}, "dedup": rep_d}


@app.function(**COMMON, cpu=1, memory=2048, timeout=3600)
def status_job() -> dict:
    from pathlib import Path
    from rbxcrawl import pipeline
    vol.reload()
    root = Path(DATA)
    out: dict = {}
    for src in ("devforum", "github", "rbxapi", "hf"):
        raw = root / src / "raw"
        if raw.exists():
            out[src] = {"shards": len(list(raw.glob("*.jsonl.zst"))), **{k: v for k, v in pipeline.summarize(raw).items()
                                                                       if k in ("records", "est_tokens")}}
    mdir = root / "devforum" / "markers"
    if mdir.exists():
        out["devforum_markers"] = {d.name: len(list(d.glob("*.done"))) for d in mdir.iterdir() if d.is_dir()}
    if (root / "clean").exists():
        out["clean"] = {k: v for k, v in pipeline.summarize(root / "clean").items() if k != "tokens_by_source"}
    return out


@app.function(image=image, cpu=0.5, memory=1024, timeout=900)
async def github_smoke_job() -> dict:
    """Live check of search + tarball extraction WITHOUT a token (unauthenticated: 10 searches/min)."""
    import datetime as dt
    import tempfile
    from rbxcrawl.http import Fetcher
    from rbxcrawl.sources import github as G
    out: dict = {}
    utc = dt.timezone.utc
    async with Fetcher(rates={"api.github.com": 0.1, "codeload.github.com": 1.0}, default_rate=1.0) as fx:
        repos: dict = {}
        stats: dict = {}
        await G.bisect_search(fx, None, "language:Luau", dt.datetime(2024, 6, 1, tzinfo=utc),
                              dt.datetime(2024, 6, 30, 23, 59, 59, tzinfo=utc), repos, stats)
        out["search"] = {"repos": len(repos), **stats}
        picks = sorted((r for r in repos.values() if not r["fork"] and 0 < r["size_kb"] < 3000),
                       key=lambda r: -r["stars"])[:2]
        for r in picks:
            recs, why = await G.fetch_repo(fx, r, 3000)
            out[r["full_name"]] = {"why": why, "stars": r["stars"], "license": r["license"],
                                   "code_files": sum(x["kind"] == "code" for x in recs),
                                   "roblox_repo": bool(recs and recs[0]["meta"]["roblox_repo"]),
                                   "sample_paths": [x["meta"].get("path") for x in recs if x["kind"] == "code"][:3]}
        out["http"] = dict(fx.stats)
    return out


@app.function(**COMMON, cpu=0.5, memory=1024, timeout=1800)
async def smoke_job() -> dict:
    """Tiny end-to-end check of image, network, volume and resume (a few cents)."""
    import datetime as dt
    from rbxcrawl.http import Fetcher
    from rbxcrawl.records import iter_records
    from rbxcrawl.sources import devforum as D, rbxapi
    out: dict = {}
    async with Fetcher(rates={"devforum.roblox.com": 2.5}, default_rate=2.0) as fx:
        out["rbxapi"] = await rbxapi.run(fx, DATA)
        out["discover"] = await D.discover(fx, "scripting-support", DATA, dt.date(2021, 3, 9), dt.date(2021, 3, 10))
        out["fetch"] = await D.fetch_all(fx, "scripting-support", DATA, chunk=20, limit=20)
        out["http"] = dict(fx.stats)
    out["records_on_volume"] = sum(1 for _ in iter_records(f"{DATA}/devforum/raw"))
    await vol.commit.aio()
    return out


@app.local_entrypoint()
def main(job: str = "smoke", cats: str = "", rate: float = 2.5, hours: float = 22.0, limit: int = 0,
         datasets: str = "", max_rows: int = 0, min_quality: float = 0.0, exact_only: bool = False,
         start: str = "", end: str = "", wait: bool = False):
    from rbxcrawl.sources import devforum as D
    cat_list = cats.split(",") if cats else list(D.CATEGORIES)
    if job == "smoke":
        print(json.dumps(smoke_job.remote(), indent=1))
    elif job == "rbxapi":
        print(rbxapi_job.remote())
    elif job == "devforum":
        args = (cat_list, "all", rate, hours, start or None, end or None, limit or None)
        if wait:
            print(devforum_job.remote(*args))
        else:  # run with `modal run --detach`: the call keeps running after this client exits
            print("spawned devforum_job:", devforum_job.spawn(*args).object_id)
    elif job == "github-smoke":
        print(json.dumps(github_smoke_job.remote(), indent=1))
    elif job == "github":
        print(json.dumps(github_job.remote("all", 2.0, hours, limit or None), indent=1))
    elif job == "hf":
        args = (datasets.split(",") if datasets else None, max_rows or None)
        if wait:
            print(json.dumps(hf_job.remote(*args), indent=1))
        else:
            print("spawned hf_job:", hf_job.spawn(*args).object_id)
    elif job == "build":
        print(json.dumps(build_job.remote(min_quality, 1e9, not exact_only), indent=1))
    elif job == "status":
        print(json.dumps(status_job.remote(), indent=1))
    else:
        raise SystemExit(f"unknown job {job!r}")
