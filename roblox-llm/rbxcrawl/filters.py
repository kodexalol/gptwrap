"""Safety, quality and Roblox-relevance analysis for scraped records.

`analyze(rec)` never mutates; it returns a flags dict. `decide(rec, flags, cfg)` turns
flags into keep/drop with a reason, so every drop is explainable and countable.

Two kinds of signal are kept deliberately separate:
  * hard drops: exploit/executor scripts, backdoors, obfuscated blobs, non-Roblox Lua
  * soft labels: deprecated-API hits, modern-Luau markers, quality score. These are kept
    on the record so training can down-weight old style OR turn deprecated code into
    automatic "modernize this" pairs.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

# --------------------------------------------------------------------------- safety

# Executor-only APIs: code using these is exploit tooling, not game development.
EXPLOIT_STRONG = re.compile(
    r"\b(getgenv|getrenv|getreg|getgc|hookfunction|hookmetamethod|newcclosure|checkcaller|"
    r"setclipboard|firetouchinterest|fireclickdetector|fireproximityprompt|firesignal|"
    r"getconnections|identifyexecutor|getexecutorname|saveinstance|setthreadidentity|"
    r"set_thread_identity|setidentity|gethui|get_hidden_gui|getnilinstances|getscripts|"
    r"getloadedmodules|getcallingscript|setreadonly|make_writeable|isrbxactive|"
    r"mouse1click|mouse1press|keypress|keyrelease)\b|"
    r"\bsyn\s*\.\s*(request|protect_gui|queue_on_teleport|crypt)|"
    r"\bDrawing\s*\.\s*new\b|"
    r"\b(fluxus|krnl|synapse\s*x|script-?ware|electron\s+executor|delta\s+executor)\b",
    re.I,
)
# Remote-code loaders and asset-id requires are the signature of free-model backdoors.
BACKDOOR_REQUIRE_ID = re.compile(r"\brequire\s*\(\s*\d{6,}\s*\)")
LOADSTRING_REMOTE = re.compile(
    r"loadstring\s*\(\s*(game\s*:\s*)?(HttpGet|HttpService\s*:\s*GetAsync|[^)]{0,80}(HttpGet|GetAsync))", re.I
)
LOADSTRING_ANY = re.compile(r"\bloadstring\s*\(")
INSERT_ASSET = re.compile(r"InsertService\s*:\s*LoadAsset\s*\(\s*\d{6,}")
ESCAPE_BLOB = re.compile(r"(\\\d{1,3}){24,}")  # string.char-style byte escapes

SECRET_PATTERNS = {
    "discord_webhook": re.compile(r"https?://(?:ptb\.|canary\.)?discord(?:app)?\.com/api/webhooks/\d+/[\w-]+"),
    "roblosecurity": re.compile(r"_\|WARNING:-DO-NOT-SHARE-THIS[^\s\"']{20,}|\.ROBLOSECURITY\s*[=:]\s*[\"']?[A-F0-9]{40,}", re.I),
    "aws_key": re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    "github_token": re.compile(r"\bgh[pousr]_[A-Za-z0-9]{36,}\b"),
    "slack_token": re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}"),
    "google_key": re.compile(r"\bAIza[0-9A-Za-z\-_]{35}\b"),
    "private_key": re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----"),
    "openai_like": re.compile(r"\bsk-[A-Za-z0-9]{32,}\b"),
}
EMAIL = re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")
IPV4 = re.compile(r"\b(?!(?:10|127|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.)(?:\d{1,3}\.){3}\d{1,3}\b")

# --------------------------------------------------------------------------- relevance

ROBLOX_MARKERS = [
    r"game\s*:\s*GetService", r"\bInstance\.new\b", r"\bscript\.Parent\b", r"\bworkspace\b",
    r"\btask\.(wait|spawn|defer|delay)\b", r"\bVector3\.new\b", r"\bCFrame\.", r"\bUDim2\.",
    r"\bHumanoid\b", r"\bRemote(Event|Function)\b", r"\bReplicatedStorage\b", r"\bTweenService\b",
    r"\bPlayers\.LocalPlayer\b", r"\bRunService\b", r"\bDataStoreService\b", r"\bColor3\.",
    r"^--!(strict|nonstrict|nocheck)", r"\bEnum\.\w+", r"\bBrickColor\b", r"\bUserInputService\b",
    r"\bStarterGui\b", r"\bRaycastParams\b", r"\bTextLabel\b", r"\bRoact\b|\bReact\.createElement\b|\bFusion\b",
]
ROBLOX_RE = [re.compile(p, re.M) for p in ROBLOX_MARKERS]

# Plain-Lua ecosystems that share the language but are not Roblox.
NON_ROBLOX_MARKERS = [
    r"\blove\.(graphics|audio|keyboard|load|update|draw)\b", r"\bvim\.(api|fn|cmd|keymap|opt|g)\b",
    r"\bngx\.\w+", r"\bredis\.call\b", r"\bminetest\.\w+", r"\bturtle\.\w+", r"\bgmod\b|\bGM:|\bhook\.Add\s*\(",
    r"\bCitizen\.Create", r"\bCreateFrame\s*\(|\bC_Timer\b", r"\bgo\.(property|animate)\b",
    r"\bwezterm\b", r"\bAddCommand\(|\bRegisterEvent\(", r"\bcc\.\w+\b", r"\bpico8\b|\btic80\b",
    r"\bfunction\s+_(init|update|draw)\s*\(\)", r"#!/usr/bin/(env )?lua", r"\bos\.execute\b",
    r"\bio\.popen\b", r"\brequire\s*\(?\s*[\"'][\w.]+[\"']\s*\)?\s*\n.*\bpackage\.path\b",
]
NON_ROBLOX_RE = [re.compile(p) for p in NON_ROBLOX_MARKERS]

# --------------------------------------------------------------------------- deprecated

DEPRECATED: dict[str, re.Pattern] = {
    "wait": re.compile(r"(?<![\w.:])wait\s*\("),
    "spawn": re.compile(r"(?<![\w.:])spawn\s*\("),
    "delay": re.compile(r"(?<![\w.:])delay\s*\("),
    "tick": re.compile(r"(?<![\w.:])tick\s*\("),
    "body_movers": re.compile(r"\bBody(Velocity|Position|Gyro|Force|AngularVelocity|Thrust|ForceNew)\b"),
    "lowercase_methods": re.compile(r":(connect|disconnect|wait|getChildren|children|isA|findFirstChild|clone|destroy|remove|isDescendantOf)\s*\("),
    "find_part_on_ray": re.compile(r":FindPartOnRay(WithIgnoreList|WithWhitelist)?\s*\("),
    "instance_new_parent_arg": re.compile(r"Instance\.new\(\s*[\"']\w+[\"']\s*,\s*[^)\s]"),
    "filtering_enabled": re.compile(r"\bFilteringEnabled\b"),
    "set_primary_part_cframe": re.compile(r":SetPrimaryPartCFrame\s*\("),
    "math_pow": re.compile(r"\bmath\.(pow|mod|log10|ldexp|frexp)\b|\bstring\.gfind\b|\btable\.(getn|foreach|foreachi)\b"),
    "getfenv_setfenv": re.compile(r"\b(getfenv|setfenv)\s*\("),
    "humanoid_load_animation": re.compile(r"\bHumanoid\b[^\n]{0,60}:LoadAnimation\s*\("),
    "game_workspace": re.compile(r"\bgame\.Workspace\b"),
    "old_player_chat": re.compile(r"\.Chatted:(connect|Connect)\b|\bPlayer\.Chatted\b"),
    "mouse_object": re.compile(r"\bPlayer:GetMouse\s*\(|\bMouse\.(Hit|Target|KeyDown)\b"),
}
MODERN_MARKERS = {
    "task_lib": re.compile(r"\btask\.(wait|spawn|defer|delay|cancel)\b"),
    "strict": re.compile(r"^--!strict", re.M),
    # Luau annotations are written `name: Type` / `): Type` with a space; requiring it avoids
    # matching method calls like `(game):GetService` or `print(p:GetFullName())`.
    "type_annotations": re.compile(
        r"(\blocal\s+\w+\s*:\s+[A-Za-z_{(<]|[(,]\s*\w+\s*:\s+[A-Za-z_{(<?]|\)\s*:\s+[A-Za-z_{(<]"
        r"|^type\s+\w+\s*=|^export\s+type\b)", re.M),
    "pivot": re.compile(r":(PivotTo|GetPivot)\s*\("),
    "raycast": re.compile(r":Raycast\s*\("),
    "attributes": re.compile(r":(Get|Set)Attribute\s*\("),
    "constraints": re.compile(r"\b(LinearVelocity|AlignPosition|AlignOrientation|VectorForce|LinearForce)\b"),
    "continue_kw": re.compile(r"^\s*continue\s*$", re.M),
    "compound_assign": re.compile(r"[+\-*/]=\s"),
}

# --------------------------------------------------------------------------- analysis


@dataclass
class Config:
    min_chars: int = 40
    max_chars: int = 200_000
    max_line_len: int = 1000
    max_avg_line_len: int = 180
    min_roblox_markers: int = 1          # code records from generic Lua sources
    drop_exploit: bool = True
    drop_backdoor: bool = True
    drop_nonroblox: bool = True
    drop_obfuscated: bool = True
    drop_secrets: bool = False           # default: redact in place instead of dropping
    min_quality: float = 0.0
    max_deprecated_per_kb: float = 1e9   # set e.g. 3.0 to drop very old-style code
    # Sources that are Roblox by construction. Short fragments often carry no marker words, so the
    # relevance checks are skipped for them (exploit/backdoor/obfuscation checks still apply).
    trusted_sources: tuple = ("hf:Roblox/luau_corpus",)


def scrub(text: str) -> tuple[str, dict]:
    """Redact secrets and PII in place; returns (text, counts)."""
    counts: dict[str, int] = {}
    for name, pat in SECRET_PATTERNS.items():
        text, n = pat.subn(f"<REDACTED_{name.upper()}>", text)
        if n:
            counts[name] = n
    text, n = EMAIL.subn("<EMAIL>", text)
    if n:
        counts["email"] = n
    text, n = IPV4.subn("<IP>", text)
    if n:
        counts["ip"] = n
    return text, counts


def _line_stats(text: str) -> tuple[int, float, int]:
    lines = text.split("\n")
    lens = [len(l) for l in lines]
    n = max(1, len(lines))
    return max(lens), sum(lens) / n, n


def analyze(rec: dict) -> dict:
    text = rec["text"]
    kind = rec["kind"]
    f: dict = {}
    is_code = kind == "code"

    f["secrets"] = {n: len(p.findall(text)) for n, p in SECRET_PATTERNS.items() if p.search(text)}

    if is_code:
        f["exploit"] = bool(EXPLOIT_STRONG.search(text))
        f["backdoor"] = bool(
            BACKDOOR_REQUIRE_ID.search(text) or LOADSTRING_REMOTE.search(text) or INSERT_ASSET.search(text)
        )
        f["loadstring"] = bool(LOADSTRING_ANY.search(text))
        max_line, avg_line, n_lines = _line_stats(text)
        f["max_line"], f["avg_line"], f["n_lines"] = max_line, round(avg_line, 1), n_lines
        f["escape_blob"] = bool(ESCAPE_BLOB.search(text))
        alnum = sum(c.isalnum() for c in text) / max(1, len(text))
        ws = sum(c.isspace() for c in text) / max(1, len(text))
        f["obfuscated"] = bool(
            f["escape_blob"] or max_line > 1000 or (len(text) > 600 and ws < 0.03) or (len(text) > 400 and alnum < 0.45)
        )
        f["roblox_markers"] = sum(1 for p in ROBLOX_RE if p.search(text))
        f["nonroblox_markers"] = sum(1 for p in NON_ROBLOX_RE if p.search(text))
        dep = {k: len(p.findall(text)) for k, p in DEPRECATED.items()}
        f["deprecated"] = {k: v for k, v in dep.items() if v}
        f["deprecated_per_kb"] = round(sum(dep.values()) / max(1.0, len(text) / 1000), 2)
        f["modern"] = [k for k, p in MODERN_MARKERS.items() if p.search(text)]
        lines = [l.strip() for l in text.split("\n") if l.strip()]
        f["unique_line_ratio"] = round(len(set(lines)) / max(1, len(lines)), 3)
        comment = sum(1 for l in lines if l.startswith("--"))
        f["comment_ratio"] = round(comment / max(1, len(lines)), 3)
    f["quality"] = quality(rec, f)
    return f


def quality(rec: dict, f: dict) -> float:
    """0..1 heuristic. Intentionally simple and explainable; tune against evals later."""
    kind, meta, n = rec["kind"], rec.get("meta", {}), rec["n_chars"]
    q = 0.5
    if kind == "code":
        if n < 200:
            q -= 0.15
        elif n > 1500:
            q += 0.05
        if n > 60_000:
            q -= 0.15
        q += 0.10 * ("strict" in f.get("modern", []))
        q += 0.08 * ("type_annotations" in f.get("modern", []))
        q += 0.05 * ("task_lib" in f.get("modern", []))
        q += 0.04 * (len(f.get("modern", [])) >= 3)
        q -= min(0.25, f.get("deprecated_per_kb", 0) * 0.05)
        q -= 0.15 * (f.get("unique_line_ratio", 1) < 0.35)
        cr = f.get("comment_ratio", 0)
        q += 0.04 if 0.03 <= cr <= 0.4 else (-0.08 if cr > 0.7 else 0)
        stars = meta.get("stars") or 0
        q += min(0.12, 0.03 * (stars ** 0.35)) if stars else 0
        pushed = (meta.get("pushed_at") or "")[:4]
        if pushed.isdigit():
            q += 0.06 if int(pushed) >= 2023 else (-0.05 if int(pushed) <= 2019 else 0)
    elif kind == "qa":
        q += 0.18 * bool(meta.get("solved"))
        q += min(0.12, 0.02 * (meta.get("likes") or 0) ** 0.5)
        q += min(0.08, 0.01 * (meta.get("views") or 0) ** 0.3)
        q += 0.05 if n > 800 else 0
        q -= 0.2 if n < 250 else 0
    return round(max(0.0, min(1.0, q)), 3)


def decide(rec: dict, f: dict, cfg: Config | None = None) -> tuple[bool, str]:
    cfg = cfg or Config()
    n = rec["n_chars"]
    if n < cfg.min_chars:
        return False, "too_short"
    if n > cfg.max_chars:
        return False, "too_long"
    if rec["kind"] == "code":
        if cfg.drop_exploit and f.get("exploit"):
            return False, "exploit"
        if cfg.drop_backdoor and f.get("backdoor"):
            return False, "backdoor"
        if cfg.drop_obfuscated and f.get("obfuscated"):
            return False, "obfuscated"
        trusted = (rec.get("meta", {}).get("roblox_repo") or rec["source"].startswith("rbxapi")
                   or rec["source"] in cfg.trusted_sources)
        if cfg.drop_nonroblox and f.get("nonroblox_markers", 0) >= 1 and f.get("roblox_markers", 0) < 2 and not trusted:
            return False, "non_roblox_lua"
        if not trusted and f.get("roblox_markers", 0) < cfg.min_roblox_markers:
            return False, "no_roblox_signal"
        if f.get("deprecated_per_kb", 0) > cfg.max_deprecated_per_kb:
            return False, "too_deprecated"
    if cfg.drop_secrets and f.get("secrets"):
        return False, "secrets"
    if f.get("quality", 1) < cfg.min_quality:
        return False, "low_quality"
    return True, "ok"


def process(rec: dict, cfg: Config | None = None) -> tuple[dict | None, str]:
    """Analyze, scrub, and attach flags. Returns (record_or_None, reason)."""
    flags = analyze(rec)
    keep, reason = decide(rec, flags, cfg)
    if not keep:
        return None, reason
    out = dict(rec)
    if flags.get("secrets") or EMAIL.search(rec["text"]) or IPV4.search(rec["text"]):
        out["text"], _ = scrub(rec["text"])
        out["n_chars"] = len(out["text"])
    out["flags"] = {k: v for k, v in flags.items() if k not in ("escape_blob",)}
    return out, "ok"
