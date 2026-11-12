"""Import existing public Luau/Roblox datasets from Hugging Face into the common schema.

Others have already scraped GitHub, the DevForum and the docs; importing them first gives
us volume immediately and lets our own crawls focus on gaps. Adapters are chosen from the
column names (see `normalize_row`), verified against the real schemas of the datasets in
`inventory.json`.
"""
from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Iterator

from ..records import ShardWriter, make_record

log = logging.getLogger("rbxcrawl.hf")

DATA_EXT = (".parquet", ".jsonl", ".json", ".jsonl.gz")
LUA_LANGS = {"lua", "luau"}


def _s(v) -> str:
    return v if isinstance(v, str) else ("" if v is None else str(v))


def _render_chat(msgs: list[dict]) -> tuple[str, list[dict]]:
    norm = []
    for m in msgs:
        role = m.get("role") or m.get("from") or "user"
        role = {"human": "user", "gpt": "assistant", "bot": "assistant"}.get(role, role)
        norm.append({"role": role, "content": _s(m.get("content", m.get("value")))})
    return "\n\n".join(f"### {m['role']}\n{m['content']}" for m in norm), norm


def normalize_row(ds: str, row: dict) -> dict | None:
    """Map a heterogeneous HF row to a record, or None to skip it."""
    src = f"hf:{ds}"
    cols = set(row)

    if {"content", "file_path"} <= cols or {"content", "language", "repo"} <= cols:  # scraped GitHub files
        lang = _s(row.get("language")).lower()
        path = _s(row.get("file_path"))
        if not (lang in LUA_LANGS or path.lower().endswith((".lua", ".luau"))):
            return None
        text = _s(row["content"])
        repo = _s(row.get("repo_path") or row.get("repo"))
        meta = dict(repo=repo, path=path, license=_s(row.get("license_type")) or None,
                    syntax_score=row.get("luau_syntax_score"), api_score=row.get("roblox_api_score"),
                    roblox_repo=str(row.get("from_roblox_flagged_repo")).lower() == "true")
        return make_record(src, "code", f"{repo}:{path}", text, **meta)

    if {"file_content", "file_path"} <= cols:  # kefir090/luau_github-style scrape (license is full text)
        lic = _s(row.get("license")).strip().splitlines()
        repo, path = _s(row.get("repo_name")), _s(row["file_path"]).replace("\\", "/")
        return make_record(src, "code", f"{repo}:{path}", _s(row["file_content"]), repo=repo, path=path,
                           license=(lic[0][:60] if lic else None), description=_s(row.get("repo_description")) or None)

    if {"question", "answer", "incorrect_0"} <= cols:  # RobloxQA: multiple choice grounded in the docs
        q, a = _s(row["question"]), _s(row["answer"])
        wrong = [_s(row[k]) for k in sorted(c for c in cols if c.startswith("incorrect_"))]
        return make_record(src, "instruct", q[:200], f"{q}\n\n{a}", prompt=q, completion=a, distractors=wrong,
                           grounding_doc=_s(row.get("grounding_doc_id")) or None)

    if {"problem_description", "solution"} <= cols:  # LuauLeetcode
        p = _s(row["problem_description"]) + (("\n\n" + _s(row["starter_code"])) if _s(row.get("starter_code")) else "")
        c = _s(row["solution"])
        return make_record(src, "instruct", p[:200] + c[:100], f"{p}\n\n{c}", prompt=p, completion=c,
                           tests=_s(row.get("test")), difficulty=_s(row.get("difficulty")) or None, tags=row.get("tags"))

    if "input_1" in cols and "output_1" in cols:  # Pinkstack luaucoder: multi-turn with separate reasoning columns
        sys_p = row.get("system_prompt")
        sys_p = "\n".join(map(_s, sys_p)) if isinstance(sys_p, list) else _s(sys_p)
        msgs, reasoning = ([{"role": "system", "content": sys_p}] if sys_p.strip() else []), []
        i = 1
        while _s(row.get(f"input_{i}")).strip() and _s(row.get(f"output_{i}")).strip():
            msgs.append({"role": "user", "content": _s(row[f"input_{i}"]).strip()})
            msgs.append({"role": "assistant", "content": _s(row[f"output_{i}"]).strip()})
            reasoning.append(_s(row.get(f"reasoning_{i}")).strip())
            i += 1
        if i == 1:
            return None
        text, norm = _render_chat(msgs)
        return make_record(src, "chat", text[:300], text, messages=norm, reasoning=reasoning)

    if cols == {"input", "output"}:  # renvx0/Luau-Minified: minified input -> readable output; keep the readable side
        out = _s(row["output"])
        return make_record(src, "code", out[:300], out, minified_source_len=len(_s(row["input"])))

    if {"prompt", "completion"} <= cols and len(cols) <= 3:  # Roblox/luau_corpus fragments
        text = _s(row["prompt"]) + _s(row["completion"])
        return make_record(src, "code", text[:200], text, fragment=True)

    if {"code", "prompt", "chain_of_thought"} <= cols:  # Torpedo reasoning
        p, c = _s(row["prompt"]), _s(row["code"])
        return make_record(src, "instruct", p[:200] + c[:100], f"{p}\n\n{c}", prompt=p, completion=c,
                           cot=_s(row.get("chain_of_thought")), explanation=_s(row.get("explanation")))

    if {"instruction", "output"} <= cols:
        p = _s(row["instruction"]) + (("\n" + _s(row["input"])) if _s(row.get("input")) else "")
        c = _s(row["output"])
        return make_record(src, "instruct", p[:200] + c[:100], f"{p}\n\n{c}", prompt=p, completion=c)

    if "conversations" in cols or "messages" in cols:
        msgs = row.get("conversations") or row.get("messages")
        if isinstance(msgs, str):
            try:
                msgs = json.loads(msgs)
            except ValueError:
                return None
        if not msgs:
            return None
        text, norm = _render_chat(msgs)
        return make_record(src, "chat", text[:300], text, messages=norm)

    if {"input", "code"} <= cols:  # Pinkstack "Luaudev2": request + code (+ readme)
        p, c = _s(row["input"]), _s(row["code"])
        return make_record(src, "instruct", p[:200] + c[:100], f"{p}\n\n{c}", prompt=p, completion=c,
                           readme=_s(row.get("readme")))

    if "content" in cols and ("topic_id" in cols or "url" in cols):  # forum / docs text
        return make_record(src, "doc", _s(row.get("source") or row.get("url") or row.get("topic_id")), _s(row["content"]),
                           title=_s(row.get("title")) or None, views=row.get("views"), tags=row.get("tags"))

    for col in ("text", "content", "code"):
        if col in cols and _s(row[col]).strip():
            text = _s(row[col])
            return make_record(src, "doc", text[:200], text)
    return None


def _iter_file(path: str) -> Iterator[dict]:
    if path.endswith(".parquet"):
        import pyarrow.parquet as pq
        pf = pq.ParquetFile(path)
        for batch in pf.iter_batches(batch_size=2048):
            yield from batch.to_pylist()
    else:
        import gzip
        opener = gzip.open if path.endswith(".gz") else open
        with opener(path, "rt", encoding="utf-8") as f:
            if path.endswith(".json"):
                data = json.load(f)
                yield from (data if isinstance(data, list) else [data])
            else:
                for line in f:
                    if line.strip():
                        yield json.loads(line)


def import_dataset(ds: str, out_dir: str | Path, token: str | None = None, max_rows: int | None = None) -> dict:
    from huggingface_hub import HfApi, hf_hub_download

    api = HfApi(token=token)
    files = [f for f in api.list_repo_files(ds, repo_type="dataset") if f.endswith(DATA_EXT)]
    n_in = n_out = 0
    with ShardWriter(out_dir, ds.replace("/", "__"), max_records=50000) as w:
        for fname in sorted(files):
            local = hf_hub_download(ds, fname, repo_type="dataset", token=token)
            for row in _iter_file(local):
                n_in += 1
                rec = normalize_row(ds, row)
                if rec:
                    w.write(rec)
                    n_out += 1
                if max_rows and n_in >= max_rows:
                    break
            if max_rows and n_in >= max_rows:
                break
    log.info("hf %s: %d rows -> %d records", ds, n_in, n_out)
    return {"dataset": ds, "rows": n_in, "records": n_out, "files": len(files)}
