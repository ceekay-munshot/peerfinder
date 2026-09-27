// public/app.js — minimal client: run -> poll -> render placeholder tables.
// The rich dashboard (charts, medians, outperformer) is Prompt 2.

const $ = (id) => document.getElementById(id);
const STAGES = [
  'Finding true peers',
  'Checking listed vs private',
  'Scraping screener financials',
  'Fetching global + prices',
  'Almost done',
];
const STAGE_PCT = [15, 35, 60, 80, 90];

let pollTimer = null;
let stageTimer = null;
let stageIdx = 0;

function show(el) { el.classList.remove('hidden'); }
function hide(el) { el.classList.add('hidden'); }

function fmt(v, { pct = false, cur = null, cr = false } = {}) {
  if (v === null || v === undefined || v === '') return '<span class="na">—</span>';
  if (typeof v === 'number') {
    if (pct) return `${v.toFixed(1)}%`;
    if (cr && cur === 'INR') return `₹${v.toLocaleString('en-IN')} Cr`;
    if (cur) {
      const compact = Math.abs(v) >= 1000
        ? new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 2 }).format(v)
        : v.toLocaleString();
      return `${cur} ${compact}`;
    }
    return v.toLocaleString();
  }
  return String(v);
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function srcCell(source) {
  if (!source) return '<span class="na">—</span>';
  if (/^https?:\/\//i.test(source)) {
    const label = source.replace(/^https?:\/\//, '').split('/')[0];
    return `<span class="src"><a href="${esc(source)}" target="_blank" rel="noopener">${esc(label)}</a></span>`;
  }
  return `<span class="muted">${esc(source)}</span>`;
}

function listedRows(list, region) {
  if (!list || !list.length) return '<tr><td colspan="8" class="muted">No peers in this bucket.</td></tr>';
  return list.map((p) => {
    const c = p.current || {};
    const isIndia = region === 'india';
    const flags = (p.computed_flags || []);
    const roceFlag = flags.includes('roce') ? '<span class="flag" title="computed / proxied, not reported">*</span>' : '';
    const why = p.why_peer ? `<span class="name-sub">${esc(p.why_peer)}</span>` : '';
    const note = p.note ? `<span class="name-sub">Note: ${esc(p.note)}</span>` : '';
    return `<tr>
      <td>
        <span class="name-main">${esc(p.name || '—')}</span>
        <span class="name-sub muted">${esc(p.ticker || '')}${p.exchange ? ' · ' + esc(p.exchange) : ''}</span>
        ${why}${note}
      </td>
      <td><span class="tag">${esc(p.status || 'listed')}</span></td>
      <td>${p.business_model_tag ? `<span class="tag">${esc(p.business_model_tag)}</span>` : '<span class="na">—</span>'}</td>
      <td class="num">${fmt(c.revenue, { cur: p.currency, cr: isIndia })}${c.revenue_year ? `<span class="name-sub muted">FY${String(c.revenue_year).slice(-2)}</span>` : ''}</td>
      <td class="num">${fmt(c.roce_pct, { pct: true })}${roceFlag}</td>
      <td class="num">${fmt(c.roe_pct, { pct: true })}</td>
      <td class="num">${fmt(c.ebitda_pct, { pct: true })}</td>
      <td class="src">${srcCell(p.source)}</td>
    </tr>`;
  }).join('');
}

function privateRows(list) {
  if (!list || !list.length) return '<tr><td colspan="4" class="muted">No private peers identified.</td></tr>';
  return list.map((p) => `<tr>
    <td><span class="name-main">${esc(p.name || '—')}</span>${p.business_model_tag ? ` <span class="tag">${esc(p.business_model_tag)}</span>` : ''}</td>
    <td class="name-sub" style="white-space:normal">${esc(p.business || '—')}</td>
    <td class="name-sub" style="white-space:normal">${esc(p.products || '—')}</td>
    <td class="src">${srcCell(p.source)}</td>
  </tr>`).join('');
}

function bucketCard(title, dotClass, count, tableHtml) {
  return `<div class="bucket-head"><span class="dot ${dotClass}"></span><h2>${title}</h2><span class="count-chip">${count}</span></div>
    <div class="table-scroll">${tableHtml}</div>`;
}

function render(run) {
  const b = run.buckets || {};
  $('m-query').textContent = run.meta?.query || '—';
  $('m-kind').textContent = run.meta?.kind || '—';
  $('m-def').textContent = run.meta?.business_definition || '—';
  $('m-gen').textContent = run.meta?.generated_at ? new Date(run.meta.generated_at).toLocaleString() : '—';
  show($('meta'));

  const listedHead = `<table><thead><tr>
    <th>Company</th><th>Status</th><th>Model</th><th>Revenue</th><th>ROCE</th><th>ROE</th><th>EBITDA / OPM</th><th>Source</th>
  </tr></thead><tbody>`;
  $('bucket-india').innerHTML = bucketCard('India listed', 'india',
    (b.india_listed || []).length, listedHead + listedRows(b.india_listed, 'india') + '</tbody></table>');
  $('bucket-global').innerHTML = bucketCard('Global listed', 'global',
    (b.global_listed || []).length, listedHead + listedRows(b.global_listed, 'global') + '</tbody></table>');

  const privHead = `<table><thead><tr><th>Company</th><th>Business</th><th>Products</th><th>Source</th></tr></thead><tbody>`;
  $('bucket-private').innerHTML = bucketCard('India private', 'private',
    (b.india_private || []).length, privHead + privateRows(b.india_private) + '</tbody></table>');

  const notes = run.notes || [];
  if (notes.length) {
    $('notes-list').innerHTML = notes.map((n) => `<li>${esc(n)}</li>`).join('');
    show($('notes'));
  }
  show($('results'));
  hide($('empty'));
}

async function loadRun(slug) {
  const res = await fetch(`/data/runs/${slug}.json?t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`run json HTTP ${res.status}`);
  return res.json();
}

function setBar(pct) { $('bar-fill').style.width = `${Math.min(100, Math.max(0, pct))}%`; }
function setStage(i, sub = '') {
  stageIdx = Math.min(i, STAGES.length - 1);
  $('stage-msg').textContent = STAGES[stageIdx];
  $('stage-sub').textContent = sub;
  setBar(STAGE_PCT[stageIdx]);
}

function stopTimers() {
  if (pollTimer) clearInterval(pollTimer);
  if (stageTimer) clearInterval(stageTimer);
  pollTimer = stageTimer = null;
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
    setTimeout(() => hide($('progress')), 1200);
  } catch (e) {
    $('stage-msg').textContent = 'Data committed but could not be loaded — retrying shortly…';
    setTimeout(() => finish(slug), 5000);
  }
}

function startPolling(slug) {
  // Advance stage messages on a timer while we wait.
  setStage(0, 'this can take several minutes');
  stageTimer = setInterval(() => { if (stageIdx < STAGES.length - 1) setStage(stageIdx + 1, 'still working…'); }, 22000);

  let ticks = 0;
  pollTimer = setInterval(async () => {
    ticks++;
    try {
      const res = await fetch(`/api/run-status?slug=${encodeURIComponent(slug)}`, { cache: 'no-store' });
      const s = await res.json();
      if (s.state === 'done') { finish(slug); return; }
      if (s.state === 'failed') {
        stopTimers();
        $('stage-msg').textContent = 'The run reported a failure.';
        $('stage-sub').textContent = 'Check GitHub Actions → peer-run for logs.';
        return;
      }
    } catch {
      // also try loading the file directly (asset may be live before status flips)
      try { await loadRun(slug); finish(slug); return; } catch {}
    }
  }, 10000);
}

async function doRun() {
  const query = $('query').value.trim();
  if (!query) { $('query').focus(); return; }
  const btn = $('run-btn');
  btn.disabled = true;
  hide($('results')); hide($('meta')); hide($('empty')); hide($('manual-steps'));
  show($('progress'));
  setStage(0, 'resolving business definition…');

  // 1) resolve (fast)
  let slug = null, def = '';
  try {
    const r = await fetch('/api/resolve', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query }),
    });
    const j = await r.json();
    slug = j.slug; def = j.business_definition || '';
    $('resolve-line').textContent = def ? `Business definition: ${def} (${j.kind})` : '';
  } catch { slug = query.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); }

  history.replaceState(null, '', `?slug=${encodeURIComponent(slug)}`);

  // 2) dispatch the run
  try {
    const r = await fetch('/api/run', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query }),
    });
    const j = await r.json();
    if (j && j.manual) {
      const m = j.manual;
      $('manual-steps').innerHTML = `<strong>${esc(m.message)}</strong><br>` +
        (m.steps || []).map((s) => `• ${esc(s)}`).join('<br>');
      show($('manual-steps'));
    }
  } catch { /* never-fail; keep polling in case a run was started elsewhere */ }

  // 3) poll until the committed JSON is loadable
  startPolling(slug);
  btn.disabled = false;
}

// --- boot --------------------------------------------------------------------
window.addEventListener('DOMContentLoaded', async () => {
  $('run-btn').addEventListener('click', doRun);
  $('query').addEventListener('keydown', (e) => { if (e.key === 'Enter') doRun(); });
  $('sample-link').addEventListener('click', async (e) => {
    e.preventDefault();
    hide($('empty'));
    try { render(await loadRun('sample-peer-run')); } catch { $('resolve-line').textContent = 'Sample run not found.'; }
  });

  // Recent runs from the index (best-effort).
  try {
    const idx = await (await fetch('/data/runs/index.json?t=' + Date.now(), { cache: 'no-store' })).json();
    if (Array.isArray(idx) && idx.length) {
      const links = idx.slice(0, 5).map((r) =>
        `<a href="?slug=${encodeURIComponent(r.slug)}">${esc(r.query || r.slug)}</a>`).join(' · ');
      $('recent-wrap').innerHTML = 'Recent: ' + links;
    }
  } catch {}

  // Deep link: ?slug=... loads a committed run; if not yet committed, poll.
  const slug = new URLSearchParams(location.search).get('slug');
  if (slug) {
    try { render(await loadRun(slug)); }
    catch { show($('progress')); startPolling(slug); }
  }
});
