#!/usr/bin/env node
// scripts/run-peers.mjs
// End-to-end TRUE PEER BENCHMARKING run (runs in GitHub Actions, Node 22).
//
//   resolve -> find true peers -> classify live -> scrape India (screener) ->
//   fetch global (Yahoo + TradingView) -> daily prices -> commit JSON.
//
// Never-fail: every source is wrapped; a failure is noted and the run still
// writes partial data. Incremental flush after each company keeps partial data
// even if the job crashes. START_AT resumes the India scrape mid-list.
//
// Usage:  node scripts/run-peers.mjs "Ceramic tiles"     (or set QUERY env)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sleep, jitter, slugify, log, warn, nowIso } from './lib/util.mjs';
import { resolveInput } from './lib/resolve.mjs';
import { findPeers } from './lib/peers.mjs';
import { newRun, pushNote, publicView } from './lib/schema.mjs';
import { loginScreener, fillIndiaListed } from './lib/screener.mjs';
import { fillGlobalListed } from './lib/yahoo.mjs';
import { enrichGlobalWithTradingView } from './lib/tradingview.mjs';
import { fillPrice } from './lib/prices.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const RUNS_DIR = path.join(REPO_ROOT, 'public', 'data', 'runs');
const PRICE_RANGE = process.env.PRICE_RANGE || '5y';
const START_AT = Number(process.env.START_AT || 0) || 0;

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

function flush(run, outPath) {
  try { writeJson(outPath, publicView(run)); } catch (e) { warn(`flush failed: ${e.message}`); }
}

// Re-add scratch fields (stripped by publicView) when resuming from disk.
function rehydrate(run) {
  for (const r of run.buckets.india_listed || []) {
    if (!r._yahoo_symbol && r.ticker) r._yahoo_symbol = /^\d+$/.test(r.ticker) ? `${r.ticker}.BO` : `${r.ticker}.NS`;
    if (!Array.isArray(r._errors)) r._errors = [];
  }
  for (const r of run.buckets.global_listed || []) {
    if (!r._yahoo_symbol && r.ticker) r._yahoo_symbol = r.ticker;
    if (!Array.isArray(r._errors)) r._errors = [];
    if (!Array.isArray(r.computed_flags)) r.computed_flags = [];
  }
  return run;
}

// Update a small index of runs so the UI can list them.
function updateIndex(meta) {
  const idxPath = path.join(RUNS_DIR, 'index.json');
  let idx = [];
  try { if (fs.existsSync(idxPath)) idx = JSON.parse(fs.readFileSync(idxPath, 'utf8')); } catch {}
  idx = Array.isArray(idx) ? idx.filter((r) => r.slug !== meta.slug) : [];
  idx.unshift({ slug: meta.slug, query: meta.query, kind: meta.kind, generated_at: meta.generated_at });
  try { writeJson(idxPath, idx.slice(0, 200)); } catch (e) { warn(`index update failed: ${e.message}`); }
}

async function main() {
  const query = (process.argv[2] || process.env.QUERY || '').trim();
  if (!query) {
    console.error('No query. Usage: node scripts/run-peers.mjs "<company or industry>"  (or QUERY env)');
    process.exit(1);
  }
  const startedAt = Date.now();
  const env = process.env;
  const slug = slugify(query);
  const outPath = path.join(RUNS_DIR, `${slug}.json`);
  log(`=== PEER RUN: "${query}" -> ${slug}.json (START_AT=${START_AT}) ===`);

  // 1) Resolve input -> business definition.
  const resolved = await resolveInput(query, { env });
  log(`resolved: kind=${resolved.kind} def="${resolved.business_definition}"`);

  // Build (or resume) the run document.
  let run;
  if (START_AT > 0 && fs.existsSync(outPath)) {
    try {
      run = rehydrate(JSON.parse(fs.readFileSync(outPath, 'utf8')));
      pushNote(run, `Resumed run at START_AT=${START_AT}`);
      log(`resumed from existing ${slug}.json`);
    } catch (e) {
      warn(`resume load failed (${e.message}); starting fresh`);
    }
  }
  if (!run) {
    run = newRun({ query, kind: resolved.kind, business_definition: resolved.business_definition });
    pushNote(run, `Resolved via ${resolved.screener_match ? 'screener+LLM' : 'LLM'}; canonical: ${resolved.canonical_name}`);
    // 2) Find true peers + classify live.
    const buckets = await findPeers(resolved, {
      env,
      onProgress: (p) => log(`classify ${p.index}/${p.total}: ${p.name}`),
    });
    run.buckets = buckets;
    flush(run, outPath);
  }

  // 3) INDIA LISTED via screener (browser login + scrape). Incremental flush.
  const india = run.buckets.india_listed || [];
  if (india.length) {
    const { browser, page, loggedIn, loginError } = await loginScreener({});
    if (!loggedIn) pushNote(run, `screener login not established${loginError ? ` (${loginError})` : ''}; India financials will be limited`);
    try {
      for (let i = START_AT; i < india.length; i++) {
        const rec = india[i];
        log(`[india ${i + 1}/${india.length}] ${rec.name} (${rec.ticker})`);
        await fillIndiaListed(page, rec);
        // Price: screener chart API is fetched inside; fall back to Yahoo if empty.
        if (!rec.price?.history?.length) await fillPrice(rec, { range: PRICE_RANGE });
        flush(run, outPath); // crash-safe partial
        await sleep(jitter(300, 2000)); // polite, klpdash-style gaps
      }
    } finally {
      try { await browser.close(); } catch {}
    }
  }

  // 4) GLOBAL LISTED via Yahoo + TradingView + prices. Incremental flush.
  const global = run.buckets.global_listed || [];
  for (let i = 0; i < global.length; i++) {
    const rec = global[i];
    log(`[global ${i + 1}/${global.length}] ${rec.name} (${rec.ticker})`);
    await fillGlobalListed(rec, { env });
    await fillPrice(rec, { range: PRICE_RANGE });
    flush(run, outPath);
    await sleep(jitter(300, 1200));
  }
  if (global.length) {
    try { await enrichGlobalWithTradingView(global, { env }); } catch (e) { warn(`TV enrich failed: ${e.message}`); }
    flush(run, outPath);
  }

  // 5) India private already carry name/business/products/details/source from findPeers.

  const secs = Math.round((Date.now() - startedAt) / 1000);
  pushNote(run, `Run completed in ${secs}s at ${nowIso()}. ` +
    `Counts: ${run.buckets.india_listed.length} india-listed, ` +
    `${run.buckets.global_listed.length} global-listed, ${run.buckets.india_private.length} india-private.`);
  flush(run, outPath);
  updateIndex({ slug, query, kind: resolved.kind, generated_at: new Date().toISOString() });
  log(`=== DONE in ${secs}s -> ${outPath} ===`);
}

// Never-fail wrapper: on unexpected error, still leave whatever was flushed.
main().catch((e) => {
  warn(`run-peers fatal: ${e?.stack || e}`);
  process.exit(0); // exit 0 so the workflow still commits partial data
});
