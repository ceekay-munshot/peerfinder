# True Peer Benchmarking

Give an **industry** or a **company** → find its **true peers** (Indian listed,
global listed, Indian private) → pull their financials → (later prompts)
benchmark them to surface the **outperformer**.

**Prompt 1** built the foundation, the data engine, the true-peer finder and the
run pipeline. **Prompt 2** (this state) added the **visual dashboard** — tabs,
a sticky conditional-formatted comparison table, current/trend charts (line +
bar), and a client-side **outperformer scorecard** — plus a batch of backend
correctness fixes and an additive trend-series expansion. The intelligence /
report / Excel / watchlist layer (**Prompt 3**) is **not** built yet — clean
seams are left for it.

All dashboard analytics (medians, aggregates, percentile scoring, conditional
formatting) are computed **client-side at render time** (`public/analytics.js`)
from the committed JSON — the raw schema is unchanged except for the additive
`SERIES_KEYS` expansion below.

---

## How it works (end to end)

```
Browser (public/) ──POST /api/resolve──▶ Worker ──(short Bedrock Converse)──▶ business definition + slug
        │
        └────────POST /api/run─────────▶ Worker ──workflow_dispatch──▶ GitHub Actions (peer-run.yml)
                                                                          │
                          Node 22 + Playwright + Cheerio                  │
      resolve ▶ find true peers ▶ classify live ▶ screener scrape ▶ Yahoo/TradingView ▶ prices
                                                                          │
                                    commits public/data/runs/<slug>.json ─┘
        │
        └────GET /api/run-status?slug──▶ Worker (checks the committed asset) ──▶ frontend polls, then renders
```

- **Frontend**: static `public/` (plain HTML + vanilla JS, Chart.js via CDN, no
  build step), served by the Worker via the `ASSETS` binding.
- **Worker** (`worker/index.js`): three tiny never-fail API routes + static
  assets.
- **Pipeline** (`scripts/`): all heavy work runs in GitHub Actions and commits a
  single JSON file per run. No database.
- **Honesty**: unknowns are `null` (never `0`), computed values are flagged,
  every peer carries provenance (`why_peer` + `source`). One bad source never
  crashes a run — partial data is always committed.

---

## 1) Exact JSON schema written per run

Path: `public/data/runs/<slug>.json` (`slug` = slugified query).
`schema_version: 1`. A fully-populated, clearly-labelled **synthetic** example
lives at [`public/data/runs/sample-peer-run.json`](public/data/runs/sample-peer-run.json).

```jsonc
{
  "meta": {
    "query": "…", "kind": "company" | "industry",
    "business_definition": "one-line canonical definition",
    "generated_at": "ISO-8601", "schema_version": 1
  },
  "buckets": {
    "india_listed": [{
      "name", "ticker", "exchange", "status": "listed",
      "business_model_tag": "manufacturer|trader-distributor|importer|integrated|asset-light",
      "why_peer", "source", "currency": "INR",
      "current": {
        "revenue", "revenue_year", "sales_cagr_3y", "sales_cagr_5y",
        "ebitda_pct", "npm_pct", "roce_pct", "roe_pct",
        "debtor_days", "inventory_days", "payable_days", "ccc_days", "wc_days",
        "de", "promoter_pct", "fii_pct", "dii_pct",
        "pe", "ev_ebitda", "pb", "mcap"
      },
      "series": {                                   // annual [{year,value}] per key
        "revenue": [{ "year", "value" }],
        "ebitda_pct": [...], "npm_pct": [...], "roce_pct": [...], "roe_pct": [...],
        "promoter_pct": [...], "fii_pct": [...], "dii_pct": [...],
        // Prompt 2 additive expansion (SERIES_KEYS) — feeds the Trend view:
        "debtor_days": [...], "inventory_days": [...], "payable_days": [...],
        "ccc_days": [...], "wc_days": [...], "de": [...], "pe": [...]
      },
      "price": { "currency", "last_close", "as_of", "history": [{ "date", "close" }] }
    }],
    "global_listed": [{
      /* same shape as india_listed, plus: */
      "computed_flags": ["roce", "ccc", "roe"],   // which fields were derived, not reported
      "note": "e.g. ROCE proxied by TradingView ROIC"
    }],
    "india_private": [{
      "name", "business", "products", "details",
      "business_model_tag", "why_peer", "source", "status": "private"
    }]
  },
  "notes": ["provenance / run log lines"]
}
```

Also maintained: `public/data/runs/index.json` — a small list of
`{ slug, query, kind, generated_at }` so the UI can show recent runs.

> **Prompt 2 note:** medians / aggregates / percentile scoring are computed
> **client-side** (`public/analytics.js`) — nothing new is written to the JSON.
> `pe` and `wc_days` series stay blank for global peers (no reliable inputs) —
> never fabricated. Internal scratch fields (`_warehouse_id`, `_yahoo_symbol`, …)
> are stripped before commit via `publicView()`.

### The dashboard (Prompt 2)

`public/index.html` + `app.js` (ES module) + `analytics.js` + `styles.css`.
Loads a committed run (or the bundled `sample-peer-run.json`) and renders:

- **Tabs** — Summary · India listed · Global listed · India private (active tab
  remembered).
- **Comparison table** — sticky header + sticky first column, every `current`
  metric, per-column green→red **conditional formatting** by rank (direction-
  aware), the per-metric best cell ringed, `Median` + `Average` rows, `*` for
  computed values, `—` for blanks (never 0), each currency shown in its own unit.
- **Current ↔ Trend** toggle — Current adds a single-metric **bar chart**
  (dropdown); Trend is an accordion per series metric (+ indexed **price**) with
  its own **Charts ↔ Tables** sub-toggle (line chart / year×company matrix,
  aligned by year, gaps left where a peer lacks a year).
- **Summary scorecard** — a composite percentile rank over unit-free ratios
  surfaces the **overall outperformer** (the different-model distributor wins in
  the sample), with winning-metric chips, a ranked list, and an India-vs-Global-
  vs-Total median comparison.
- **Editable peer set** — add/remove peers in-memory; medians/scores recompute
  live. Persisting edits to the repo is Prompt 3.

---

## 2) Secrets & variables to set (names only)

**GitHub repo → Settings → Secrets and variables → Actions**

| Kind | Name | Purpose |
|------|------|---------|
| Secret | `BEDROCK_API_KEY` | Bearer key for Bedrock Converse |
| Secret | `SCREENER_EMAIL` | screener.in login (use a plain user/pass account, **no 2FA/OTP**) |
| Secret | `SCREENER_PASSWORD` | screener.in login |
| Secret | `FMP_API_KEY` | *optional*, reserved (unused in Prompt 1) |
| Variable | `AWS_REGION` | default `us-east-1` |
| Variable | `BEDROCK_MODEL_IDS` | comma list, default `us.anthropic.claude-sonnet-5,anthropic.claude-sonnet-5` (inference profile first) |

**Cloudflare Worker** (`wrangler secret put …` / dashboard, or `vars` in `wrangler.jsonc`)

| Kind | Name | Purpose |
|------|------|---------|
| Secret | `BEDROCK_API_KEY` | short `/api/resolve` Converse call |
| Secret | `GITHUB_TOKEN` | dispatch the workflow + read run status (`actions:write`, `contents:read`) |
| Var | `GITHUB_REPO` | e.g. `ceekay-munshot/peerfinder` (in `wrangler.jsonc`) |
| Var | `AWS_REGION`, `BEDROCK_MODEL_IDS`, `GITHUB_WORKFLOW_FILE`, `GITHUB_DEFAULT_REF` | in `wrangler.jsonc` |
| Secret *(optional)* | `RUN_ACCESS_CODE` | if set, `/api/run` requires this code; the UI asks once and remembers it |
| Var *(optional)* | `RATE_LIMIT_PER_IP`, `RATE_LIMIT_DAILY` | per-IP and global daily run caps (defaults 20 / 200) |

Local Worker dev: put secrets in `.dev.vars` (git-ignored).

### `/api/run` abuse controls (A6)

`/api/run` dispatches a GitHub Actions run, so it is protected two ways — enable
**at least one** in production:

- **Access code** — set the `RUN_ACCESS_CODE` secret. The page prompts for it
  once, stores it locally, and sends it as the `x-run-code` header. No binding
  needed.
- **Durable rate limit** — bind a Cloudflare **KV namespace** as `RATE_LIMIT`
  and the Worker enforces a per-IP + global daily cap (fails open if KV errors).
  It is intentionally **not** declared in `wrangler.jsonc` (an undefined
  namespace id would break `wrangler deploy`); add it yourself:

  ```bash
  npx wrangler kv namespace create RATE_LIMIT
  # then in wrangler.jsonc:
  # "kv_namespaces": [{ "binding": "RATE_LIMIT", "id": "<the-id-it-prints>" }]
  ```

> **Dependencies note:** `playwright` + `cheerio` are now runtime `dependencies`
> (so `npm install` + a local `node scripts/run-peers.mjs` work). The Worker
> itself imports neither; if a Cloudflare build downloads Chromium during
> `npm install`, set `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` in the build env (the
> Actions workflow installs the browser explicitly with `npx playwright install`).

---

## 3) How a run is triggered + how long it takes

- **From the UI**: type an industry/company → **Run peer benchmarking**. The
  Worker calls `/api/resolve` (seconds) then `/api/run` (dispatches the
  workflow), and the page polls `/api/run-status?slug=…` until the JSON is
  committed, then renders it.
- **Manually**: GitHub → Actions → **peer-run** → *Run workflow* → enter the
  `query` (and optional `start_at` to resume the India scrape).
- **Time**: typically **several minutes to ~30 min** depending on peer count and
  screener responsiveness; the job timeout is **120 min**. The Bedrock calls use
  a **patient retry** (up to ~15 waves, 60s apart) so a busy model does not fail
  the run.

> ⚠️ `workflow_dispatch` only works once `peer-run.yml` is on the repo's
> **default branch**. Until this PR is merged, `/api/run` returns friendly
> **manual steps** instead of failing.

---

## 4) What works end-to-end vs what is stubbed

**Works**
- Worker API (resolve / run / run-status) + static asset serving — validated
  with `wrangler deploy --dry-run` (bundles clean, all bindings resolve).
- Bedrock Converse client (Bearer, model fallback chain, patient retry,
  truncated-JSON repair) — unit-tested.
- Resolve → **true-peer finder** (LLM recall → live status classification via
  screener API then Yahoo → three buckets) with provenance + model tags.
- **India listed** scrape: Playwright login (confirms `/logout/`), ribbon wait
  with patient retry, cheerio parse of P&L / ranges / ratios / cash-flow /
  balance-sheet / shareholding, `+`-schedule expansion, daily price via the
  warehouse-id chart API, incremental flush + `START_AT` resume.
- **Global listed**: Yahoo timeseries + crumb `quoteSummary`, TradingView ROIC
  scan, computed ROCE/CCC/days with `computed_flags`.
- **Daily prices** (India + global) via Yahoo chart v8, host rotation + backoff.
- **Visual dashboard** (Prompt 2): tabs, sticky conditional-formatted comparison
  table, current/trend line + bar charts, outperformer scorecard, editable peer
  set — verified headless (Chart.js instances live, no console errors, light +
  dark) against `sample-peer-run.json`, plus a 14-assertion analytics unit test.
- Never-fail + partial-commit throughout; pure logic covered by `scripts/lib`
  self-tests (39 assertions) and `public/analytics.js` tests (14 assertions).

**Stubbed / deferred (by design)**
- Intelligence report, Excel export, **watchlist**, and **persisting peer-set
  edits** → Prompt 3 (the daily-price fetcher is built now; the watchlist is not).
- Recall currently leans on the LLM's knowledge (broker reports, DRHPs,
  concalls it has read) + screener/Yahoo verification; live PDF/DRHP/web-search
  scraping is a seam, not yet wired.
- `FMP_API_KEY` is reserved but unused.

---

## 5) Assumptions, decisions & risks

- **Screener login**: needs a plain email/password account. **2FA/OTP will fail
  headless** — the login step throws and the run continues with limited India
  data (noted in `notes`).
- **Datacenter-IP throttling**: GitHub Actions IPs may be rate-limited/blocked
  (403/429) by screener/Cloudflare. We back off, retry the ribbon once, log a
  clear "blocked" note, and still commit partial data. A residential proxy may
  be added later.
- **Yahoo crumb / rate limits**: the cookie→crumb flow can fail; `quoteSummary`
  ratios are then skipped while timeseries-derived numbers survive. Hosts rotate
  `query1↔query2` with backoff. Global history is only ~4y, so `sales_cagr_5y`
  is often `null` and CAGR is ~3y.
- **Bedrock model chain**: 429/≥500 ⇒ try next model (busy); 400/403/404 ⇒ try
  next (unusable). The pipeline waits patiently; the Worker uses a trimmed 2–3
  attempt version.
- **Bedrock model IDs + `temperature`** (found by running a live job): the bare
  `anthropic.claude-sonnet-5` id has no on-demand throughput — you must use the
  region-prefixed **inference profile** (`us.anthropic.claude-sonnet-5` for
  `us-*` regions; `eu.`/`apac.` elsewhere), which now leads the default chain.
  Claude Sonnet 5 also **rejects `temperature`** on Converse (HTTP 400), so the
  client no longer sends it. If you set the Actions **variable**
  `BEDROCK_MODEL_IDS`, put the inference-profile id first (or unset it to take
  the fixed default).
- **Status classification is live** (screener → Yahoo → private) — never trusted
  from the model — to avoid mislabelling a listed company as private. An
  Indian listing that screener's search misses but Yahoo finds is routed through
  the Yahoo path with a note (rather than being called private).
- **Price history** is stored at `5y` daily (`PRICE_RANGE`) to keep committed
  JSON small; the fetcher supports `max` for Prompt 3's watchlist store.
- **`index.json` / concurrency**: the workflow uses a concurrency queue so run
  commits don't collide; the push uses a 4-attempt fetch+rebase loop.

---

## 6) File structure

```
peerfinder/
├── wrangler.jsonc              # Worker + static-assets config, vars
├── package.json                # wrangler dev/deploy; ESM
├── worker/
│   └── index.js                # /api/resolve, /api/run, /api/run-status, assets
├── public/                     # static frontend (served by ASSETS)
│   ├── index.html · app.js · styles.css
│   └── data/runs/
│       ├── sample-peer-run.json   # synthetic fixture (schema demo)
│       └── index.json             # recent-runs list
├── scripts/
│   ├── run-peers.mjs           # orchestrator (resolve→peers→scrape→global→prices)
│   └── lib/
│       ├── bedrock.mjs         # Converse + Bearer + fallback chain + patient retry + JSON repair
│       ├── util.mjs            # sleep/jitter/retry/fetch/parseNum/slug/log
│       ├── resolve.mjs         # company/industry → business definition
│       ├── peers.mjs           # TRUE-PEER FINDER: recall → verify → live classify
│       ├── screener.mjs        # Playwright login + cheerio scrape (India listed)
│       ├── yahoo.mjs           # timeseries + crumb quoteSummary (global)
│       ├── tradingview.mjs     # ROIC scan (ROCE proxy) for global peers
│       ├── prices.mjs          # daily prices (India + global) via Yahoo chart
│       └── schema.mjs          # versioned data model + constructors
└── .github/workflows/peer-run.yml   # Node 22 + Playwright, rebase-retry push
```

---

## Local development

```bash
npm install
npm run dev            # wrangler dev (serves worker/ + public/)

# Run the pipeline locally (needs the secrets above as env vars):
QUERY="Ceramic tiles" node scripts/run-peers.mjs
# or:  node scripts/run-peers.mjs "Ceramic tiles"
```
