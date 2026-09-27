// scripts/lib/yahoo.mjs
// GLOBAL LISTED financials via Yahoo Finance (server-side, no browser).
//   - statement lines: fundamentals-timeseries (no crumb needed)
//   - ratios + holdings: quoteSummary via the CRUMB flow (cookie -> crumb)
// Everything is best-effort and never throws; missing numbers stay null and
// derived numbers are flagged "computed".

import { BROWSER_UA, fetchJson, fetchWithRetry, nowUnix, round, warn, log, yahooHost } from './util.mjs';

// Yahoo exchange codes that mean "Indian listing".
export const INDIA_YF_EXCHANGES = new Set(['NSI', 'BSE', 'NSE']);

const TS_TYPES = [
  'annualTotalRevenue', 'annualGrossProfit', 'annualOperatingIncome', 'annualEBITDA',
  'annualNetIncome', 'annualDilutedEPS', 'annualTotalDebt', 'annualStockholdersEquity',
  'annualTotalAssets', 'annualCurrentLiabilities', 'annualInventory', 'annualReceivables',
  'annualAccountsPayable', 'annualCostOfRevenue',
];

// Search Yahoo for a symbol. Returns [{symbol, exchange, quoteType, shortname, longname, exchDisp}].
// Pass { throwOnError: true } to surface a transient failure (all attempts
// failed) instead of returning [] — lets callers tell "failed" from "empty".
export async function yahooSearch(name, { throwOnError = false } = {}) {
  let lastErr = null;
  for (let i = 0; i < 2; i++) {
    try {
      const host = yahooHost(i);
      const url = `https://${host}/v1/finance/search?q=${encodeURIComponent(name)}&quotesCount=8&newsCount=0&listsCount=0`;
      const data = await fetchJson(url, { headers: { 'user-agent': BROWSER_UA } },
        { attempts: 2, timeoutMs: 15000, label: 'yahoo-search' });
      const quotes = Array.isArray(data?.quotes) ? data.quotes : [];
      return quotes.map((q) => ({
        symbol: q.symbol,
        exchange: q.exchange,
        quoteType: q.quoteType,
        shortname: q.shortname,
        longname: q.longname,
        exchDisp: q.exchDisp,
      })).filter((q) => q.symbol);
    } catch (e) {
      lastErr = e;
      warn(`yahooSearch attempt ${i + 1} failed for "${name}": ${e.message}`);
    }
  }
  if (throwOnError && lastErr) throw lastErr;
  return [];
}

// CRUMB flow: fc.yahoo.com sets a cookie -> getcrumb with that cookie.
export async function getCrumb() {
  try {
    const r1 = await fetchWithRetry('https://fc.yahoo.com/', { headers: { 'user-agent': BROWSER_UA } },
      { attempts: 2, timeoutMs: 12000, label: 'yahoo-cookie', retryStatuses: [] });
    let cookie = '';
    const setc = typeof r1.headers.getSetCookie === 'function' ? r1.headers.getSetCookie() : [];
    if (setc.length) cookie = setc.map((c) => c.split(';')[0]).join('; ');
    const r2 = await fetchWithRetry('https://query1.finance.yahoo.com/v1/test/getcrumb',
      { headers: { 'user-agent': BROWSER_UA, cookie } },
      { attempts: 2, timeoutMs: 12000, label: 'yahoo-crumb' });
    const crumb = (await r2.text()).trim();
    return { crumb, cookie };
  } catch (e) {
    warn(`getCrumb failed: ${e.message}`);
    return { crumb: '', cookie: '' };
  }
}

// Annual statement lines. Returns a map { typeName: [{year, value}] } (year asc).
export async function fetchTimeseries(symbol) {
  const p2 = nowUnix();
  const url =
    `https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(symbol)}` +
    `?symbol=${encodeURIComponent(symbol)}&type=${TS_TYPES.join(',')}` +
    `&period1=1262304000&period2=${p2}`;
  const data = await fetchJson(url, { headers: { 'user-agent': BROWSER_UA } },
    { attempts: 3, timeoutMs: 20000, label: 'yahoo-timeseries' });
  const out = {};
  const results = data?.timeseries?.result || [];
  for (const r of results) {
    const type = r?.meta?.type?.[0];
    if (!type || !Array.isArray(r[type])) continue;
    const arr = [];
    for (const pt of r[type]) {
      const y = pt?.asOfDate ? Number(String(pt.asOfDate).slice(0, 4)) : null;
      const v = pt?.reportedValue?.raw;
      if (y && Number.isFinite(v)) arr.push({ year: y, value: v });
    }
    arr.sort((a, b) => a.year - b.year);
    out[type] = arr;
  }
  return out;
}

export async function fetchQuoteSummary(symbol, { crumb, cookie }) {
  try {
    const modules = 'financialData,defaultKeyStatistics,majorHoldersBreakdown';
    const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}` +
      `?modules=${modules}${crumb ? `&crumb=${encodeURIComponent(crumb)}` : ''}`;
    const data = await fetchJson(url, { headers: { 'user-agent': BROWSER_UA, cookie: cookie || '' } },
      { attempts: 2, timeoutMs: 15000, label: 'yahoo-quotesummary' });
    return data?.quoteSummary?.result?.[0] || null;
  } catch (e) {
    warn(`fetchQuoteSummary failed for ${symbol}: ${e.message}`);
    return null;
  }
}

// helpers ---------------------------------------------------------------------
const last = (arr) => (arr && arr.length ? arr[arr.length - 1] : null);
const byYear = (arr) => {
  const m = new Map();
  for (const p of arr || []) m.set(p.year, p.value);
  return m;
};

function pctSeries(numArr, denArr) {
  const den = byYear(denArr);
  const out = [];
  for (const p of numArr || []) {
    const d = den.get(p.year);
    if (Number.isFinite(d) && d !== 0) out.push({ year: p.year, value: round((p.value / d) * 100, 2) });
  }
  return out;
}

// CAGR over EXACTLY `years` (e.g. sales_cagr_5y needs the point 5 years before
// the latest). Returns null unless that exact start year is present — never
// shrinks the window and mislabels a 3-yr span as 5-yr (A4).
function cagr(series, years) {
  if (!series || series.length < 2) return null;
  const end = series[series.length - 1];
  const start = series.find((p) => p.year === end.year - years);
  if (!start || start.value <= 0 || end.value <= 0) return null;
  return round((Math.pow(end.value / start.value, 1 / years) - 1) * 100, 2);
}

// Fill a global_listed schema record in place. Sets current, series, computed_flags.
export async function fillGlobalListed(rec, { env } = {}) {
  const symbol = rec._yahoo_symbol || rec.ticker;
  if (!symbol) { rec._errors.push('no yahoo symbol'); return rec; }
  const flags = new Set();

  let ts = {};
  try {
    ts = await fetchTimeseries(symbol);
  } catch (e) {
    rec._errors.push(`timeseries: ${e.message}`);
    warn(`fillGlobalListed timeseries failed for ${symbol}: ${e.message}`);
  }

  const rev = ts.annualTotalRevenue || [];
  const ebitda = ts.annualEBITDA || [];
  const opInc = ts.annualOperatingIncome || [];
  const net = ts.annualNetIncome || [];
  const cogs = ts.annualCostOfRevenue || [];
  const inv = ts.annualInventory || [];
  const recv = ts.annualReceivables || [];
  const pay = ts.annualAccountsPayable || [];
  const debt = ts.annualTotalDebt || [];
  const equity = ts.annualStockholdersEquity || [];
  const assets = ts.annualTotalAssets || [];
  const curLiab = ts.annualCurrentLiabilities || [];

  // Series
  rec.series.revenue = rev.map((p) => ({ year: p.year, value: p.value }));
  rec.series.ebitda_pct = pctSeries(ebitda, rev);
  rec.series.npm_pct = pctSeries(net, rev);
  rec.series.roe_pct = pctSeries(net, equity); if (rec.series.roe_pct.length) flags.add('roe');
  // ROCE = OperatingIncome / (TotalAssets - CurrentLiabilities)
  {
    const assetsM = byYear(assets), clM = byYear(curLiab);
    const roce = [];
    for (const p of opInc) {
      const a = assetsM.get(p.year), c = clM.get(p.year);
      if (Number.isFinite(a) && Number.isFinite(c) && (a - c) !== 0) {
        roce.push({ year: p.year, value: round((p.value / (a - c)) * 100, 2) });
      }
    }
    rec.series.roce_pct = roce;
    if (roce.length) flags.add('roce');
  }

  // A7 trend series (computed per year where inputs exist). wc_days and pe are
  // left blank for global peers (no reliable inputs) rather than fabricated.
  {
    const invM = byYear(inv), recvM = byYear(recv), payM = byYear(pay);
    const cogsM = byYear(cogs), revM = byYear(rev), debtM = byYear(debt), eqM = byYear(equity);
    const days = (numM, denM) => {
      const out = [];
      for (const [year, n] of numM) {
        const d = denM.get(year);
        if (Number.isFinite(n) && Number.isFinite(d) && d !== 0) out.push({ year, value: round((n / d) * 365, 0) });
      }
      return out.sort((a, b) => a.year - b.year);
    };
    rec.series.inventory_days = days(invM, cogsM);
    rec.series.debtor_days = days(recvM, revM);
    rec.series.payable_days = days(payM, cogsM);
    const invD = byYear(rec.series.inventory_days), recD = byYear(rec.series.debtor_days), payD = byYear(rec.series.payable_days);
    const ccc = [];
    for (const [year, iv] of invD) {
      const rv = recD.get(year), pv = payD.get(year);
      if (Number.isFinite(iv) && Number.isFinite(rv) && Number.isFinite(pv)) ccc.push({ year, value: round(iv + rv - pv, 0) });
    }
    rec.series.ccc_days = ccc.sort((a, b) => a.year - b.year);
    const de = [];
    for (const [year, d] of debtM) {
      const e = eqM.get(year);
      if (Number.isFinite(d) && Number.isFinite(e) && e !== 0) de.push({ year, value: round(d / e, 2) });
    }
    rec.series.de = de.sort((a, b) => a.year - b.year);
    if (rec.series.inventory_days.length || rec.series.debtor_days.length || rec.series.ccc_days.length) flags.add('ccc');
    if (rec.series.de.length) flags.add('de');
  }

  // Current snapshot (latest year)
  const cur = rec.current;
  const lr = last(rev);
  if (lr) { cur.revenue = round(lr.value, 0); cur.revenue_year = lr.year; }
  cur.ebitda_pct = last(rec.series.ebitda_pct)?.value ?? null;
  cur.npm_pct = last(rec.series.npm_pct)?.value ?? null;
  cur.roce_pct = last(rec.series.roce_pct)?.value ?? null;
  cur.roe_pct = last(rec.series.roe_pct)?.value ?? null;
  cur.sales_cagr_3y = cagr(rev, 3);
  cur.sales_cagr_5y = cagr(rev, 5); // Yahoo gives ~4yr, so this is often null

  // Working-capital days (computed) from latest year
  {
    const lInv = last(inv)?.value, lRecv = last(recv)?.value, lPay = last(pay)?.value;
    const lCogs = last(cogs)?.value, lRev = last(rev)?.value;
    if (Number.isFinite(lInv) && Number.isFinite(lCogs) && lCogs !== 0) {
      cur.inventory_days = round((lInv / lCogs) * 365, 0); flags.add('ccc');
    }
    if (Number.isFinite(lRecv) && Number.isFinite(lRev) && lRev !== 0) {
      cur.debtor_days = round((lRecv / lRev) * 365, 0); flags.add('ccc');
    }
    if (Number.isFinite(lPay) && Number.isFinite(lCogs) && lCogs !== 0) {
      cur.payable_days = round((lPay / lCogs) * 365, 0); flags.add('ccc');
    }
    if (cur.inventory_days != null && cur.debtor_days != null && cur.payable_days != null) {
      cur.ccc_days = round(cur.inventory_days + cur.debtor_days - cur.payable_days, 0);
    }
  }

  // D/E (computed)
  {
    const lDebt = last(debt)?.value, lEq = last(equity)?.value;
    if (Number.isFinite(lDebt) && Number.isFinite(lEq) && lEq !== 0) {
      cur.de = round(lDebt / lEq, 2);
    }
  }

  // Ratios + currency + holdings via quoteSummary (crumb flow)
  try {
    const { crumb, cookie } = await getCrumb();
    const qs = await fetchQuoteSummary(symbol, { crumb, cookie });
    if (qs) {
      const fd = qs.financialData || {};
      const ks = qs.defaultKeyStatistics || {};
      const mh = qs.majorHoldersBreakdown || {};
      rec.currency = fd.financialCurrency || rec.currency || null;
      cur.pe = ks.trailingPE?.raw ?? ks.forwardPE?.raw ?? null;
      cur.pb = ks.priceToBook?.raw ?? null;
      cur.ev_ebitda = ks.enterpriseToEbitda?.raw ?? null;
      cur.mcap = ks.marketCap?.raw ?? fd.marketCap?.raw ?? null;
      // Non-India holding structure differs; map insiders -> promoter (approx), leave FII/DII null.
      if (Number.isFinite(mh.insidersPercentHeld?.raw)) {
        cur.promoter_pct = round(mh.insidersPercentHeld.raw * 100, 2);
        rec.note = [rec.note, 'promoter_pct approximated from Yahoo insiders %'].filter(Boolean).join('; ');
      }
    }
  } catch (e) {
    rec._errors.push(`quoteSummary: ${e.message}`);
  }

  rec.computed_flags = Array.from(flags);
  log(`global filled: ${rec.name} (${symbol}) rev=${cur.revenue ?? 'n/a'} roce=${cur.roce_pct ?? 'n/a'}`);
  return rec;
}
