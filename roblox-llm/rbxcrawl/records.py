"""Uniform record schema, sharded zstd-JSONL IO, and partition markers.

Every source emits dicts with the same top-level keys so that filtering, dedup
and training-set assembly never need to know where a record came from:

    id       stable 20-hex id (sha1 of "source:key")
    source   e.g. "devforum", "github", "rbxapi", "hf:Roblox/luau_corpus"
    kind     "code" | "qa" | "doc" | "api" | "instruct" | "chat" | "text"
    key      source-local unique key (URL, repo:path, topic id, ...)
    text     the main text payload (markdown / code)
    n_chars  len(text)
    meta     source-specific dict (stars, license, tags, thread, images, ...)
"""
from __future__ import annotations

import hashlib
import io
import json
import os
from pathlib import Path
from typing import Iterable, Iterator

import zstandard as zstd


def sha1(s: str) -> str:
    return hashlib.sha1(s.encode("utf-8", "ignore")).hexdigest()


def est_tokens(text: str) -> int:
    """Rough token estimate for code/markdown (~3.5 chars per token)."""
    return int(len(text) / 3.5)


def make_record(source: str, kind: str, key: str, text: str, **meta) -> dict:
    return {
        "id": sha1(f"{source}:{key}")[:20],
        "source": source,
        "kind": kind,
        "key": key,
        "text": text,
        "n_chars": len(text),
        "meta": meta,
    }


class ShardWriter:
    """Writes records to rotating `<prefix>-NNNNN.jsonl.zst` files.

    Shards are written to `*.tmp` and atomically renamed on rotation/close, so an
    interrupted run never leaves a half-written shard that looks complete.
    """

    def __init__(self, out_dir: str | Path, prefix: str, max_records: int = 20000, level: int = 6):
        self.dir = Path(out_dir)
        self.dir.mkdir(parents=True, exist_ok=True)
        self.prefix, self.max_records, self.level = prefix, max_records, level
        self.idx = 0
        self.in_shard = 0
        self.total = 0
        self.paths: list[Path] = []
        self._fh = None
        self._w = None
        self._tmp: Path | None = None
        self._final: Path | None = None

    def _open(self) -> None:
        self._final = self.dir / f"{self.prefix}-{self.idx:05d}.jsonl.zst"
        self._tmp = self._final.with_name(self._final.name + ".tmp")
        self._fh = open(self._tmp, "wb")
        self._w = zstd.ZstdCompressor(level=self.level).stream_writer(self._fh)

    def write(self, rec: dict) -> None:
        if self._w is None:
            self._open()
        self._w.write((json.dumps(rec, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8"))
        self.in_shard += 1
        self.total += 1
        if self.in_shard >= self.max_records:
            self._rotate()

    def _rotate(self) -> None:
        if self._w is None:
            return
        self._w.close()
        try:
            self._fh.close()
        except Exception:
            pass
        os.replace(self._tmp, self._final)
        self.paths.append(self._final)
        self._w = self._fh = None
        self.idx += 1
        self.in_shard = 0

    def close(self) -> list[Path]:
        self._rotate()
        return self.paths

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


def read_shard(path: str | Path) -> Iterator[dict]:
    with open(path, "rb") as fh:
        reader = zstd.ZstdDecompressor().stream_reader(fh)
        for line in io.TextIOWrapper(reader, encoding="utf-8"):
            line = line.strip()
            if line:
                yield json.loads(line)


def list_shards(path: str | Path) -> list[Path]:
    p = Path(path)
    if p.is_file():
        return [p]
    return sorted(p.rglob("*.jsonl.zst"))


def iter_records(path: str | Path) -> Iterator[dict]:
    for shard in list_shards(path):
        yield from read_shard(shard)


def write_records(out_dir: str | Path, prefix: str, records: Iterable[dict], **kw) -> list[Path]:
    with ShardWriter(out_dir, prefix, **kw) as w:
        for r in records:
            w.write(r)
    return w.paths


# ---- partition markers: the unit of resumability ---------------------------------

def done_marker(marker_dir: str | Path, name: str) -> Path:
    return Path(marker_dir) / f"{name}.done"


def is_done(marker_dir: str | Path, name: str) -> bool:
    return done_marker(marker_dir, name).exists()


def mark_done(marker_dir: str | Path, name: str, **info) -> None:
    p = done_marker(marker_dir, name)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".done.tmp")
    tmp.write_text(json.dumps(info))
    os.replace(tmp, p)
