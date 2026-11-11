"""Inventory existing public Luau/Roblox datasets on Hugging Face (metadata only, no downloads)."""
import json, sys, urllib.request, urllib.parse, concurrent.futures as cf

CANDIDATES = """
Roblox/luau_corpus
TorpedoSoftware/the-luau-stack
TorpedoSoftware/Roblox-Luau-Reasoning-v1.0
TorpedoSoftware/RobloxQA-v2.0
TorpedoSoftware/roblox-info-dump
TorpedoSoftware/LuauLeetcode
khtsly/luau-stack-hq
khtsly/roblox-luau-corpus
khtsly/devforum-roblox-text
khtsly/roblox_docs_corpus_text
khtsly/luau-org-web-text
khtsly/luau-repo-docs-text
Pinkstack/luau-pretrain-corpus-filtered
Pinkstack/luau-pretrain-corpus-unfiltered
Pinkstack/oct2026-Roblox-Luaudev2-dataset-pretrain
Pinkstack/2026-Roblox-Luaudev2-dataset-sft
Pinkstack/LuauDev-instructions-SFT-full
Pinkstack/luaucoder-instructions-v3-SFT
Pinkstack/RobloxAgent-v2
jayras/roblox-luau-dataset
kefir090/luau_github
PatoFlamejanteTV/RobloxCodeLarge2UNFILTRED-Lua-Luau
PatoFlamejanteTV/RobloxCodeXL
renvx0/Luau-Minified
8BitStudio/Roblox-luau-coding_L1
DenSnoychik/claude-opus-5.5-max-RobloxRig
Laserhun/gemini_rblx_luau
Sham76/gptoss-luau-sft
Hash0x/Luau-roblox
""".split()

def get(url):
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "dataset-inventory"}), timeout=30) as r:
            return json.load(r)
    except Exception as e:
        return {"_err": str(e)[:60]}

def info(ds):
    meta = get(f"https://huggingface.co/api/datasets/{ds}")
    size = get("https://datasets-server.huggingface.co/size?dataset=" + urllib.parse.quote(ds, safe="/"))
    card = meta.get("cardData") or {}
    lic = card.get("license") or next((t.split(":",1)[1] for t in meta.get("tags", []) if t.startswith("license:")), "?")
    if isinstance(lic, list): lic = ",".join(lic)
    s = (size.get("size") or {}).get("dataset") or {}
    return dict(id=ds, license=lic, rows=s.get("num_rows"), mb=round((s.get("num_bytes_original_files") or s.get("num_bytes_parquet_files") or 0)/1e6,1),
                modified=(meta.get("lastModified") or "")[:10], gated=meta.get("gated"), err=meta.get("_err") or size.get("_err"))

with cf.ThreadPoolExecutor(6) as ex:
    rows = list(ex.map(info, CANDIDATES))
json.dump(rows, open(sys.argv[1] if len(sys.argv) > 1 else "inventory.json", "w"), indent=1)
print(f"{'dataset':58} {'license':12} {'rows':>9} {'MB':>8} {'modified':10}")
for r in sorted(rows, key=lambda r: -(r['mb'] or 0)):
    print(f"{r['id']:58} {str(r['license'])[:12]:12} {str(r['rows'] or '?'):>9} {r['mb']:>8} {r['modified']:10} {'GATED' if r['gated'] else ''} {r['err'] or ''}")
print("total MB (overlap not removed):", round(sum(r['mb'] or 0 for r in rows)))
