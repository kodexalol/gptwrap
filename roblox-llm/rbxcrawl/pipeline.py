"""filter (parallel per shard) -> dedup (sequential, priority-ordered) -> clean shards + report."""
from __future__ import annotations

import collections
import json
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

from . import filters
from .dedup import Deduper
from .records import ShardWriter, est_tokens, iter_records, list_shards, read_shard


def _filter_shard(args: tuple) -> dict:
    shard, out_dir, cfg_dict = args
    cfg = filters.Config(**cfg_dict)
    stats = {"seen": 0, "kept": 0, "reasons": collections.Counter(), "by_source": collections.Counter()}
    name = Path(shard).name.replace(".jsonl.zst", "")
    with ShardWriter(out_dir, name, max_records=10**9) as w:
        for rec in read_shard(shard):
            stats["seen"] += 1
            out, why = filters.process(rec, cfg)
            if out is None:
                stats["reasons"][why] += 1
                continue
            stats["kept"] += 1
            stats["by_source"][rec["source"].split(":")[0]] += 1
            w.write(out)
    stats["reasons"] = dict(stats["reasons"])
    stats["by_source"] = dict(stats["by_source"])
    return stats


def run_filter(inputs: list[str | Path], out_dir: str | Path, cfg: filters.Config | None = None,
               workers: int = 4) -> dict:
    cfg = cfg or filters.Config()
    shards = [s for i in inputs for s in list_shards(i)]
    jobs = [(str(s), str(out_dir), cfg.__dict__) for s in shards]
    total = {"seen": 0, "kept": 0, "reasons": collections.Counter(), "by_source": collections.Counter()}
    if workers > 1 and len(jobs) > 1:
        with ProcessPoolExecutor(workers) as ex:
            results = list(ex.map(_filter_shard, jobs))
    else:
        results = [_filter_shard(j) for j in jobs]
    for r in results:
        total["seen"] += r["seen"]
        total["kept"] += r["kept"]
        total["reasons"].update(r["reasons"])
        total["by_source"].update(r["by_source"])
    total["reasons"] = dict(total["reasons"])
    total["by_source"] = dict(total["by_source"])
    return total


def run_dedup(inputs: list[str | Path], out_dir: str | Path, near: bool = True, threshold: float = 0.85,
              num_perm: int = 64, max_records: int = 50000) -> dict:
    dd = Deduper(threshold=threshold, num_perm=num_perm, near=near)
    stats = {"seen": 0, "kept": 0, "reasons": collections.Counter(), "tokens": 0,
             "by_source": collections.Counter(), "by_kind": collections.Counter()}
    with ShardWriter(out_dir, "clean", max_records=max_records) as w:
        for inp in inputs:
            for rec in iter_records(inp):
                stats["seen"] += 1
                why = dd.check(rec)
                if why:
                    stats["reasons"][why] += 1
                    continue
                w.write(rec)
                stats["kept"] += 1
                stats["tokens"] += est_tokens(rec["text"])
                stats["by_source"][rec["source"].split(":")[0]] += 1
                stats["by_kind"][rec["kind"]] += 1
    for k in ("reasons", "by_source", "by_kind"):
        stats[k] = dict(stats[k])
    return stats


def summarize(path: str | Path) -> dict:
    s = {"records": 0, "chars": 0, "est_tokens": 0, "by_source": collections.Counter(),
         "by_kind": collections.Counter(), "tokens_by_source": collections.Counter()}
    for rec in iter_records(path):
        s["records"] += 1
        s["chars"] += rec["n_chars"]
        t = est_tokens(rec["text"])
        s["est_tokens"] += t
        src = rec["source"] if rec["source"].startswith("hf:") else rec["source"].split(":")[0]
        s["by_source"][src] += 1
        s["by_kind"][rec["kind"]] += 1
        s["tokens_by_source"][src] += t
    for k in ("by_source", "by_kind", "tokens_by_source"):
        s[k] = dict(sorted(s[k].items(), key=lambda kv: -kv[1]))
    return s


def dump_report(obj: dict, path: str | Path) -> None:
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(obj, indent=1))
