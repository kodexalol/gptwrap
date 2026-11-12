# rbxcrawl — Roblox/Luau training-data crawler

Resumable, rate-limit-aware crawler that turns every public source of Roblox/Luau code and Q&A
into one clean, deduplicated, labelled dataset (zstd-JSONL), runnable on Modal CPU for cents.

```
sources                          pipeline                       output
────────────────────────────     ──────────────────────────     ───────────────────────
DevForum  (search → threads) ┐
GitHub    (search → tarballs)├─►  raw shards ─► filter ─► dedup ─►  data/clean/*.jsonl.zst
Roblox API dump (+deprecated)│     (uniform      (safety,    (exact +   + report.json
Hugging Face (28+ datasets)  ┘      schema)       labels)     MinHash)
```

## Quick start

```bash
pip install -r requirements-dev.txt && pytest                 # 49 tests, no network
python -m rbxcrawl rbxapi --data data                         # engine API + deprecated list
python -m rbxcrawl devforum all --data data --cats scripting-support --start 2021-03-09 --end 2021-03-12
python -m rbxcrawl hf --data data --datasets Roblox/luau_corpus --max-rows 5000
python -m rbxcrawl filter data/devforum/raw data/rbxapi/raw data/hf/raw --out data/filtered
python -m rbxcrawl dedup  data/filtered --out data/clean      # inputs in priority order: first copy wins
python -m rbxcrawl stats  data/clean
```

On Modal (everything persists to the `rbx-crawl` Volume; every job resumes where it stopped):

```bash
modal run modal_app.py --job smoke                      # ~1 min, a few cents
modal run --detach modal_app.py --job rbxapi
modal run --detach modal_app.py --job devforum          # discover + fetch, self-chaining past 24 h
modal run --detach modal_app.py --job hf
GITHUB_TOKEN=... modal run --detach modal_app.py --job github     # token: public read, no scopes
modal run --detach modal_app.py --job build             # filter + dedup -> /data/clean
modal run modal_app.py --job status
```
Note: install `modal[api-proxy-support]` if you run Modal behind an HTTPS proxy.

## What makes it "ultimate"

**Coverage beyond API limits**
- *DevForum*: Discourse caps category listings at ~2000 pages (~60k topics) but `scripting-support`
  alone has ~230k. We enumerate with **date-windowed search** (50 results/page), **recursively
  bisecting** any window that saturates the per-query cap, and falling back to
  `status:` / `min_posts:` / `max_posts:` buckets for a single heavy day. Saturated-but-unresolvable days
  are counted and logged, never silently dropped. Unanswered threads are skipped *before* fetching
  (`min_posts`), and fetch order is value-first (solved, then long threads), so a partial run still
  captures the best data.
- *GitHub*: repository search is capped at 1000 hits, so each (query × created-window) is bisected
  whenever `total_count > 1000`. Files come from **one `codeload` tarball per repo** (not counted against
  API quotas), filtered while streaming (skips vendored `Packages/`, `node_modules`, `.min.lua`, binaries, >256 KB).
  15 default queries cover `language:Luau`, Lua + Roblox topics (rojo, wally, roact, …) and README mentions.
- *Existing scrapes*: 28 public Hugging Face Luau/Roblox datasets (~12.8 GB raw) are imported into the same
  schema with per-schema adapters, so our crawls only need to fill the gaps (fresh GitHub, deep DevForum).

**Faithful threads, not snippets**: HTML → markdown with code fences preserved, quotes kept, embeds dropped;
the **accepted solution is fetched separately** when it is deep in a long thread; posts are labelled
`question / solution / reply` with like counts; usernames are never stored; **screenshot URLs are recorded** so a
vision stage can download images only for the records that survive filtering.

**Politeness as a feature**: per-host token-spacing limiter with AIMD (halves on 429, honours `Retry-After`,
the `x-ratelimit-reset` header and Discourse's `wait_seconds`, then creeps back toward — never above — the
configured ceiling). Real refusals (401/403/404/410) are returned, not retried or worked around.

**Safety & quality labelling** (`filters.py`)
- Dropped: executor/exploit scripts (`getgenv`, `hookfunction`, `syn.*`, `Drawing.new`, …), backdoors
  (`require(<asset id>)`, `loadstring(HttpGet…)`, `InsertService:LoadAsset(id)`), obfuscated/minified blobs,
  non-Roblox Lua (Neovim, LÖVE, nginx, WoW, …), too short/long.
- Redacted in place: Discord webhooks, `.ROBLOSECURITY` cookies, API keys/tokens, private keys, emails, public IPs.
- **Labelled, not dropped**: deprecated-API hits (`wait`, `spawn`, `Body*` movers, lowercase `:connect`,
  `Instance.new(x, parent)`, …) and modern-Luau markers (`--!strict`, types, `task.*`, `:Raycast`, `PivotTo`). Keep them to
  down-weight old style *or* to auto-generate "modernize this" pairs.
- A 0–1 quality score (strictness, types, deprecation density, stars, recency; for Q&A: solved, likes, views).
- Sources that are Roblox by construction (`Config.trusted_sources`, e.g. Roblox's own corpus) skip the
  relevance check — found when a first audit showed 45% of that corpus being wrongly dropped.

**Dedup**: exact (comment/whitespace-insensitive for code) + MinHash-LSH near-dup; first-seen wins, so list your
own crawls before bulk imports.

## Measured so far (real runs)
| check | result |
|---|---|
| Boundary semantics | union of day windows == multi-day window (exact) |
| Busy month (2021-03, `scripting-support`) | 4,008 threads with ≥2 posts in 226 requests, 12 bisections, 1 handled 429 |
| 3-day slice → fetch 30 topics | 29 records (10 solved, 10 with screenshots), avg ~2.9k chars |
| API dump | 1,035 records; 43 deprecated classes; 97 classes with deprecated members |
| HF import → filter → dedup (35k rows) | 31.5k kept → 27.3k after dedup ≈ 21M tokens |
| Modal smoke (image, network, Volume) | pass |
| GitHub live (unauthenticated) | 82 repos in one window; 2 tarballs → 17 + 9 Luau files, license + Roblox-project detection OK |

## Cost / time estimates (estimates — measure with `--job status`)
- Modal CPU is ~$0.047/core-hour + ~$0.008/GiB-hour. A 0.5-core/1 GiB crawler ≈ **$0.03/hour**.
- DevForum at the default 2.5 req/s ceiling: discovery ~5–10k requests; fetch roughly 1.2 requests per topic, so
  expect on the order of 1 day and **~$1** of credit for all four categories. Value-first ordering means stopping early still helps.
- GitHub discovery is bounded by the Search API (30 req/min with a token): tens of minutes to a couple of hours.

## Known limits / not done yet
- GitHub discovery with a token has only been tested against mocks (the unauthenticated live check passed).
- DevForum/GitHub terms of service were not reviewed; this is the user's call, not a technical guarantee.
- Datasets shipped as zip archives (e.g. `PatoFlamejanteTV/RobloxCodeXL`) are skipped; gated datasets
  (e.g. `TorpedoSoftware/the-luau-stack`) need you to accept their terms on Hugging Face first.
- MinHash dedup holds ~1 KB per kept document in RAM — fine for a few million docs in the 16 GB build container.
- Next stages (not built): `luau-analyze` type-check against Roblox definitions, an image downloader for the
  vision set, mining commit history for bug-fix pairs, and a training-set assembler that samples by quality.
