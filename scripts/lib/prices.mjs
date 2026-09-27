// scripts/lib/prices.mjs
// DAILY PRICES for India + global tickers via Yahoo chart v8.
// The fetcher supports range=max backfill; the run stores a bounded range
// (default 5y) to keep committed JSON small. (Watchlist is Prompt 3.)

import { BROWSER_UA, warn, log, round, yahooHost } from './util.mjs';

// Exchange/country -> Yahoo suffix (for building symbols when only a code is known).
export const SUFFIX_MAP = {
  NSE: '.NS', BSE: '.BO',
  SSE: '.SS', SZSE: '.SZ',
  HKEX: '.HK',
  TSE: '.T',
  KRX: '.KS', KOSDAQ: '.KQ',
  TWSE: '.TW', TPEX: '.TWO',
  EURONEXT_PA: '.PA', XETR: '.DE', LSE: '.L', MIL: '.MI', EURONEXT_AS: '.AS', SIX: '.SW',
  NASDAQ: '', NYSE: '', AMEX: '',
};

// Fetch daily closes. Returns { currency, last_close, as_of, history:[{date,close}] } or null.
export async function fetchDailyPrices(symbol, { range = '5y', interval = '1d' } = {}) {
  if (!symbol) return null;
  for (let i = 0; i < 4; i++) {
    const host = yahooHost(i);
    const url = `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`;
    try {
      const res = await fetch(url, { headers: { 'user-agent': BROWSER_UA } });
      if (!res.ok) {
        if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
        // 404 / 400 -> symbol not on Yahoo; stop trying.
        warn(`prices ${symbol} HTTP ${res.status}`);
        return null;
      }
      const data = await res.json();
      const r = data?.chart?.result?.[0];
      if (!r) return null;
      const ts = r.timestamp || [];
      const closes = r.indicators?.quote?.[0]?.close || [];
      const history = [];
      for (let k = 0; k < ts.length; k++) {
        const c = closes[k];
        if (c === null || c === undefined || !Number.isFinite(c)) continue;
        history.push({ date: new Date(ts[k] * 1000).toISOString().slice(0, 10), close: round(c, 2) });
      }
      const meta = r.meta || {};
      const last_close = Number.isFinite(meta.regularMarketPrice)
        ? round(meta.regularMarketPrice, 2)
        : (history.length ? history[history.length - 1].close : null);
      const as_of = history.length ? history[history.length - 1].date : null;
      return { currency: meta.currency || null, last_close, as_of, history };
    } catch (e) {
      warn(`prices ${symbol} attempt ${i + 1} failed: ${e.message}`);
      await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, i)));
    }
  }
  return null;
}

// Fill rec.price in place from its Yahoo symbol. Never throws.
export async function fillPrice(rec, { range = '5y' } = {}) {
  const symbol = rec._yahoo_symbol || rec.ticker;
  if (!symbol) return rec;
  try {
    const p = await fetchDailyPrices(symbol, { range });
    if (p) {
      rec.price = {
        currency: p.currency || rec.currency || null,
        last_close: p.last_close,
        as_of: p.as_of,
        history: p.history,
      };
      log(`price ${rec.name} (${symbol}): ${p.history.length} closes, last ${p.last_close ?? 'n/a'}`);
    }
  } catch (e) {
    warn(`fillPrice failed for ${symbol}: ${e.message}`);
  }
  return rec;
}
