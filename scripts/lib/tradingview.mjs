// scripts/lib/tradingview.mjs
// One-call ratios (incl. ROIC as a ROCE proxy) for GLOBAL listed peers via the
// TradingView scanner. Exchange-prefixed tickers are derived from Yahoo symbols.
// Best-effort enrichment only — Yahoo already computed the core numbers.

import { BROWSER_UA, warn, log, round } from './util.mjs';

// Yahoo symbol/exchange -> TradingView "EXCHANGE:LOCALSYMBOL".
export function tvTicker(rec) {
  const sym = rec._yahoo_symbol || rec.ticker || '';
  if (!sym) return null;
  const dot = sym.lastIndexOf('.');
  const base = dot === -1 ? sym : sym.slice(0, dot);
  const suf = dot === -1 ? '' : sym.slice(dot + 1).toUpperCase();
  const stripZeros = (s) => s.replace(/^0+/, '') || s;
  const map = {
    HK: () => `HKEX:${stripZeros(base)}`,
    SS: () => `SSE:${base}`,
    SZ: () => `SZSE:${base}`,
    T: () => `TSE:${base}`,
    KS: () => `KRX:${base}`,
    KQ: () => `KOSDAQ:${base}`,
    TW: () => `TWSE:${base}`,
    TWO: () => `TPEX:${base}`,
    L: () => `LSE:${base}`,
    PA: () => `EURONEXT:${base}`,
    AS: () => `EURONEXT:${base}`,
    BR: () => `EURONEXT:${base}`,
    DE: () => `XETR:${base}`,
    MI: () => `MIL:${base}`,
    SW: () => `SIX:${base}`,
    NS: () => `NSE:${base}`,
    BO: () => `BSE:${base}`,
  };
  if (suf && map[suf]) return map[suf]();
  if (!suf) {
    // US (no suffix): pick NASDAQ / NYSE / AMEX from the Yahoo exchange code OR
    // its display name (the latter is what survives a resume — see A9).
    const ex = String(rec._yahoo_exchange || rec.exchange || '').toUpperCase();
    if (['NYQ', 'NYS'].includes(ex) || ex.includes('NYSE')) return `NYSE:${base}`;
    if (['PCX', 'ASE'].includes(ex) || ex.includes('AMEX') || ex.includes('AMERICAN')) return `AMEX:${base}`;
    return `NASDAQ:${base}`;
  }
  return null;
}

const COLUMNS = [
  'return_on_invested_capital',
  'return_on_equity',
  'operating_margin',
  'net_margin',
  'price_earnings_ttm',
  'price_book_fq',
  'enterprise_value_ebitda_ttm',
  'market_cap_basic',
  'debt_to_equity',
];

async function scan(tickers, columns) {
  const res = await fetch('https://scanner.tradingview.com/global/scan', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': BROWSER_UA },
    body: JSON.stringify({ symbols: { tickers, query: { types: [] } }, columns }),
  });
  if (!res.ok) throw new Error(`tradingview HTTP ${res.status}`);
  const data = await res.json();
  return Array.isArray(data?.data) ? data.data : [];
}

// Enrich global_listed records in place. Fills roce_pct/roe_pct/pe/pb/ev_ebitda/
// mcap/de only where Yahoo left them null. Never throws.
export async function enrichGlobalWithTradingView(records, { env } = {}) {
  const byTicker = new Map();
  const tickers = [];
  for (const rec of records) {
    const tv = tvTicker(rec);
    if (!tv) continue;
    rec._tv_ticker = tv;
    byTicker.set(tv.toUpperCase(), rec);
    tickers.push(tv);
  }
  if (!tickers.length) return records;

  let rows = [];
  try {
    rows = await scan(tickers, COLUMNS);
  } catch (e) {
    warn(`tradingview full scan failed (${e.message}); retrying with ROIC only`);
    try {
      rows = await scan(tickers, ['return_on_invested_capital']);
    } catch (e2) {
      warn(`tradingview minimal scan failed: ${e2.message}`);
      return records;
    }
  }

  const cols = rows.length && rows[0].d && rows[0].d.length === 1 ? ['return_on_invested_capital'] : COLUMNS;
  for (const row of rows) {
    const rec = byTicker.get(String(row.s || '').toUpperCase());
    if (!rec) continue;
    const d = row.d || [];
    const val = (name) => {
      const i = cols.indexOf(name);
      return i >= 0 && Number.isFinite(d[i]) ? d[i] : null;
    };
    const cur = rec.current;
    const roic = val('return_on_invested_capital');
    if (cur.roce_pct == null && roic != null) {
      cur.roce_pct = round(roic, 2);
      if (!rec.computed_flags.includes('roce')) rec.computed_flags.push('roce');
      rec.note = [rec.note, 'ROCE proxied by TradingView ROIC'].filter(Boolean).join('; ');
    }
    if (cur.roe_pct == null) cur.roe_pct = round(val('return_on_equity'), 2);
    if (cur.pe == null) cur.pe = round(val('price_earnings_ttm'), 2);
    if (cur.pb == null) cur.pb = round(val('price_book_fq'), 2);
    if (cur.ev_ebitda == null) cur.ev_ebitda = round(val('enterprise_value_ebitda_ttm'), 2);
    if (cur.mcap == null) cur.mcap = val('market_cap_basic');
    if (cur.de == null) { const de = val('debt_to_equity'); if (de != null) cur.de = round(de, 2); }
    if (cur.ebitda_pct == null) cur.ebitda_pct = round(val('operating_margin'), 2); // operating-margin fallback
  }
  log(`tradingview enriched ${rows.length}/${tickers.length} global peers`);
  return records;
}
