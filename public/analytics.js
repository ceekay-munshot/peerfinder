// public/analytics.js
// Pure, DOM-free analytics for the dashboard. Everything is computed CLIENT-SIDE
// at render time from run.buckets — the raw JSON schema is never changed here.
// Importable by app.js (browser ESM) and by the Node unit test.

// ---- Metric metadata --------------------------------------------------------
// direction: 'higher' = higher is better, 'lower' = lower is better, null = neutral (no tint/rank).
// format:    how fmtValue renders it.
export const CURRENT_METRICS = [
  { key: 'revenue',       label: 'Revenue',      dir: 'higher', fmt: 'money', year: 'revenue_year' },
  { key: 'sales_cagr_3y', label: 'Sales CAGR 3y', dir: 'higher', fmt: 'pct' },
  { key: 'sales_cagr_5y', label: 'Sales CAGR 5y', dir: 'higher', fmt: 'pct' },
  { key: 'ebitda_pct',    label: 'EBITDA / OPM', dir: 'higher', fmt: 'pct' },
  { key: 'npm_pct',       label: 'Net margin',   dir: 'higher', fmt: 'pct' },
  { key: 'roce_pct',      label: 'ROCE',         dir: 'higher', fmt: 'pct', computed: 'roce' },
  { key: 'roe_pct',       label: 'ROE',          dir: 'higher', fmt: 'pct', computed: 'roe' },
  { key: 'debtor_days',   label: 'Debtor days',  dir: 'lower',  fmt: 'days' },
  { key: 'inventory_days',label: 'Inventory days',dir: 'lower', fmt: 'days' },
  { key: 'payable_days',  label: 'Payable days', dir: 'lower',  fmt: 'days' },
  { key: 'ccc_days',      label: 'CCC',          dir: 'lower',  fmt: 'days', computed: 'ccc' },
  { key: 'wc_days',       label: 'WC days',      dir: 'lower',  fmt: 'days' },
  { key: 'de',            label: 'D/E',          dir: 'lower',  fmt: 'ratio', computed: 'de' },
  { key: 'promoter_pct',  label: 'Promoter %',   dir: 'higher', fmt: 'pct' },
  { key: 'fii_pct',       label: 'FII %',        dir: null,     fmt: 'pct' },
  { key: 'dii_pct',       label: 'DII %',        dir: null,     fmt: 'pct' },
  { key: 'pe',            label: 'P/E',          dir: 'lower',  fmt: 'x' },
  { key: 'ev_ebitda',     label: 'EV/EBITDA',    dir: 'lower',  fmt: 'x' },
  { key: 'pb',            label: 'P/B',          dir: 'lower',  fmt: 'x' },
  { key: 'mcap',          label: 'Market cap',   dir: null,     fmt: 'money' },
];

// Series shown in the Trend view (annual {year,value}); 'price' is handled specially in app.js.
export const SERIES_METRICS = [
  { key: 'revenue',       label: 'Revenue',       dir: 'higher', fmt: 'money' },
  { key: 'ebitda_pct',    label: 'EBITDA / OPM %',dir: 'higher', fmt: 'pct' },
  { key: 'npm_pct',       label: 'Net margin %',  dir: 'higher', fmt: 'pct' },
  { key: 'roce_pct',      label: 'ROCE %',        dir: 'higher', fmt: 'pct' },
  { key: 'roe_pct',       label: 'ROE %',         dir: 'higher', fmt: 'pct' },
  { key: 'promoter_pct',  label: 'Promoter %',    dir: 'higher', fmt: 'pct' },
  { key: 'fii_pct',       label: 'FII %',         dir: null,     fmt: 'pct' },
  { key: 'dii_pct',       label: 'DII %',         dir: null,     fmt: 'pct' },
  { key: 'debtor_days',   label: 'Debtor days',   dir: 'lower',  fmt: 'days' },
  { key: 'inventory_days',label: 'Inventory days',dir: 'lower',  fmt: 'days' },
  { key: 'payable_days',  label: 'Payable days',  dir: 'lower',  fmt: 'days' },
  { key: 'ccc_days',      label: 'CCC',           dir: 'lower',  fmt: 'days' },
  { key: 'wc_days',       label: 'WC days',       dir: 'lower',  fmt: 'days' },
  { key: 'de',            label: 'D/E',           dir: 'lower',  fmt: 'ratio' },
  { key: 'pe',            label: 'P/E',           dir: 'lower',  fmt: 'x' },
];

// Unit-free metrics safe to compare across currencies (used for aggregates + scorecard).
export const SCORE_METRICS = [
  { key: 'ebitda_pct', dir: 'higher' },
  { key: 'npm_pct', dir: 'higher' },
  { key: 'roce_pct', dir: 'higher' },
  { key: 'roe_pct', dir: 'higher' },
  { key: 'sales_cagr_3y', dir: 'higher' },
  { key: 'ccc_days', dir: 'lower' },
  { key: 'de', dir: 'lower' },
];

// Categorical series palette (validated; fixed order, never cycled).
export const SERIES_PALETTE = {
  light: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'],
  dark:  ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'],
};

// ---- Number helpers ---------------------------------------------------------
export const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

export function median(nums) {
  const a = (nums || []).filter(isNum).slice().sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

export function mean(nums) {
  const a = (nums || []).filter(isNum);
  if (!a.length) return null;
  return a.reduce((s, x) => s + x, 0) / a.length;
}

const round = (n, d = 2) => (isNum(n) ? Math.round(n * 10 ** d) / 10 ** d : null);

// Collect a metric's numeric values across a peer list.
export function columnValues(peers, key) {
  return (peers || []).map((p) => p?.current?.[key]).filter(isNum);
}

// The best value for a metric given direction (null if none / neutral).
export function bestValue(peers, key, dir) {
  if (!dir) return null;
  const vals = columnValues(peers, key);
  if (!vals.length) return null;
  return dir === 'higher' ? Math.max(...vals) : Math.min(...vals);
}

// Rank fraction in [0,1]: 0 = best, 1 = worst (direction-aware). null if not rankable.
export function rankFraction(value, values, dir) {
  if (!dir || !isNum(value)) return null;
  const vals = values.filter(isNum);
  if (vals.length < 2) return null;
  const min = Math.min(...vals), max = Math.max(...vals);
  if (min === max) return null;
  const t = (value - min) / (max - min); // 0 at min, 1 at max
  return dir === 'higher' ? 1 - t : t;    // 0 = best
}

// Percentile score 0..100 (100 = best), direction-aware, inclusive.
export function percentile(value, values, dir) {
  if (!dir || !isNum(value)) return null;
  const vals = values.filter(isNum);
  if (!vals.length) return null;
  const better = vals.filter((v) => (dir === 'higher' ? v <= value : v >= value)).length;
  return round((better / vals.length) * 100, 1);
}

// ---- Aggregates -------------------------------------------------------------
export function aggregatesRow(peers, kind /* 'median' | 'average' */) {
  const out = {};
  for (const m of CURRENT_METRICS) {
    const vals = columnValues(peers, m.key);
    out[m.key] = kind === 'median' ? median(vals) : round(mean(vals), 2);
  }
  return out;
}

// India vs Global vs Total median comparison on unit-free key metrics.
export function medianComparison(india, global) {
  const total = [...(india || []), ...(global || [])];
  const groups = { india, global, total };
  const rows = SCORE_METRICS.map((m) => {
    const meds = {
      india: median(columnValues(india, m.key)),
      global: median(columnValues(global, m.key)),
      total: median(columnValues(total, m.key)),
    };
    let leader = null;
    if (isNum(meds.india) && isNum(meds.global)) {
      if (meds.india === meds.global) leader = 'tie';
      else leader = (m.dir === 'higher' ? meds.india > meds.global : meds.india < meds.global) ? 'india' : 'global';
    }
    return { key: m.key, dir: m.dir, medians: meds, leader };
  });
  return { groups, rows };
}

// ---- Outperformer scorecard -------------------------------------------------
// Composite percentile across SCORE_METRICS over the given peer set (India+Global).
export function computeOutperformer(peers) {
  const pool = (peers || []).filter((p) => p && p.current);
  if (!pool.length) return { ranked: [], leaderWins: {} };

  // Precompute value arrays + the best value per metric.
  const valuesByKey = {};
  const bestByKey = {};
  for (const m of SCORE_METRICS) {
    const vals = columnValues(pool, m.key);
    valuesByKey[m.key] = vals;
    bestByKey[m.key] = vals.length ? (m.dir === 'higher' ? Math.max(...vals) : Math.min(...vals)) : null;
  }

  const ranked = pool.map((p) => {
    const perMetric = {};
    const wins = [];
    let sum = 0, n = 0;
    for (const m of SCORE_METRICS) {
      const v = p.current[m.key];
      if (!isNum(v)) continue;
      const pct = percentile(v, valuesByKey[m.key], m.dir);
      if (pct == null) continue;
      perMetric[m.key] = pct;
      sum += pct; n += 1;
      if (isNum(bestByKey[m.key]) && v === bestByKey[m.key]) wins.push({ key: m.key, pct });
    }
    const score = n ? round(sum / n, 1) : null;
    // chips: metrics this peer wins, best percentile first, top 3.
    const winningMetrics = wins.sort((a, b) => b.pct - a.pct).slice(0, 3).map((w) => w.key);
    return { peer: p, name: p.name, score, coverage: n, perMetric, winningMetrics };
  })
    .filter((r) => r.score != null)
    .sort((a, b) => b.score - a.score);

  return { ranked, valuesByKey, bestByKey };
}

// ---- Series alignment (Trend) ----------------------------------------------
// Align a series key across peers by year. Returns { years:[...], series:[{name, values:[…|null]}] }.
export function alignByYear(peers, key) {
  const yearSet = new Set();
  const perPeer = (peers || []).map((p) => {
    const pts = (p?.series?.[key] || []).filter((d) => isNum(d?.value) && Number.isFinite(d?.year));
    const map = new Map(pts.map((d) => [d.year, d.value]));
    for (const y of map.keys()) yearSet.add(y);
    return { name: p.name, map };
  });
  const years = [...yearSet].sort((a, b) => a - b);
  const series = perPeer.map((pp) => ({
    name: pp.name,
    values: years.map((y) => (pp.map.has(y) ? pp.map.get(y) : null)),
  }));
  return { years, series };
}

// Best value per year (direction-aware) — for the Trend table highlight.
export function bestPerYear(aligned, dir) {
  if (!dir) return [];
  return aligned.years.map((_, i) => {
    const col = aligned.series.map((s) => s.values[i]).filter(isNum);
    if (!col.length) return null;
    return dir === 'higher' ? Math.max(...col) : Math.min(...col);
  });
}

// ---- Formatting -------------------------------------------------------------
export function fmtValue(value, fmt, { currency = null, isIndia = false } = {}) {
  if (!isNum(value)) return null;
  switch (fmt) {
    case 'pct': return `${value.toFixed(1)}%`;
    case 'x': return `${value.toFixed(2)}×`;
    case 'ratio': return value.toFixed(2);
    case 'days': return `${Math.round(value)}`;
    case 'money': {
      if (isIndia || currency === 'INR') return `₹${Math.round(value).toLocaleString('en-IN')} Cr`;
      const compact = Math.abs(value) >= 1000
        ? new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 2 }).format(value)
        : value.toLocaleString();
      return currency ? `${currency} ${compact}` : compact;
    }
    default: return value.toLocaleString();
  }
}

// A subtle green→red tint (diverging, neutral middle) from a rank fraction
// (0=best→green, 1=worst→red). Returns an rgba string readable in light & dark,
// or '' for neutral. Alpha grows with distance from the median rank.
export function tintFor(t) {
  if (t == null) return '';
  const good = [16, 163, 74];   // green
  const bad = [208, 59, 59];    // red
  const d = Math.abs(t - 0.5) * 2;         // 0 at median → 1 at extremes
  const alpha = 0.08 + d * 0.20;           // 0.08 … 0.28
  const rgb = t <= 0.5 ? good : bad;
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha.toFixed(3)})`;
}
