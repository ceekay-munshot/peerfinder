// scripts/lib/schema.mjs
// The versioned run data model. Every source writes into these shapes.
// Rule: use null (never 0) for unknowns; label computed values; carry provenance.

export const SCHEMA_VERSION = 1;

// Keys of the "current" (latest snapshot) block. All default to null.
export const CURRENT_KEYS = [
  'revenue', 'revenue_year',
  'sales_cagr_3y', 'sales_cagr_5y',
  'ebitda_pct', 'npm_pct',
  'roce_pct', 'roe_pct',
  'debtor_days', 'inventory_days', 'payable_days', 'ccc_days', 'wc_days',
  'de',
  'promoter_pct', 'fii_pct', 'dii_pct',
  'pe', 'ev_ebitda', 'pb', 'mcap',
];

// Time-series keys we track (full annual series where available).
export const SERIES_KEYS = [
  'revenue', 'ebitda_pct', 'npm_pct', 'roce_pct', 'roe_pct',
  'promoter_pct', 'fii_pct', 'dii_pct',
  // A7 additions — working-capital days + leverage + valuation trend:
  'debtor_days', 'inventory_days', 'payable_days', 'ccc_days', 'wc_days', 'de', 'pe',
];

export function emptyCurrent() {
  const o = {};
  for (const k of CURRENT_KEYS) o[k] = null;
  return o;
}

export function emptySeries() {
  const o = {};
  for (const k of SERIES_KEYS) o[k] = [];
  return o;
}

export function emptyPrice(currency = null) {
  return { currency, last_close: null, as_of: null, history: [] };
}

// --- Peer record constructors -------------------------------------------------

export function newIndiaListed(p = {}) {
  return {
    name: p.name || null,
    ticker: p.ticker || null,          // screener symbol / NSE-BSE code
    exchange: p.exchange || 'NSE/BSE',
    status: 'listed',
    business_model_tag: p.business_model_tag || null,
    why_peer: p.why_peer || null,
    source: p.source || null,          // provenance URL / description
    currency: p.currency || 'INR',
    current: emptyCurrent(),
    series: emptySeries(),
    price: emptyPrice(p.currency || 'INR'),
    // scratch fields used only during the run (not part of the public contract)
    _warehouse_id: p._warehouse_id || null,
    _yahoo_symbol: p._yahoo_symbol || null,
    _errors: [],
  };
}

export function newGlobalListed(p = {}) {
  return {
    name: p.name || null,
    ticker: p.ticker || null,          // Yahoo symbol
    exchange: p.exchange || null,      // e.g. NASDAQ, HKEX, TSE
    status: 'listed',
    business_model_tag: p.business_model_tag || null,
    why_peer: p.why_peer || null,
    source: p.source || null,
    currency: p.currency || null,
    current: emptyCurrent(),
    series: emptySeries(),
    price: emptyPrice(p.currency || null),
    computed_flags: [],                // e.g. ["roce","ccc"] where derived, not reported
    note: p.note || null,
    _tv_ticker: p._tv_ticker || null,  // exchange-prefixed TradingView symbol
    _errors: [],
  };
}

export function newIndiaPrivate(p = {}) {
  return {
    name: p.name || null,
    business: p.business || null,
    products: p.products || null,
    details: p.details || null,
    business_model_tag: p.business_model_tag || null,
    why_peer: p.why_peer || null,
    source: p.source || null,
    status: 'private',
  };
}

// --- Run document -------------------------------------------------------------

export function newRun({ query, kind, business_definition }) {
  return {
    meta: {
      query: query || null,
      kind: kind || null,             // "company" | "industry"
      business_definition: business_definition || null,
      generated_at: new Date().toISOString(),
      schema_version: SCHEMA_VERSION,
    },
    buckets: {
      india_listed: [],
      global_listed: [],
      india_private: [],
    },
    notes: [],
  };
}

export function pushNote(run, msg) {
  if (!run.notes) run.notes = [];
  run.notes.push(`[${new Date().toISOString()}] ${msg}`);
}

// Strip internal scratch fields (prefixed "_") before committing the public JSON.
export function publicView(run) {
  const clean = (obj) => {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k.startsWith('_')) continue;
      out[k] = v;
    }
    return out;
  };
  return {
    meta: { ...run.meta, generated_at: new Date().toISOString() },
    buckets: {
      india_listed: (run.buckets.india_listed || []).map(clean),
      global_listed: (run.buckets.global_listed || []).map(clean),
      india_private: (run.buckets.india_private || []).map(clean),
    },
    notes: run.notes || [],
  };
}
