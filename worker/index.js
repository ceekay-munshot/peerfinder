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

async function handleRun(request, env) {
  const { query } = await readBody(request);
  const q = (query || '').trim();
  const slug = slugify(q);
  const repo = env.GITHUB_REPO;
  const token = env.GITHUB_TOKEN;
  const workflow = env.GITHUB_WORKFLOW_FILE || 'peer-run.yml';
  const ref = env.GITHUB_DEFAULT_REF || 'main';

  if (!q) return json({ dispatched: false, slug, error: 'query required' }, 200);

  if (!repo || !token) {
    return json({
      dispatched: false,
      slug,
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
    if (res.status === 204) return json({ dispatched: true, slug, ref });
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

async function latestRunState(env) {
  const repo = env.GITHUB_REPO;
  const token = env.GITHUB_TOKEN;
  const workflow = env.GITHUB_WORKFLOW_FILE || 'peer-run.yml';
  if (!repo || !token) return null;
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/${workflow}/runs?per_page=1`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'peerfinder-worker',
      },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const run = data?.workflow_runs?.[0];
    if (!run) return null;
    return { status: run.status, conclusion: run.conclusion };
  } catch { return null; }
}

async function handleStatus(request, env) {
  const url = new URL(request.url);
  const slug = slugify(url.searchParams.get('slug') || '');
  if (!slug || slug === 'run') return json({ state: 'starting', slug });

  const data = await assetExists(env, request, slug);
  if (data) {
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

  // Not committed yet — best-effort state from the latest workflow run.
  const gh = await latestRunState(env);
  if (gh) {
    if (gh.status === 'queued' || gh.status === 'in_progress') return json({ state: 'running', slug });
    if (gh.status === 'completed' && gh.conclusion === 'failure') return json({ state: 'failed', slug });
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
