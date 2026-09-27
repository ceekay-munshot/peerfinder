// worker/index.js
// Cloudflare Worker for the True Peer Benchmarking dashboard.
//   POST /api/resolve     {query} -> {kind, business_definition, slug}
//   POST /api/run         {query} -> dispatch the GitHub Actions run
//   GET  /api/run-status?slug=...  -> {state: starting|running|done|failed}
//   *                     -> static assets (public/ via the ASSETS binding)
// Every route NEVER-FAILS to a friendly 200.

import { slugify } from '../scripts/lib/util.mjs';
import { callBedrockQuickJSON } from '../scripts/lib/bedrock.mjs';

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

async function readBody(request) {
  try { return await request.json(); } catch { return {}; }
}

// Light screener search (worker-side, dependency-free).
async function screenerSearchLite(q) {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 8000);
    const res = await fetch(`https://www.screener.in/api/company/search/?q=${encodeURIComponent(q)}`, {
      headers: { 'user-agent': 'Mozilla/5.0 peerfinder' },
      signal: ac.signal,
    });
    clearTimeout(t);
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch { return []; }
}

const RESOLVE_SYSTEM =
  'You are an equity analyst. Classify a search as a company or an industry and give a one-line business definition. Reply with STRICT JSON only.';

async function handleResolve(request, env) {
  const { query } = await readBody(request);
  const q = (query || '').trim();
  if (!q) return json({ error: 'query required', kind: 'industry', business_definition: '', slug: 'run' }, 200);
  const slug = slugify(q);

  let top = null;
  const matches = await screenerSearchLite(q);
  if (matches.length) top = matches[0];

  let out = null;
  try {
    const prompt =
      `User searched: "${q}".\nScreener top match (Indian listed): ${top?.name || 'none'}.\n` +
      `Return STRICT JSON: {"kind":"company"|"industry","business_definition":"one line","canonical_name":"..."}`;
    const r = await callBedrockQuickJSON(RESOLVE_SYSTEM, prompt, { env, attempts: 2, timeoutMs: 15000 });
    out = r.json;
  } catch (e) {
    // fall through to heuristic
  }

  const kind = out?.kind === 'company' || out?.kind === 'industry' ? out.kind : (top ? 'company' : 'industry');
  const business_definition = (out?.business_definition && String(out.business_definition).trim()) || q;
  return json({ kind, business_definition, canonical_name: out?.canonical_name || top?.name || q, slug });
}

function clientIp(request) {
  return request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'unknown';
}

// Optional access-code gate. Enabled only when RUN_ACCESS_CODE secret is set.
// The UI asks for the code once and sends it as the `x-run-code` header (A6).
function accessCodeError(env, request, body) {
  const code = env.RUN_ACCESS_CODE;
  if (!code) return null;
  const provided = request.headers.get('x-run-code') || body?.code || '';
  if (provided === code) return null;
  return { need_code: true, error: 'A run access code is required for this deployment.' };
}

// Durable per-IP + global daily rate limit via Cloudflare KV. Enabled only when
// a KV namespace is bound as env.RATE_LIMIT (see README/wrangler for the binding).
// Never-fails: a KV hiccup must not block a legitimate run (A6).
async function checkRateLimit(env, request) {
  const kv = env.RATE_LIMIT;
  if (!kv) return { ok: true, skipped: true };
  try {
    const day = new Date().toISOString().slice(0, 10);
    const ip = clientIp(request);
    const perIpCap = Number(env.RATE_LIMIT_PER_IP || 20);
    const dailyCap = Number(env.RATE_LIMIT_DAILY || 200);
    const ipKey = `rl:ip:${ip}:${day}`;
    const gKey = `rl:global:${day}`;
    const [ipRaw, gRaw] = await Promise.all([kv.get(ipKey), kv.get(gKey)]);
    const ipN = Number(ipRaw || 0);
    const gN = Number(gRaw || 0);
    if (ipN >= perIpCap) return { ok: false, reason: `Per-IP daily run limit (${perIpCap}) reached — try again tomorrow.` };
    if (gN >= dailyCap) return { ok: false, reason: `Global daily run limit (${dailyCap}) reached — try again tomorrow.` };
    await Promise.all([
      kv.put(ipKey, String(ipN + 1), { expirationTtl: 172800 }),
      kv.put(gKey, String(gN + 1), { expirationTtl: 172800 }),
    ]);
    return { ok: true };
  } catch {
    return { ok: true, skipped: true };
  }
}

async function handleRun(request, env) {
  const body = await readBody(request);
  const q = (body.query || '').trim();
  const slug = slugify(q);
  const dispatched_at = new Date().toISOString();
  const repo = env.GITHUB_REPO;
  const token = env.GITHUB_TOKEN;
  const workflow = env.GITHUB_WORKFLOW_FILE || 'peer-run.yml';
  const ref = env.GITHUB_DEFAULT_REF || 'main';

  if (!q) return json({ dispatched: false, slug, error: 'query required' }, 200);

  // Abuse controls (both optional; at least one recommended in production).
  const codeErr = accessCodeError(env, request, body);
  if (codeErr) return json({ dispatched: false, slug, ...codeErr }, 200);
  const rl = await checkRateLimit(env, request);
  if (!rl.ok) return json({ dispatched: false, slug, rate_limited: true, error: rl.reason }, 200);

  if (!repo || !token) {
    return json({
      dispatched: false,
      slug,
      dispatched_at,
      manual: {
        message: 'Automatic dispatch is not configured (GITHUB_TOKEN / GITHUB_REPO unset on the Worker).',
        steps: [
          `Open GitHub Actions in ${repo || '<your repo>'} -> "peer-run".`,
          `Run workflow with input query = "${q}".`,
          'When it commits public/data/runs/' + slug + '.json, this page will load it automatically.',
        ],
      },
    }, 200);
  }

  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/${workflow}/dispatches`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'peerfinder-worker',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ref, inputs: { query: q } }),
    });
    if (res.status === 204) return json({ dispatched: true, slug, ref, dispatched_at });
    const detail = await res.text().catch(() => '');
    return json({
      dispatched: false,
      slug,
      error: `GitHub dispatch HTTP ${res.status}`,
      detail: detail.slice(0, 300),
      hint: 'Ensure the workflow exists on the default branch and the token has actions:write.',
    }, 200);
  } catch (e) {
    return json({ dispatched: false, slug, error: String(e?.message || e) }, 200);
  }
}

async function assetExists(env, request, slug) {
  try {
    const origin = new URL(request.url).origin;
    const res = await env.ASSETS.fetch(new Request(`${origin}/data/runs/${slug}.json`, { headers: { 'cache-control': 'no-cache' } }));
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    return data;
  } catch { return null; }
}

// Find the workflow run for THIS dispatch (the earliest run created at/after the
// dispatch time), not merely the repo's latest run (A5b). Falls back to the most
// recent run only when no dispatch time is known (e.g. a deep-link poll).
async function runStateForDispatch(env, sinceMs) {
  const repo = env.GITHUB_REPO;
  const token = env.GITHUB_TOKEN;
  const workflow = env.GITHUB_WORKFLOW_FILE || 'peer-run.yml';
  if (!repo || !token) return null;
  try {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/actions/workflows/${workflow}/runs?event=workflow_dispatch&per_page=20`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'peerfinder-worker',
        },
      }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const runs = data?.workflow_runs || [];
    if (!runs.length) return null;
    let run;
    if (Number.isFinite(sinceMs)) {
      // The run we triggered is the first one created at/after our dispatch
      // (allow ~60s clock skew). If none yet, this dispatch has not started.
      const ours = runs
        .filter((r) => Date.parse(r.created_at) >= sinceMs - 60000)
        .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
      run = ours[0];
      if (!run) return { status: 'queued', conclusion: null };
    } else {
      run = runs[0];
    }
    return { status: run.status, conclusion: run.conclusion, created_at: run.created_at };
  } catch { return null; }
}

// Non-success terminal conclusions all map to "failed" (A5c).
const NON_SUCCESS = new Set(['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure', 'stale', 'neutral', 'skipped']);

async function handleStatus(request, env) {
  const url = new URL(request.url);
  // Validate the PRESENCE of the query param, not the normalized slug (A5d):
  // a legit query that happens to slugify oddly must not be rejected.
  const rawSlug = url.searchParams.get('slug');
  if (!rawSlug || !rawSlug.trim()) return json({ state: 'starting' });
  const slug = slugify(rawSlug);
  const since = url.searchParams.get('since');
  const sinceMs = since ? Date.parse(since) : NaN;

  const data = await assetExists(env, request, slug);
  if (data) {
    // Only "done" if the committed file was generated AFTER this dispatch — a
    // pre-existing older file must NOT short-circuit a freshly queued run (A5a).
    const genMs = Date.parse(data.meta?.generated_at || '');
    const fresh = !Number.isFinite(sinceMs) || (Number.isFinite(genMs) && genMs >= sinceMs - 1000);
    if (fresh) {
      const b = data.buckets || {};
      return json({
        state: 'done',
        slug,
        generated_at: data.meta?.generated_at || null,
        counts: {
          india_listed: (b.india_listed || []).length,
          global_listed: (b.global_listed || []).length,
          india_private: (b.india_private || []).length,
        },
      });
    }
    // else: stale pre-existing file — treat as still running below.
  }

  const gh = await runStateForDispatch(env, sinceMs);
  if (gh) {
    if (gh.status === 'queued' || gh.status === 'in_progress') return json({ state: 'running', slug });
    if (gh.status === 'completed' && gh.conclusion && gh.conclusion !== 'success') {
      if (NON_SUCCESS.has(gh.conclusion)) return json({ state: 'failed', slug, conclusion: gh.conclusion });
    }
    // completed+success but file not yet visible -> still committing/deploying.
  }
  return json({ state: 'running', slug });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;
    try {
      if (pathname === '/api/resolve' && request.method === 'POST') return await handleResolve(request, env);
      if (pathname === '/api/run' && request.method === 'POST') return await handleRun(request, env);
      if (pathname === '/api/run-status' && request.method === 'GET') return await handleStatus(request, env);
      if (pathname.startsWith('/api/')) return json({ error: 'not found' }, 404);
      // Everything else -> static assets.
      return env.ASSETS.fetch(request);
    } catch (e) {
      // Never-fail: for API return friendly JSON, else fall back to assets.
      if (pathname.startsWith('/api/')) return json({ error: 'internal', detail: String(e?.message || e) }, 200);
      try { return await env.ASSETS.fetch(request); } catch { return new Response('error', { status: 200 }); }
    }
  },
};
