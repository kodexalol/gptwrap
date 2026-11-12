"""Roblox engine API dump -> API-reference records + a machine-readable deprecation list.

The Studio build id comes from setup.rbxcdn.com/versionQTStudio and the dump from
`<version>-Full-API-Dump.json`. Both are public CDN files.

Outputs
  <data>/rbxapi/raw/rbxapi-NNNNN.jsonl.zst   one record per class + per enum (kind="api")
  <data>/rbxapi/deprecated.json              {version, classes, members, services}
The deprecation list feeds filters/labels and the "modernize this code" pair generator.
"""
from __future__ import annotations

import json
from pathlib import Path

from ..http import Fetcher
from ..records import ShardWriter, make_record

CDN = "https://setup.rbxcdn.com"


def _type(t: dict | None) -> str:
    if not t:
        return "any"
    name = t.get("Name", "any")
    return f"Enum.{name}" if t.get("Category") == "Enum" else name


def _tags(x: dict) -> list[str]:
    """Tags are mostly strings but some entries are objects (e.g. {"PreferredDescriptorName": ...})."""
    return [t for t in (x.get("Tags") or []) if isinstance(t, str)]


def _hidden(m: dict) -> bool:
    tags = set(_tags(m))
    sec = m.get("Security")
    secs = {sec} if isinstance(sec, str) else set((sec or {}).values())
    return bool(tags & {"Hidden", "NotScriptable"}) or bool(secs - {"None"})


def build(dump: dict, version: str) -> tuple[list[dict], dict]:
    recs: list[dict] = []
    dep: dict = {"version": version, "classes": [], "members": {}}
    for c in dump.get("Classes", []):
        name, sup = c["Name"], c.get("Superclass") or "<<<ROOT>>>"
        ctags = _tags(c)
        if "Deprecated" in ctags:
            dep["classes"].append(name)
        props, funcs, events, cbs = [], [], [], []
        for m in c.get("Members", []):
            mt, mn, mtags = m.get("MemberType"), m["Name"], _tags(m)
            if "Deprecated" in mtags:
                dep["members"].setdefault(name, []).append(mn)
            if _hidden(m):
                continue
            flag = " [deprecated]" if "Deprecated" in mtags else ""
            if mt == "Property":
                ro = " (read-only)" if "ReadOnly" in mtags else ""
                props.append(f"  {mn}: {_type(m.get('ValueType'))}{ro}{flag}")
            elif mt in ("Function", "Callback", "Event"):
                args = ", ".join(f"{p['Name']}: {_type(p.get('Type'))}" for p in m.get("Parameters", []))
                if mt == "Function":
                    ret = m.get("ReturnType")
                    funcs.append(f"  {mn}({args}) -> {_type(ret)}{flag}")
                elif mt == "Event":
                    events.append(f"  {mn}({args}){flag}")
                else:
                    cbs.append(f"  {mn}({args}){flag}")
        lines = [f"class {name} : {sup}" + (f"  [{', '.join(ctags)}]" if ctags else "")]
        for title, items in (("Properties", props), ("Methods", funcs), ("Events", events), ("Callbacks", cbs)):
            if items:
                lines.append(f"{title}:")
                lines.extend(items)
        recs.append(make_record("rbxapi", "api", f"class/{name}", "\n".join(lines),
                                name=name, superclass=sup, tags=ctags, version=version, roblox_repo=True))
    for e in dump.get("Enums", []):
        items = ", ".join(f"{i['Name']}={i['Value']}" for i in e.get("Items", []))
        recs.append(make_record("rbxapi", "api", f"enum/{e['Name']}", f"enum Enum.{e['Name']}: {items}",
                                name=e["Name"], version=version, roblox_repo=True))
    return recs, dep


async def run(fx: Fetcher, data_dir: str | Path) -> dict:
    root = Path(data_dir) / "rbxapi"
    root.mkdir(parents=True, exist_ok=True)
    v = await fx.get(f"{CDN}/versionQTStudio", as_json=False)
    if not v.ok:
        raise RuntimeError(f"could not read Studio version: HTTP {v.status}")
    version = v.data.decode().strip()
    d = await fx.get(f"{CDN}/{version}-Full-API-Dump.json")
    if not d.ok:
        raise RuntimeError(f"could not download API dump: HTTP {d.status}")
    recs, dep = build(d.data, version)
    with ShardWriter(root / "raw", "rbxapi") as w:
        for r in recs:
            w.write(r)
    (root / "deprecated.json").write_text(json.dumps(dep, indent=1))
    return {"version": version, "records": len(recs), "deprecated_classes": len(dep["classes"]),
            "classes_with_deprecated_members": len(dep["members"])}
