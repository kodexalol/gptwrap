"""Command line entry point: `python -m rbxcrawl <command> ...`"""
from __future__ import annotations

import argparse
import asyncio
import datetime as dt
import json
import logging
import os
import sys

from . import filters, pipeline
from .http import Fetcher
from .sources import creatorhub, devforum, github, hf, rbxapi

DEVFORUM_HOST = "devforum.roblox.com"


def _fetcher(args, **rates) -> Fetcher:
    return Fetcher(rates=rates, default_rate=args.rate, concurrency=args.concurrency)


async def cmd_devforum(args) -> None:
    cats = devforum.resolve_cats(args.cats)
    async with _fetcher(args, **{DEVFORUM_HOST: args.rate}) as fx:
        for cat in cats:
            if args.phase in ("discover", "all"):
                start = dt.date.fromisoformat(args.start) if args.start else devforum.FIRST_DAY
                end = dt.date.fromisoformat(args.end) if args.end else None
                print(cat, "discover", await devforum.discover(fx, cat, args.data, start, end, args.parallel))
            if args.phase in ("fetch", "all"):
                print(cat, "fetch", await devforum.fetch_all(fx, cat, args.data, args.chunk, limit=args.limit))
        print("http stats:", dict(fx.stats))


async def cmd_github(args) -> None:
    token = os.environ.get("GITHUB_TOKEN")
    rates = {"api.github.com": 0.45, "codeload.github.com": args.rate}
    async with Fetcher(rates=rates, default_rate=args.rate, concurrency=args.concurrency) as fx:
        if args.phase in ("discover", "all"):
            if not token:
                sys.exit("GITHUB_TOKEN is required for discovery (public-read token, no scopes).")
            qs = args.queries.split(";") if args.queries else None
            print("discover", await github.discover(fx, token, args.data, qs))
        if args.phase in ("fetch", "all"):
            print("fetch", await github.fetch_all(fx, args.data, args.chunk, args.concurrency,
                                                 min_stars=args.min_stars, limit=args.limit))
        print("http stats:", dict(fx.stats))


async def cmd_creatorhub(args) -> None:
    async with Fetcher(rates={"create.roblox.com": args.rate}, default_rate=args.rate, concurrency=args.concurrency) as fx:
        print(await creatorhub.run(fx, args.data, limit=args.limit))
        print("http stats:", dict(fx.stats))


async def cmd_rbxapi(args) -> None:
    async with _fetcher(args) as fx:
        print(await rbxapi.run(fx, args.data))


def cmd_hf(args) -> None:
    token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_TOKEN")
    if args.datasets:
        ids = args.datasets.split(",")
    else:
        inv = json.load(open(args.inventory))
        ids = [r["id"] for r in inv if r.get("rows") and not r.get("gated")]
    out = os.path.join(args.data, "hf", "raw")
    for ds in ids:
        try:
            print(hf.import_dataset(ds, out, token, args.max_rows))
        except Exception as e:  # keep going: one gated/broken dataset must not stop the rest
            print({"dataset": ds, "error": str(e)[:200]})


def cmd_filter(args) -> None:
    cfg = filters.Config(max_deprecated_per_kb=args.max_deprecated_per_kb, min_quality=args.min_quality,
                         drop_secrets=args.drop_secrets)
    rep = pipeline.run_filter(args.inputs, args.out, cfg, workers=args.workers)
    pipeline.dump_report(rep, os.path.join(args.out, "filter_report.json"))
    print(json.dumps(rep, indent=1))


def cmd_dedup(args) -> None:
    rep = pipeline.run_dedup(args.inputs, args.out, near=not args.exact_only, threshold=args.threshold)
    pipeline.dump_report(rep, os.path.join(args.out, "dedup_report.json"))
    print(json.dumps(rep, indent=1))


def cmd_stats(args) -> None:
    print(json.dumps(pipeline.summarize(args.path), indent=1))


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(prog="rbxcrawl")
    p.add_argument("-v", "--verbose", action="store_true")
    sub = p.add_subparsers(dest="cmd", required=True)

    def net(sp, rate):
        sp.add_argument("--data", default="data")
        sp.add_argument("--rate", type=float, default=rate, help="max requests/sec/host (ceiling)")
        sp.add_argument("--concurrency", type=int, default=8)

    d = sub.add_parser("devforum"); net(d, 2.5)
    d.add_argument("phase", choices=["discover", "fetch", "all"])
    d.add_argument("--cats", help=f"'tier2', 'all', or comma list of {list(devforum.CATEGORIES)} (default: tier 1)")
    d.add_argument("--start"); d.add_argument("--end")
    d.add_argument("--parallel", type=int, default=3); d.add_argument("--chunk", type=int, default=500)
    d.add_argument("--limit", type=int)

    g = sub.add_parser("github"); net(g, 2.0)
    g.add_argument("phase", choices=["discover", "fetch", "all"])
    g.add_argument("--queries", help="';'-separated search queries (default: built-in list)")
    g.add_argument("--chunk", type=int, default=100); g.add_argument("--min-stars", type=int, default=0)
    g.add_argument("--limit", type=int)

    a = sub.add_parser("rbxapi"); net(a, 2.0)

    c = sub.add_parser("creatorhub"); net(c, 1.5)
    c.add_argument("--limit", type=int)

    h = sub.add_parser("hf")
    h.add_argument("--data", default="data"); h.add_argument("--datasets"); h.add_argument("--inventory", default="inventory.json")
    h.add_argument("--max-rows", type=int)

    f = sub.add_parser("filter")
    f.add_argument("inputs", nargs="+"); f.add_argument("--out", required=True); f.add_argument("--workers", type=int, default=4)
    f.add_argument("--max-deprecated-per-kb", type=float, default=1e9); f.add_argument("--min-quality", type=float, default=0.0)
    f.add_argument("--drop-secrets", action="store_true")

    u = sub.add_parser("dedup")
    u.add_argument("inputs", nargs="+", help="in priority order: first copy wins")
    u.add_argument("--out", required=True); u.add_argument("--threshold", type=float, default=0.85)
    u.add_argument("--exact-only", action="store_true")

    s = sub.add_parser("stats"); s.add_argument("path")

    args = p.parse_args(argv)
    logging.basicConfig(level=logging.INFO if args.verbose else logging.WARNING,
                        format="%(asctime)s %(name)s %(message)s")
    if args.cmd == "devforum":
        asyncio.run(cmd_devforum(args))
    elif args.cmd == "github":
        asyncio.run(cmd_github(args))
    elif args.cmd == "rbxapi":
        asyncio.run(cmd_rbxapi(args))
    elif args.cmd == "creatorhub":
        asyncio.run(cmd_creatorhub(args))
    else:
        {"hf": cmd_hf, "filter": cmd_filter, "dedup": cmd_dedup, "stats": cmd_stats}[args.cmd](args)


if __name__ == "__main__":
    main()
