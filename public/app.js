// public/app.js — visual dashboard (Prompt 2). ES module.
// Search → resolve → progress → poll → render; then tabs + comparison table +
// conditional formatting + current/trend charts + outperformer scorecard.
// All analytics are computed client-side from run.buckets (see analytics.js).

import * as A from './analytics.js';

const $ = (id) => document.getElementById(id);
const STAGES = ['Finding true peers', 'Checking listed vs private', 'Scraping screener financials', 'Fetching global + prices', 'Almost done'];
const STAGE_PCT = [15, 35, 60, 80, 90];
const CODE_KEY = 'pf_run_code';
const TAB_KEY = 'pf_tab';

const state = {
  run: null,
  tab: localStorage.getItem(TAB_KEY) || 'summary',
  view: {},          // bucketKey -> 'current' | 'trend'
  barMetric: {},     // bucketKey -> metric key
  seriesView: {},    // bucketKey+seriesKey -> 'charts' | 'tables'
};

let charts = [];
let pollTimer = null, stageTimer = null, stageIdx = 0, running = false;

// ---------- small DOM helpers ----------
const show = (el) => el && el.classList.remove('hidden');
const hide = (el) => el && el.classList.add('hidden');
const dash = () => '<span class="na">—</span>';
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function srcCell(source) {
  if (!source) return dash();
  if (/^https?:\/\//i.test(source)) {
    const label = source.replace(/^https?:\/\//, '').split('/')[0];
    return `<span class="src"><a href="${esc(source)}" target="_blank" rel="noopener">${esc(label)}</a></span>`;
  }
  return `<span class="muted">${esc(source)}</span>`;
}

// ---------- theme + charts ----------
function darkMode() {
  const t = document.documentElement.dataset.theme;
  if (t === 'dark') return true;
  if (t === 'light') return false;
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
}
function palette() { return darkMode() ? A.SERIES_PALETTE.dark : A.SERIES_PALETTE.light; }
function seriesStyle(i) { const p = palette(); return { color: p[i % p.length], dash: i >= p.length ? [6, 4] : [] }; }
function ink() {
  const cs = getComputedStyle(document.body);
  return {
    text: cs.getPropertyValue('--text').trim() || '#111',
    muted: cs.getPropertyValue('--muted').trim() || '#888',
    border: cs.getPropertyValue('--border').trim() || '#ddd',
    primary: cs.getPropertyValue('--primary').trim() || '#2f6df6',
  };
}
function destroyCharts() { charts.forEach((c) => { try { c.destroy(); } catch {} }); charts = []; }
function mkChart(canvas, cfg) {
  if (!canvas || typeof window.Chart === 'undefined') return null;
  const c = new window.Chart(canvas.getContext('2d'), cfg);
  charts.push(c);
  return c;
}
function axisOpts() {
  const k = ink();
  return {
    x: { ticks: { color: k.muted, autoSkip: true, maxTicksLimit: 10 }, grid: { color: k.border } },
    y: { ticks: { color: k.muted }, grid: { color: k.border }, beginAtZero: false },
  };
}
function legendOpts() { return { labels: { color: ink().text, boxWidth: 12, usePointStyle: true } }; }

// ---------- meta + notes ----------
function renderMeta(run) {
  $('m-query').textContent = run.meta?.query || '—';
  $('m-kind').textContent = run.meta?.kind || '—';
  $('m-def').textContent = run.meta?.business_definition || '—';
  $('m-gen').textContent = run.meta?.generated_at ? new Date(run.meta.generated_at).toLocaleString() : '—';
  show($('meta'));
  const notes = run.notes || [];
  if (notes.length) {
    $('notes-list').innerHTML = notes.map((n) => `<li>${esc(n)}</li>`).join('');
    show($('notes'));
  } else hide($('notes'));
}

// ---------- tabs ----------
const TABS = [
  { id: 'summary', label: 'Summary', dot: '' },
  { id: 'india', label: 'India listed', dot: 'india', bucket: 'india_listed' },
  { id: 'global', label: 'Global listed', dot: 'global', bucket: 'global_listed' },
  { id: 'private', label: 'India private', dot: 'private', bucket: 'india_private' },
];
function renderTabs() {
  const b = state.run.buckets || {};
  $('tabs').innerHTML = TABS.map((t) => {
    const count = t.bucket ? (b[t.bucket] || []).length : null;
    const dot = t.dot ? `<span class="dot ${t.dot}"></span>` : '';
    const chip = count != null ? `<span class="count-chip">${count}</span>` : '';
    return `<button class="tab${state.tab === t.id ? ' active' : ''}" data-tab="${t.id}" role="tab">${dot}${esc(t.label)}${chip}</button>`;
  }).join('');
  $('tabs').querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => { state.tab = btn.dataset.tab; localStorage.setItem(TAB_KEY, state.tab); renderTabs(); renderActiveTab(); });
  });
}

function renderActiveTab() {
  destroyCharts();
  const c = $('tab-content');
  const b = state.run.buckets || {};
  if (state.tab === 'summary') { c.innerHTML = ''; renderSummary(c); return; }
  if (state.tab === 'india') return renderListed(c, 'india_listed', 'india');
  if (state.tab === 'global') return renderListed(c, 'global_listed', 'global');
  if (state.tab === 'private') return renderPrivate(c, 'india_private');
}

// ---------- editor (in-memory only; persistence is Prompt 3) ----------
function emptyListed(name, region) {
  return {
    name, ticker: null, exchange: region === 'india' ? 'NSE/BSE' : null, status: 'listed',
    business_model_tag: null, why_peer: 'manually added', source: 'manual',
    currency: region === 'india' ? 'INR' : null, current: {}, series: {}, price: { history: [] }, computed_flags: [],
  };
}
function emptyPrivate(name) {
  return { name, business: null, products: null, details: 'manually added', source: 'manual', status: 'private' };
}
function removePeer(bucketKey, idx) { state.run.buckets[bucketKey].splice(idx, 1); renderTabs(); renderActiveTab(); }
function addPeer(bucketKey, region, name) {
  name = (name || '').trim();
  if (!name) return;
  state.run.buckets[bucketKey].push(region === 'private' ? emptyPrivate(name) : emptyListed(name, region));
  renderTabs(); renderActiveTab();
}
function editorHtml(bucketKey, region) {
  return `<div class="editor">
    <input class="mini-input" id="add-name" placeholder="Add a peer by name…" />
    <button class="btn small ghost" id="add-btn">＋ Add</button>
    <span class="muted small">In-memory only — recomputes live. Persisting edits is Prompt 3.</span>
  </div>`;
}
function wireEditor(bucketKey, region) {
  const btn = $('add-btn'), inp = $('add-name');
  if (btn) btn.addEventListener('click', () => addPeer(bucketKey, region, inp.value));
  if (inp) inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') addPeer(bucketKey, region, inp.value); });
}
function wireRowDelete(bucketKey) {
  document.querySelectorAll('.row-del').forEach((b) => b.addEventListener('click', () => removePeer(bucketKey, Number(b.dataset.idx))));
}

// ---------- listed tab (India / Global) ----------
function renderListed(container, bucketKey, region) {
  const peers = state.run.buckets[bucketKey] || [];
  const view = state.view[bucketKey] || 'current';
  container.innerHTML = `
    <div class="toolbar">
      <div class="seg" id="view-toggle">
        <button data-view="current" class="${view === 'current' ? 'active' : ''}">Current</button>
        <button data-view="trend" class="${view === 'trend' ? 'active' : ''}">Trend</button>
      </div>
      <div class="spacer"></div>
      ${editorHtml(bucketKey, region)}
    </div>
    <div id="view-body"></div>`;
  $('view-toggle').querySelectorAll('button').forEach((btn) => btn.addEventListener('click', () => {
    state.view[bucketKey] = btn.dataset.view; renderActiveTab();
  }));
  wireEditor(bucketKey, region);
  const body = $('view-body');
  if (!peers.length) { body.innerHTML = '<p class="empty-note">No peers in this bucket. Add one above, or run a query.</p>'; return; }
  if (view === 'current') renderCurrent(body, peers, region, bucketKey);
  else renderTrend(body, peers, region, bucketKey);
}

function renderCurrent(body, peers, region, bucketKey) {
  const isIndia = region === 'india';
  const metrics = A.CURRENT_METRICS;
  const colVals = {}, colBest = {};
  for (const m of metrics) { colVals[m.key] = A.columnValues(peers, m.key); colBest[m.key] = A.bestValue(peers, m.key, m.dir); }

  // header
  let head = '<tr><th class="stick">Company</th><th>Model</th>';
  for (const m of metrics) {
    const d = m.dir ? `<span class="dir">${m.dir === 'higher' ? '↑ better' : '↓ better'}</span>` : '';
    head += `<th class="num"><span class="metric-head">${esc(m.label)}${d}</span></th>`;
  }
  head += '<th>Source</th></tr>';

  // rows
  let bodyR = '';
  peers.forEach((p, idx) => {
    bodyR += '<tr>';
    bodyR += `<td class="stick"><span class="name-main">${esc(p.name || '—')}</span> <button class="row-del" data-idx="${idx}" title="Remove">✕</button>`
      + `<span class="name-sub muted">${esc(p.ticker || '')}${p.exchange ? ' · ' + esc(p.exchange) : ''}</span>`
      + `${p.why_peer ? `<span class="name-sub">${esc(p.why_peer)}</span>` : ''}${p.note ? `<span class="name-sub">Note: ${esc(p.note)}</span>` : ''}</td>`;
    bodyR += `<td>${p.business_model_tag ? `<span class="tag">${esc(p.business_model_tag)}</span>` : dash()}</td>`;
    for (const m of metrics) {
      const v = p.current?.[m.key];
      const t = A.rankFraction(v, colVals[m.key], m.dir);
      const tint = A.tintFor(t);
      const best = m.dir && A.isNum(v) && colVals[m.key].length > 1 && v === colBest[m.key];
      const flag = m.computed && (p.computed_flags || []).includes(m.computed) ? '<span class="flag" title="computed / proxied, not reported">*</span>' : '';
      const yr = m.year && A.isNum(p.current?.[m.year]) ? `<span class="name-sub muted">FY${String(p.current[m.year]).slice(-2)}</span>` : '';
      const disp = A.fmtValue(v, m.fmt, { currency: p.currency, isIndia });
      bodyR += `<td class="num${best ? ' cell-best' : ''}" style="${tint ? `background:${tint}` : ''}">${disp == null ? dash() : esc(disp)}${flag}${yr}</td>`;
    }
    bodyR += `<td class="src">${srcCell(p.source)}</td></tr>`;
  });

  // aggregate rows
  const med = A.aggregatesRow(peers, 'median'), avg = A.aggregatesRow(peers, 'average');
  const aggRow = (label, row) => {
    let h = `<tr class="agg"><td class="stick">${label}</td><td></td>`;
    for (const m of metrics) { const disp = A.fmtValue(row[m.key], m.fmt, { isIndia }); h += `<td class="num">${disp == null ? dash() : esc(disp)}</td>`; }
    return h + '<td></td></tr>';
  };
  bodyR += aggRow('Median', med) + aggRow('Average', avg);

  const metricOpts = metrics.filter((m) => colVals[m.key].length).map((m) => m.key);
  const barKey = state.barMetric[bucketKey] && metricOpts.includes(state.barMetric[bucketKey]) ? state.barMetric[bucketKey] : (metricOpts.includes('revenue') ? 'revenue' : metricOpts[0]);
  state.barMetric[bucketKey] = barKey;

  body.innerHTML = `
    <div class="table-scroll cmp"><table class="cmp"><thead>${head}</thead><tbody>${bodyR}</tbody></table></div>
    <p class="chart-note">Green = better, red = worse (ranked within this tab). Bold-ringed cell = per-metric best. <span class="flag">*</span> = computed/proxied. Cross-currency revenue shown in each peer's own currency.</p>
    <div class="toolbar"><strong>Single-metric chart</strong>
      <select id="bar-metric">${metrics.filter((m) => colVals[m.key].length).map((m) => `<option value="${m.key}"${m.key === barKey ? ' selected' : ''}>${esc(m.label)}</option>`).join('')}</select>
    </div>
    <div class="chart-box"><canvas id="bar-canvas"></canvas></div>`;

  wireRowDelete(bucketKey);
  $('bar-metric').addEventListener('change', (e) => { state.barMetric[bucketKey] = e.target.value; buildBar(peers, region, e.target.value); });
  buildBar(peers, region, barKey);
}

function buildBar(peers, region, key) {
  const m = A.CURRENT_METRICS.find((x) => x.key === key) || { fmt: 'num', dir: 'higher' };
  const isIndia = region === 'india';
  const rows = peers.map((p) => ({ name: p.name, v: p.current?.[key], currency: p.currency }))
    .filter((r) => A.isNum(r.v))
    .sort((a, b) => (m.dir === 'lower' ? a.v - b.v : b.v - a.v));
  // rebuild canvas (destroy previous bar chart)
  const old = charts.find((c) => c.canvas && c.canvas.id === 'bar-canvas');
  if (old) { try { old.destroy(); } catch {} charts = charts.filter((c) => c !== old); }
  const k = ink();
  mkChart($('bar-canvas'), {
    type: 'bar',
    data: { labels: rows.map((r) => r.name), datasets: [{ label: m.label, data: rows.map((r) => r.v), backgroundColor: k.primary, borderRadius: 4, maxBarThickness: 34 }] },
    options: {
      indexAxis: 'y', responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (ctx) => ` ${A.fmtValue(ctx.parsed.x, m.fmt, { isIndia }) ?? ctx.parsed.x}` } },
      },
      scales: { x: { ticks: { color: k.muted }, grid: { color: k.border } }, y: { ticks: { color: k.text }, grid: { display: false } } },
    },
  });
}

// ---------- trend view ----------
function renderTrend(body, peers, region, bucketKey) {
  const metrics = A.SERIES_METRICS.filter((m) => peers.some((p) => (p.series?.[m.key] || []).some((d) => A.isNum(d?.value))));
  const hasPrice = peers.some((p) => (p.price?.history || []).length);
  if (!metrics.length && !hasPrice) { body.innerHTML = '<p class="empty-note">No trend series available for these peers yet.</p>'; return; }
  let html = '';
  metrics.forEach((m, i) => { html += accShell(m.key, m.label, i === 0); });
  if (hasPrice) html += accShell('price', 'Share price (indexed to 100)', !metrics.length);
  body.innerHTML = html;
  body.querySelectorAll('.acc').forEach((det) => {
    fillAcc(det, peers, region, bucketKey);
    det.addEventListener('toggle', () => { if (det.open) fillAcc(det, peers, region, bucketKey); });
  });
}
function accShell(key, label, open) {
  return `<details class="acc" data-key="${key}"${open ? ' open' : ''}><summary>${esc(label)}</summary><div class="acc-body"></div></details>`;
}
function fillAcc(det, peers, region, bucketKey) {
  if (!det.open) return;
  const key = det.dataset.key;
  const sub = state.seriesView[bucketKey + key] || 'charts';
  const bodyEl = det.querySelector('.acc-body');
  bodyEl.innerHTML = `
    <div class="toolbar"><div class="seg subseg">
      <button data-sub="charts" class="${sub === 'charts' ? 'active' : ''}">Charts</button>
      <button data-sub="tables" class="${sub === 'tables' ? 'active' : ''}">Tables</button>
    </div></div>
    <div class="sub-body"></div>`;
  bodyEl.querySelectorAll('.subseg button').forEach((b) => b.addEventListener('click', () => {
    state.seriesView[bucketKey + key] = b.dataset.sub; fillAcc(det, peers, region, bucketKey);
  }));
  const sb = bodyEl.querySelector('.sub-body');
  if (key === 'price') { if (sub === 'charts') { sb.innerHTML = `<div class="chart-box"><canvas></canvas></div><p class="chart-note">Indexed to 100 at each peer's first close in the window (levels aren't cross-currency comparable).</p>`; buildPriceChart(sb.querySelector('canvas'), peers); } else sb.innerHTML = priceTable(peers); return; }
  const m = A.SERIES_METRICS.find((x) => x.key === key);
  if (sub === 'charts') { sb.innerHTML = `<div class="chart-box"><canvas></canvas></div><p class="chart-note">Aligned by year; gaps left where a peer lacks that year (never padded).</p>`; buildLineChart(sb.querySelector('canvas'), peers, key, m.fmt); }
  else sb.innerHTML = trendTable(peers, region, m);
}

function buildLineChart(canvas, peers, key, fmt) {
  const aligned = A.alignByYear(peers, key);
  const datasets = aligned.series.map((s, i) => {
    const st = seriesStyle(i);
    return { label: s.name, data: s.values, borderColor: st.color, backgroundColor: st.color, borderDash: st.dash, borderWidth: 2, pointRadius: 3, pointHoverRadius: 5, spanGaps: false, tension: 0.15 };
  });
  mkChart(canvas, {
    type: 'line',
    data: { labels: aligned.years.map(String), datasets },
    options: {
      responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
      plugins: { legend: legendOpts(), tooltip: { callbacks: { label: (ctx) => ` ${ctx.dataset.label}: ${A.fmtValue(ctx.parsed.y, fmt) ?? '—'}` } } },
      scales: axisOpts(),
    },
  });
}

function buildPriceChart(canvas, peers) {
  const dateSet = new Set();
  peers.forEach((p) => (p.price?.history || []).forEach((h) => dateSet.add(h.date)));
  const dates = [...dateSet].sort();
  const datasets = peers.map((p, i) => {
    const map = new Map((p.price?.history || []).map((h) => [h.date, h.close]));
    let base = null;
    for (const d of dates) { if (map.has(d) && A.isNum(map.get(d))) { base = map.get(d); break; } }
    const st = seriesStyle(i);
    const data = dates.map((d) => (base && map.has(d) && A.isNum(map.get(d))) ? Math.round((map.get(d) / base) * 1000) / 10 : null);
    return { label: p.name, data, borderColor: st.color, borderDash: st.dash, borderWidth: 1.5, pointRadius: 0, spanGaps: true, tension: 0.1 };
  }).filter((ds) => ds.data.some((v) => v != null));
  mkChart(canvas, {
    type: 'line',
    data: { labels: dates, datasets },
    options: {
      responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
      plugins: { legend: legendOpts(), tooltip: { callbacks: { label: (ctx) => ` ${ctx.dataset.label}: ${ctx.parsed.y ?? '—'}` } } },
      scales: axisOpts(),
    },
  });
}

function trendTable(peers, region, m) {
  const isIndia = region === 'india';
  const aligned = A.alignByYear(peers, m.key);
  if (!aligned.years.length) return '<p class="empty-note">No annual data.</p>';
  const best = A.bestPerYear(aligned, m.dir);
  let head = '<tr><th class="stick">Year</th>' + aligned.series.map((s) => `<th class="num">${esc(s.name)}</th>`).join('') + '</tr>';
  let bodyR = '';
  aligned.years.forEach((y, yi) => {
    const rowVals = aligned.series.map((s) => s.values[yi]);
    bodyR += `<tr><td class="stick">${y}</td>`;
    rowVals.forEach((v, ci) => {
      const t = A.rankFraction(v, rowVals, m.dir);
      const tint = A.tintFor(t);
      const isBest = m.dir && A.isNum(v) && best[yi] != null && v === best[yi] && rowVals.filter(A.isNum).length > 1;
      const disp = A.fmtValue(v, m.fmt, { currency: peers[ci]?.currency, isIndia });
      bodyR += `<td class="num${isBest ? ' cell-best' : ''}" style="${tint ? `background:${tint}` : ''}">${disp == null ? dash() : esc(disp)}</td>`;
    });
    bodyR += '</tr>';
  });
  return `<div class="table-scroll cmp"><table class="cmp"><thead>${head}</thead><tbody>${bodyR}</tbody></table></div>`;
}

function priceTable(peers) {
  const rows = peers.map((p) => {
    const h = (p.price?.history || []).filter((x) => A.isNum(x.close));
    const first = h[0], last = h[h.length - 1];
    const chg = first && last && first.close ? ((last.close / first.close - 1) * 100) : null;
    return { name: p.name, currency: p.price?.currency || p.currency, last: last?.close, as_of: last?.date || p.price?.as_of, chg };
  });
  const body = rows.map((r) => `<tr><td class="stick">${esc(r.name)}</td><td>${esc(r.currency || '—')}</td>`
    + `<td class="num">${A.isNum(r.last) ? r.last.toLocaleString() : dash()}</td>`
    + `<td>${r.as_of ? esc(r.as_of) : dash()}</td>`
    + `<td class="num" style="${r.chg == null ? '' : `color:${r.chg >= 0 ? 'var(--good)' : 'var(--bad)'}`}">${A.isNum(r.chg) ? (r.chg >= 0 ? '+' : '') + r.chg.toFixed(1) + '%' : dash()}</td></tr>`).join('');
  return `<div class="table-scroll cmp"><table class="cmp"><thead><tr><th class="stick">Company</th><th>Currency</th><th class="num">Last close</th><th>As of</th><th class="num">Window Δ</th></tr></thead><tbody>${body}</tbody></table></div>`;
}

// ---------- private tab ----------
function renderPrivate(container, bucketKey) {
  const peers = state.run.buckets[bucketKey] || [];
  container.innerHTML = `<div class="toolbar"><div class="spacer"></div>${editorHtml(bucketKey, 'private')}</div><div id="view-body"></div>`;
  wireEditor(bucketKey, 'private');
  const body = $('view-body');
  if (!peers.length) { body.innerHTML = '<p class="empty-note">No private peers identified. Add one above if you know of an unlisted competitor.</p>'; return; }
  const rows = peers.map((p, idx) => `<tr>
    <td class="stick"><span class="name-main">${esc(p.name || '—')}</span> <button class="row-del" data-idx="${idx}" title="Remove">✕</button>${p.business_model_tag ? ` <span class="tag">${esc(p.business_model_tag)}</span>` : ''}</td>
    <td style="white-space:normal">${esc(p.business || '—')}</td>
    <td style="white-space:normal">${esc(p.products || '—')}</td>
    <td class="src">${srcCell(p.source)}</td></tr>`).join('');
  body.innerHTML = `<div class="table-scroll cmp"><table class="cmp"><thead><tr><th class="stick">Company</th><th>Business</th><th>Products</th><th>Source</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  wireRowDelete(bucketKey);
}

// ---------- summary (outperformer scorecard) ----------
function renderSummary(container) {
  const b = state.run.buckets || {};
  const india = b.india_listed || [], global = b.global_listed || [];
  const listed = [...india, ...global];
  const { ranked } = A.computeOutperformer(listed);

  if (!ranked.length) { container.innerHTML = '<p class="empty-note">No listed peers with enough data to score yet. Run a query or add peers on the listed tabs.</p>'; return; }

  const top = ranked[0];
  const labelOf = (k) => (A.CURRENT_METRICS.find((m) => m.key === k) || {}).label || k;
  const chips = (top.winningMetrics.length ? top.winningMetrics : Object.keys(top.perMetric).sort((a, b) => top.perMetric[b] - top.perMetric[a]).slice(0, 3))
    .map((k) => `<span class="chip">${esc(labelOf(k))}<span class="pctl">${top.perMetric[k] != null ? top.perMetric[k] + 'th pct' : ''}</span></span>`).join('');

  const maxScore = ranked[0].score || 1;
  const rankRows = ranked.map((r, i) => `<div class="rank-row${i === 0 ? ' lead-1' : ''}">
      <span class="rk">${i + 1}</span>
      <div><div>${esc(r.name)}${r.peer?.business_model_tag ? ` <span class="tag">${esc(r.peer.business_model_tag)}</span>` : ''}</div>
        <div class="bar-mini" style="width:${Math.max(4, (r.score / maxScore) * 100)}%"></div></div>
      <span class="score-big" style="font-size:16px">${r.score}</span>
    </div>`).join('');

  const cmp = A.medianComparison(india, global);
  const tiles = cmp.rows.filter((r) => A.isNum(r.medians.india) || A.isNum(r.medians.global)).map((r) => {
    const lab = labelOf(r.key);
    const iv = A.fmtValue(r.medians.india, seriesFmt(r.key)) ?? '—';
    const gv = A.fmtValue(r.medians.global, seriesFmt(r.key)) ?? '—';
    const leadTxt = r.leader === 'india' ? '<span class="lead india">India leads</span>' : r.leader === 'global' ? '<span class="lead global">Global leads</span>' : (r.leader === 'tie' ? '<span class="lead">Tie</span>' : '');
    return `<div class="agg-tile"><span class="k">${esc(lab)} (median)</span><div class="v">IN ${esc(iv)} · GL ${esc(gv)}</div>${leadTxt}</div>`;
  }).join('');

  container.innerHTML = `
    <div class="scorecard">
      <div class="winner-card">
        <div class="eyebrow">Overall outperformer</div>
        <div class="winner-name">${esc(top.name)} ${top.peer?.business_model_tag ? `<span class="tag">${esc(top.peer.business_model_tag)}</span>` : ''}</div>
        <div class="winner-sub">Composite percentile score <span class="score-big">${top.score}</span> across margins, returns, growth &amp; efficiency (unit-free, India + Global). ${top.peer?.why_peer ? esc(top.peer.why_peer) : ''}</div>
        <div class="chips">${chips}</div>
      </div>
      <div>
        <div class="section-title">Ranked peers (composite score)</div>
        <div class="rank-list">${rankRows}</div>
      </div>
      <div>
        <div class="section-title">India vs Global vs Total — median comparison</div>
        <div class="agg-strip">${tiles || '<span class="muted">Not enough data on both sides to compare.</span>'}</div>
        <p class="chart-note">Composite score &amp; medians use only unit-free ratios so India (₹) and Global peers compare fairly. Recomputes live when you edit a peer set.</p>
      </div>
    </div>`;
}
function seriesFmt(key) { return (A.CURRENT_METRICS.find((m) => m.key === key) || A.SERIES_METRICS.find((m) => m.key === key) || { fmt: 'num' }).fmt; }

// ---------- top-level render ----------
function render(run) {
  state.run = run;
  renderMeta(run);
  renderTabs();
  renderActiveTab();
  show($('dashboard'));
  hide($('empty'));
}

// ---------- run / resolve / poll (A8) ----------
function setBar(pct) { $('bar-fill').style.width = `${Math.min(100, Math.max(0, pct))}%`; }
function setStage(i, sub = '') { stageIdx = Math.min(i, STAGES.length - 1); $('stage-msg').textContent = STAGES[stageIdx]; $('stage-sub').textContent = sub; setBar(STAGE_PCT[stageIdx]); }
function stopTimers() { if (pollTimer) clearInterval(pollTimer); if (stageTimer) clearInterval(stageTimer); pollTimer = stageTimer = null; }
function endRun() { running = false; $('run-btn').disabled = false; }

async function loadRun(slug) {
  const res = await fetch(`/data/runs/${slug}.json?t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`run json HTTP ${res.status}`);
  return res.json();
}

async function finish(slug) {
  stopTimers();
  $('stage-msg').textContent = 'Loading committed data…';
  setBar(96);
  try {
    const run = await loadRun(slug);
    render(run);
    setBar(100);
    $('stage-msg').textContent = 'Done';
    setTimeout(() => hide($('progress')), 1000);
  } catch {
    $('stage-msg').textContent = 'Data committed but not loadable yet — retrying…';
    setTimeout(() => finish(slug), 5000);
  }
  endRun();
}

function startPolling(slug, since) {
  setStage(0, 'this can take several minutes');
  stageTimer = setInterval(() => { if (stageIdx < STAGES.length - 1) setStage(stageIdx + 1, 'still working…'); }, 22000);
  const qs = `slug=${encodeURIComponent(slug)}${since ? `&since=${encodeURIComponent(since)}` : ''}`;
  pollTimer = setInterval(async () => {
    try {
      const s = await (await fetch(`/api/run-status?${qs}`, { cache: 'no-store' })).json();
      if (s.state === 'done') return finish(slug);
      if (s.state === 'failed') {
        stopTimers();
        $('stage-msg').textContent = 'The run reported a failure.';
        $('stage-sub').textContent = `Check GitHub Actions → peer-run for logs${s.conclusion ? ` (${s.conclusion})` : ''}.`;
        endRun();
      }
    } catch {
      try { await loadRun(slug); return finish(slug); } catch {}
    }
  }, 10000);
}

async function postRun(query) {
  const headers = { 'content-type': 'application/json' };
  const code = localStorage.getItem(CODE_KEY);
  if (code) headers['x-run-code'] = code;
  const r = await fetch('/api/run', { method: 'POST', headers, body: JSON.stringify({ query }) });
  return r.json();
}

async function doRun() {
  const query = $('query').value.trim();
  if (!query) { $('query').focus(); return; }
  if (running) return;
  stopTimers();
  running = true;
  $('run-btn').disabled = true;
  hide($('dashboard')); hide($('meta')); hide($('empty')); hide($('manual-steps'));
  show($('progress'));
  setStage(0, 'resolving business definition…');

  // 1) resolve
  let slug = query.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'run';
  try {
    const j = await (await fetch('/api/resolve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query }) })).json();
    if (j.slug) slug = j.slug;
    if (j.business_definition) $('resolve-line').textContent = `Business definition: ${j.business_definition} (${j.kind})`;
  } catch {}
  history.replaceState(null, '', `?slug=${encodeURIComponent(slug)}`);

  // 2) dispatch
  let j;
  try { j = await postRun(query); } catch (e) { j = { dispatched: false, error: String(e?.message || e) }; }

  if (j && j.need_code) {
    const code = window.prompt('This deployment requires a run access code:');
    if (code) { localStorage.setItem(CODE_KEY, code.trim()); try { j = await postRun(query); } catch {} }
  }

  if (j && j.manual) {
    const m = j.manual;
    $('manual-steps').innerHTML = `<strong>${esc(m.message)}</strong><br>${(m.steps || []).map((s) => '• ' + esc(s)).join('<br>')}`;
    show($('manual-steps'));
    startPolling(slug, j.dispatched_at); // a manual run may still commit
    return;
  }
  if (j && j.dispatched === false) {
    // A8: dispatch failed without manual steps — surface and STOP polling.
    stopTimers();
    $('stage-msg').textContent = j.rate_limited ? 'Run limit reached.' : (j.need_code ? 'A run access code is required.' : 'Could not start the run.');
    $('stage-sub').textContent = esc(j.error || j.detail || 'Try again later.');
    endRun();
    return;
  }
  // 3) dispatched — poll
  startPolling(slug, j?.dispatched_at);
}

// ---------- boot ----------
async function boot() {
  $('run-btn').addEventListener('click', doRun);
  $('query').addEventListener('keydown', (e) => { if (e.key === 'Enter') doRun(); });
  const sample = async (e) => { if (e) e.preventDefault(); try { render(await loadRun('sample-peer-run')); } catch { $('resolve-line').textContent = 'Sample run not found.'; } };
  $('sample-link')?.addEventListener('click', sample);
  $('sample-link-2')?.addEventListener('click', sample);

  try {
    const idx = await (await fetch('/data/runs/index.json?t=' + Date.now(), { cache: 'no-store' })).json();
    if (Array.isArray(idx) && idx.length) {
      $('recent-wrap').innerHTML = 'Recent: ' + idx.slice(0, 5).map((r) => `<a href="?slug=${encodeURIComponent(r.slug)}">${esc(r.query || r.slug)}</a>`).join(' · ');
    }
  } catch {}

  const slug = new URLSearchParams(location.search).get('slug');
  if (slug) { try { render(await loadRun(slug)); } catch { show($('progress')); startPolling(slug); } }
}

if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', boot);
else boot();
