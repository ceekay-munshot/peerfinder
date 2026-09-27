// scripts/lib/screener.mjs
// INDIA LISTED financials via screener.in — browser login (Playwright) + HTML
// parse (cheerio). Mirrors the proven klpdash approach:
//   - log in via a real browser and CONFIRM success by finding /logout/ in the HTML
//   - per company: load /consolidated/ (fallback plain), wait for the custom
//     ribbon (#top-ratios li > 9) with one patient retry, then cheerio-parse
//     the ribbon + section tables, expand the "+" schedules best-effort
//   - daily price via the public chart API using data-warehouse-id
// Discipline: only the searched peer set, jittered gaps, incremental flush and
// START_AT resume are handled by the orchestrator.

import * as cheerio from 'cheerio';
import { chromium } from 'playwright';
import { sleep, jitter, parseNum, parseYear, round, warn, log, BROWSER_UA } from './util.mjs';

// --- Login -------------------------------------------------------------------

export async function loginScreener({ email, password } = {}) {
  email = email || process.env.SCREENER_EMAIL;
  password = password || process.env.SCREENER_PASSWORD;
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const context = await browser.newContext({ userAgent: BROWSER_UA, viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  if (!email || !password) {
    warn('SCREENER_EMAIL / SCREENER_PASSWORD not set — continuing WITHOUT login (data will be limited/blocked)');
    return { browser, context, page, loggedIn: false };
  }
  try {
    await page.goto('https://www.screener.in/login/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.fill('input[name="username"]', email);
    await page.fill('input[name="password"]', password);
    await Promise.all([
      page.click('button[type="submit"]'),
      page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {}),
    ]);
    await sleep(1500);
    const html = await page.content();
    if (!html.includes('/logout/')) {
      // one more check: navigate home and re-inspect
      await page.goto('https://www.screener.in/dash/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      const html2 = await page.content();
      if (!html2.includes('/logout/')) throw new Error('login failed (no /logout/ link — check credentials / 2FA)');
    }
    log('screener login OK');
    return { browser, context, page, loggedIn: true };
  } catch (e) {
    warn(`screener login error: ${e.message}`);
    return { browser, context, page, loggedIn: false, loginError: e.message };
  }
}

// --- Parsing helpers ---------------------------------------------------------

// Grab a labelled row from a section's data-table: header years + values.
export function parseSectionRow($, sectionSel, labelRegex, tableSel = 'table.data-table') {
  const $section = $(sectionSel);
  if (!$section.length) return null;
  const $table = $section.find(tableSel).first();
  if (!$table.length) return null;
  const headers = [];
  $table.find('thead th').each((i, th) => headers.push($(th).text().replace(/\s+/g, ' ').trim()));
  let found = null;
  $table.find('tbody tr').each((i, tr) => {
    if (found) return;
    const label = $(tr).find('td').first().text().replace(/\s+/g, ' ').replace(/\+$/, '').trim();
    if (labelRegex.test(label)) {
      const values = [];
      $(tr).find('td').each((j, td) => { if (j > 0) values.push($(td).text().replace(/\s+/g, ' ').trim()); });
      found = { label, headers: headers.slice(1), values };
    }
  });
  return found;
}

// Parse the little "ranges-table" blocks (Compounded Sales/Profit Growth, ROE,
// Stock Price CAGR) below the P&L table. Returns { title: { "3 Years": "12%", ... } }.
export function parseRangesTables($, sectionSel) {
  const out = {};
  $(sectionSel).find('table.ranges-table').each((i, tbl) => {
    const $t = $(tbl);
    const title = $t.find('th').first().text().replace(/\s+/g, ' ').trim();
    if (!title) return;
    const rows = {};
    $t.find('tr').each((j, tr) => {
      const tds = $(tr).find('td');
      if (tds.length >= 2) {
        const k = $(tds[0]).text().replace(/:/g, '').replace(/\s+/g, ' ').trim();
        const v = $(tds[1]).text().replace(/\s+/g, ' ').trim();
        if (k) rows[k] = v;
      }
    });
    out[title] = rows;
  });
  return out;
}

// Pair a row's headers with its values -> [{year, value}], skipping TTM/blank.
function toSeries(row) {
  if (!row) return [];
  const out = [];
  for (let i = 0; i < row.headers.length; i++) {
    const h = row.headers[i];
    if (/ttm/i.test(h)) continue;
    const y = parseYear(h);
    const v = parseNum(row.values[i]);
    if (y && v !== null) out.push({ year: y, value: v });
  }
  return out;
}

const lastOf = (arr) => (arr && arr.length ? arr[arr.length - 1] : null);

// Best-effort click on a section's "+" schedule expander for `label`.
async function clickExpand(page, sectionSel, label) {
  try {
    const btn = page.locator(`${sectionSel} tr:has(td:has-text("${label}")) button`).first();
    if (await btn.count()) {
      await btn.click({ timeout: 3000 });
      await page.waitForTimeout(400);
    }
  } catch { /* silent-fail if absent */ }
}

// --- Daily price via the public chart API ------------------------------------

async function fetchScreenerPrice(page, warehouseId) {
  if (!warehouseId) return null;
  try {
    const url = `https://www.screener.in/api/company/${warehouseId}/chart/?q=Price&days=10000&consolidated=true`;
    const resp = await page.request.get(url, { headers: { 'user-agent': BROWSER_UA }, timeout: 30000 });
    if (!resp.ok()) { warn(`screener price HTTP ${resp.status()}`); return null; }
    const data = await resp.json();
    const ds = (data?.datasets || []).find((d) => /price/i.test(d.metric || d.label || '')) || data?.datasets?.[0];
    if (!ds?.values) return null;
    const history = [];
    for (const v of ds.values) {
      const date = Array.isArray(v) ? v[0] : v.date;
      const close = parseNum(Array.isArray(v) ? v[1] : v.close);
      if (date && close !== null) history.push({ date: String(date).slice(0, 10), close: round(close, 2) });
    }
    const last = lastOf(history);
    return { currency: 'INR', last_close: last?.close ?? null, as_of: last?.date ?? null, history };
  } catch (e) {
    warn(`fetchScreenerPrice failed: ${e.message}`);
    return null;
  }
}

// --- Scrape one company ------------------------------------------------------

// Returns a raw parsed object (never throws for parse issues; throws only if the
// page cannot load / ribbon never appears after the patient retry).
export async function scrapeCompany(page, symbol) {
  const urls = [
    `https://www.screener.in/company/${symbol}/consolidated/`,
    `https://www.screener.in/company/${symbol}/`,
  ];
  let loaded = false;
  let blocked = false;
  for (const url of urls) {
    try {
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      if (resp && (resp.status() === 403 || resp.status() === 429)) {
        blocked = true;
        warn(`screener ${symbol} BLOCKED HTTP ${resp.status()} (datacenter IP throttling?)`);
      }
      // Wait for the custom ribbon to finish loading (>9 ratios), one patient retry.
      try {
        await page.waitForFunction(() => document.querySelectorAll('#top-ratios li').length > 9, { timeout: 25000 });
        loaded = true;
        break;
      } catch {
        warn(`screener ${symbol}: ribbon not ready, one patient retry`);
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
        try {
          await page.waitForFunction(() => document.querySelectorAll('#top-ratios li').length > 9, { timeout: 25000 });
          loaded = true;
          break;
        } catch { /* try next url */ }
      }
    } catch (e) {
      warn(`screener ${symbol} goto failed: ${e.message}`);
    }
  }
  if (!loaded) {
    const msg = blocked ? `screener ${symbol}: blocked (403/429)` : `screener ${symbol}: ribbon never loaded`;
    throw new Error(msg);
  }

  // Expand schedules best-effort before capturing HTML.
  await clickExpand(page, '#profit-loss', 'Expenses');
  await clickExpand(page, '#quarters', 'Expenses');
  await clickExpand(page, '#shareholding', 'Promoter');

  const html = await page.content();
  const $ = cheerio.load(html);

  // Ribbon: name/value pairs
  const ribbon = {};
  $('#top-ratios li').each((i, li) => {
    const name = $(li).find('.name').text().replace(/\s+/g, ' ').trim();
    const value = ($(li).find('.value').text() || $(li).text()).replace(/\s+/g, ' ').trim();
    if (name) ribbon[name] = value;
  });

  // Sector / industry
  let sector = null;
  $('a[title="Broad Sector"], a[title="Sector"], a[title="Broad Industry"], a[title="Industry"]').each((i, a) => {
    if (!sector) sector = $(a).text().replace(/\s+/g, ' ').trim() || null;
  });

  // warehouse id
  const whMatch = html.match(/data-warehouse-id="(\d+)"/);
  const warehouseId = whMatch ? whMatch[1] : null;

  // Section rows
  const pl = {
    sales: parseSectionRow($, '#profit-loss', /^Sales|^Revenue/i),
    expenses: parseSectionRow($, '#profit-loss', /^Expenses/i),
    opProfit: parseSectionRow($, '#profit-loss', /Operating Profit/i),
    opm: parseSectionRow($, '#profit-loss', /^OPM/i),
    netProfit: parseSectionRow($, '#profit-loss', /Net Profit/i),
    eps: parseSectionRow($, '#profit-loss', /^EPS/i),
    divPayout: parseSectionRow($, '#profit-loss', /Dividend Payout/i),
  };
  const ranges = parseRangesTables($, '#profit-loss');
  const ratios = {
    debtorDays: parseSectionRow($, '#ratios', /Debtor Days/i),
    inventoryDays: parseSectionRow($, '#ratios', /Inventory Days/i),
    payableDays: parseSectionRow($, '#ratios', /Days Payable/i),
    ccc: parseSectionRow($, '#ratios', /Cash Conversion Cycle/i),
    wcDays: parseSectionRow($, '#ratios', /Working Capital Days/i),
    roce: parseSectionRow($, '#ratios', /ROCE/i),
  };
  const cashFlow = { cfo: parseSectionRow($, '#cash-flow', /Cash from Operating/i) };
  const balanceSheet = {
    borrowings: parseSectionRow($, '#balance-sheet', /Borrowings/i),
    equity: parseSectionRow($, '#balance-sheet', /Equity Capital/i),
    reserves: parseSectionRow($, '#balance-sheet', /Reserves/i),
  };
  const shareholding = {
    promoter: parseSectionRow($, '#shareholding', /Promoter/i),
    fii: parseSectionRow($, '#shareholding', /FII/i),
    dii: parseSectionRow($, '#shareholding', /DII/i),
    pledged: parseSectionRow($, '#shareholding', /Pledged/i),
  };
  const quarters = {
    sales: parseSectionRow($, '#quarters', /^Sales|^Revenue/i),
    netProfit: parseSectionRow($, '#quarters', /Net Profit/i),
  };

  const price = await fetchScreenerPrice(page, warehouseId);

  return { symbol, sector, warehouseId, ribbon, pl, ranges, ratios, cashFlow, balanceSheet, shareholding, quarters, price, blocked };
}

// --- Map parsed data into a schema india_listed record -----------------------

function ribbonNum(ribbon, names) {
  for (const n of names) {
    for (const key of Object.keys(ribbon)) {
      if (key.toLowerCase().replace(/[^a-z0-9]/g, '') === n) {
        const v = parseNum(ribbon[key]);
        if (v !== null) return v;
      }
    }
  }
  return null;
}

// D/E per year = Borrowings / (Equity Capital + Reserves), aligned by year.
function deSeries(balanceSheet) {
  const borrow = toSeries(balanceSheet.borrowings);
  const eq = new Map(toSeries(balanceSheet.equity).map((p) => [p.year, p.value]));
  const res = new Map(toSeries(balanceSheet.reserves).map((p) => [p.year, p.value]));
  const out = [];
  for (const b of borrow) {
    const nw = (eq.get(b.year) || 0) + (res.get(b.year) || 0);
    if (nw > 0 && Number.isFinite(b.value)) out.push({ year: b.year, value: round(b.value / nw, 2) });
  }
  return out;
}

// Nearest daily close to a target date, within ~150 days (else null).
function nearestClose(history, targetDate) {
  if (!history || !history.length) return null;
  const t = Date.parse(targetDate);
  let best = null;
  let bestDiff = Infinity;
  for (const h of history) {
    const d = Math.abs(Date.parse(h.date) - t);
    if (d < bestDiff) { bestDiff = d; best = h.close; }
  }
  return bestDiff <= 150 * 864e5 ? best : null;
}

// Historical P/E from reported annual EPS × the nearest year-end price (Indian
// FY ends ~Mar 31). Computed from real inputs, not fabricated; blank where
// EPS<=0 or no nearby close exists.
function peSeries(epsSeries, history) {
  if (!epsSeries?.length || !history?.length) return [];
  const out = [];
  for (const p of epsSeries) {
    if (!(p.value > 0)) continue;
    const close = nearestClose(history, `${p.year}-03-31`);
    if (close != null) out.push({ year: p.year, value: round(close / p.value, 2) });
  }
  return out;
}

export function mapParsedToRecord(parsed, rec) {
  const { ribbon, pl, ranges, ratios, balanceSheet, shareholding } = parsed;

  const salesSeries = toSeries(pl.sales);
  const opmSeries = toSeries(pl.opm);
  const netSeries = toSeries(pl.netProfit);
  const roceSeries = toSeries(ratios.roce);
  const promoterSeries = toSeries(shareholding.promoter);
  const fiiSeries = toSeries(shareholding.fii);
  const diiSeries = toSeries(shareholding.dii);

  // NPM series = Net Profit / Sales * 100 (aligned by year)
  const salesByYear = new Map(salesSeries.map((p) => [p.year, p.value]));
  const npmSeries = [];
  for (const p of netSeries) {
    const s = salesByYear.get(p.year);
    if (Number.isFinite(s) && s !== 0) npmSeries.push({ year: p.year, value: round((p.value / s) * 100, 2) });
  }

  rec.series.revenue = salesSeries;
  rec.series.ebitda_pct = opmSeries;
  rec.series.npm_pct = npmSeries;
  rec.series.roce_pct = roceSeries;
  rec.series.promoter_pct = promoterSeries;
  rec.series.fii_pct = fiiSeries;
  rec.series.dii_pct = diiSeries;
  // A7 trend series: working-capital days (from #ratios) + derived D/E and P/E.
  rec.series.debtor_days = toSeries(ratios.debtorDays);
  rec.series.inventory_days = toSeries(ratios.inventoryDays);
  rec.series.payable_days = toSeries(ratios.payableDays);
  rec.series.ccc_days = toSeries(ratios.ccc);
  rec.series.wc_days = toSeries(ratios.wcDays);
  rec.series.de = deSeries(balanceSheet);
  rec.series.pe = peSeries(toSeries(pl.eps), parsed.price?.history);

  const cur = rec.current;
  const lSales = lastOf(salesSeries);
  if (lSales) { cur.revenue = lSales.value; cur.revenue_year = lSales.year; }
  cur.ebitda_pct = lastOf(opmSeries)?.value ?? null;
  cur.npm_pct = lastOf(npmSeries)?.value ?? null;
  cur.roce_pct = lastOf(roceSeries)?.value ?? ribbonNum(ribbon, ['roce', 'roce%']);
  cur.roe_pct = parseNum(ranges['Return on Equity']?.['Last Year']) ?? ribbonNum(ribbon, ['roe', 'roe%', 'returnonequity']);
  cur.sales_cagr_3y = parseNum(ranges['Compounded Sales Growth']?.['3 Years']);
  cur.sales_cagr_5y = parseNum(ranges['Compounded Sales Growth']?.['5 Years']);
  cur.debtor_days = lastOf(toSeries(ratios.debtorDays))?.value ?? null;
  cur.inventory_days = lastOf(toSeries(ratios.inventoryDays))?.value ?? null;
  cur.payable_days = lastOf(toSeries(ratios.payableDays))?.value ?? null;
  cur.ccc_days = lastOf(toSeries(ratios.ccc))?.value ?? null;
  cur.wc_days = lastOf(toSeries(ratios.wcDays))?.value ?? null;
  cur.promoter_pct = lastOf(promoterSeries)?.value ?? null;
  cur.fii_pct = lastOf(fiiSeries)?.value ?? null;
  cur.dii_pct = lastOf(diiSeries)?.value ?? null;

  cur.pe = ribbonNum(ribbon, ['stockpe', 'pe', 'priceearnings']);
  cur.pb = ribbonNum(ribbon, ['pricetobook', 'pricetobookvalue', 'pb', 'pbv']);
  cur.ev_ebitda = ribbonNum(ribbon, ['evebitda']);
  cur.mcap = ribbonNum(ribbon, ['marketcap', 'mcap']);

  // D/E: prefer ribbon, else compute from balance sheet Borrowings / (Equity + Reserves)
  let de = ribbonNum(ribbon, ['debttoequity', 'de']);
  if (de === null) {
    const b = lastOf(toSeries(balanceSheet.borrowings))?.value;
    const eq = lastOf(toSeries(balanceSheet.equity))?.value;
    const res = lastOf(toSeries(balanceSheet.reserves))?.value;
    const nw = (eq || 0) + (res || 0);
    if (Number.isFinite(b) && nw > 0) de = round(b / nw, 2);
  }
  cur.de = de;

  if (parsed.sector) rec.sector = parsed.sector;
  rec._warehouse_id = parsed.warehouseId || rec._warehouse_id;
  if (parsed.price) rec.price = parsed.price;

  return rec;
}

// Scrape + map one india_listed record in place. Never throws.
export async function fillIndiaListed(page, rec) {
  try {
    const parsed = await scrapeCompany(page, rec.ticker);
    mapParsedToRecord(parsed, rec);
    if (parsed.blocked) rec._errors.push('screener returned 403/429 at some point');
    log(`india filled: ${rec.name} (${rec.ticker}) rev=${rec.current.revenue ?? 'n/a'} roce=${rec.current.roce_pct ?? 'n/a'}`);
  } catch (e) {
    rec._errors.push(`screener: ${e.message}`);
    warn(`fillIndiaListed failed for ${rec.ticker}: ${e.message}`);
  }
  return rec;
}
