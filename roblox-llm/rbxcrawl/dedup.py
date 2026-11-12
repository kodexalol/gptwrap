"""Exact + near-duplicate removal (streaming, first-seen wins).

Process inputs in priority order: the first copy of a document is the one kept, so list
higher-trust sources (your own crawls, with license/star metadata) before bulk imports.

Exact: sha1 of a normalised form (code: comments and all whitespace removed).
Near : MinHash-LSH over 5-token shingles (datasketch). Memory is roughly 1 KB per kept
       document at num_perm=64, so a few million documents fit in a 16 GB container.
"""
from __future__ import annotations

import re

from .records import sha1

_BLOCK_COMMENT = re.compile(r"--\[(=*)\[.*?\]\1\]", re.S)
_LINE_COMMENT = re.compile(r"--[^\n]*")
_WS = re.compile(r"\s+")
_TOKEN = re.compile(r"\w+|[^\w\s]")


def normalize(text: str, kind: str) -> str:
    if kind == "code":
        text = _BLOCK_COMMENT.sub("", text)
        text = _LINE_COMMENT.sub("", text)
        return _WS.sub("", text)
    return _WS.sub(" ", text).strip().lower()


class Deduper:
    def __init__(self, threshold: float = 0.85, num_perm: int = 64, min_chars_near: int = 300,
                 max_tokens: int = 20000, near: bool = True):
        self.exact: set[str] = set()
        self.near = near
        self.min_chars_near = min_chars_near
        self.max_tokens = max_tokens
        self.num_perm = num_perm
        if near:
            from datasketch import MinHashLSH
            self.lsh = MinHashLSH(threshold=threshold, num_perm=num_perm)

    def _minhash(self, norm: str):
        from datasketch import MinHash
        toks = _TOKEN.findall(norm)[: self.max_tokens]
        m = MinHash(num_perm=self.num_perm)
        if len(toks) < 5:
            m.update(" ".join(toks).encode())
            return m
        m.update_batch([" ".join(toks[i:i + 5]).encode() for i in range(len(toks) - 4)])
        return m

    def check(self, rec: dict) -> str | None:
        """Returns a drop reason, or None if the record is new (and registers it)."""
        norm = normalize(rec["text"], rec["kind"])
        h = sha1(norm)
        if h in self.exact:
            return "exact_dup"
        self.exact.add(h)
        if self.near and rec["n_chars"] >= self.min_chars_near:
            m = self._minhash(normalize(rec["text"], "text") if rec["kind"] != "code" else rec["text"])
            if self.lsh.query(m):
                return "near_dup"
            self.lsh.insert(rec["id"], m, check_duplication=False)
        return None
