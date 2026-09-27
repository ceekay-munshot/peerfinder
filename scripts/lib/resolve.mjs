// scripts/lib/resolve.mjs
// Turn the search box input (a COMPANY or an INDUSTRY) into a canonical,
// one-line BUSINESS DEFINITION that drives the true-peer finder.
//
//   Company  -> read screener "About" + meta summary, ask the LLM for a
//               one-line business definition + main segment/products.
//   Industry -> use the phrase directly.
//
// The slug is always derived from the RAW query so the Worker (/api/resolve)
// and the pipeline agree on where <slug>.json will live.

import { fetchJson, fetchText, slugify, warn, log, BROWSER_UA } from './util.mjs';
import { callBedrockJSON } from './bedrock.mjs';

// Screener's public search API. Returns [{ id, name, url }].
// By default it swallows transient failures and returns [] (a genuine "no
// match" and a network/403/429 look the same). Pass { throwOnError: true } to
// have the caller distinguish a failed lookup from an empty result (see A1).
export async function screenerSearch(q, { throwOnError = false } = {}) {
  try {
    const url = `https://www.screener.in/api/company/search/?q=${encodeURIComponent(q)}`;
    const data = await fetchJson(url, { headers: { 'user-agent': BROWSER_UA } },
      { attempts: 3, timeoutMs: 15000, label: 'screener-search' });
    if (Array.isArray(data)) {
      return data.map((d) => ({ id: d.id, name: d.name, url: d.url })).filter((d) => d.name);
    }
    return [];
  } catch (e) {
    warn(`screenerSearch failed for "${q}": ${e.message}`);
    if (throwOnError) throw e;
    return [];
  }
}

// Pull a short "About" summary from a screener company page (public, no login).
async function fetchAboutSnippet(companyUrl) {
  try {
    const url = companyUrl.startsWith('http') ? companyUrl : `https://www.screener.in${companyUrl}`;
    const html = await fetchText(url, { headers: { 'user-agent': BROWSER_UA } },
      { attempts: 2, timeoutMs: 15000, label: 'screener-about' });
    const parts = [];
    const meta = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
    if (meta) parts.push(meta[1]);
    // The "About" paragraph lives in the company profile block.
    const about = html.match(/class="[^"]*about[^"]*"[^>]*>([\s\S]{0,1200}?)<\/div>/i);
    if (about) {
      const text = about[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (text) parts.push(text);
    }
    return parts.join(' — ').slice(0, 1500);
  } catch (e) {
    warn(`fetchAboutSnippet failed: ${e.message}`);
    return '';
  }
}

const SYSTEM = `You are an equity research analyst. You produce precise, one-line business definitions used to find TRUE peer companies. Be specific about WHAT the company/industry actually makes, sells or does and its core segment. Reply with STRICT JSON only, no prose.`;

function buildPrompt(query, matchName, snippet) {
  return `The user searched this in a peer-benchmarking tool: "${query}".

Screener top match (Indian listed): ${matchName || 'none found'}.
About / summary snippet (may be empty or noisy): ${snippet || 'none'}.

Decide whether the search is a COMPANY or an INDUSTRY, then return STRICT JSON:
{
  "kind": "company" | "industry",
  "canonical_name": "clean company or industry name",
  "business_definition": "ONE precise line describing the core business / what is made or sold",
  "main_segment": "primary segment or product category",
  "products": ["key product / service", "..."]
}
Rules: base it on the snippet when present; do not invent specifics you are unsure of; keep business_definition to a single line.`;
}

// Resolve the input. Never throws — falls back to sensible defaults.
export async function resolveInput(query, { env } = {}) {
  const slug = slugify(query);
  let matches = [];
  try { matches = await screenerSearch(query); } catch { matches = []; }
  const top = matches[0] || null;
  let snippet = '';
  if (top?.url) snippet = await fetchAboutSnippet(top.url);

  let json = null;
  try {
    const r = await callBedrockJSON(SYSTEM, buildPrompt(query, top?.name, snippet), {
      env, waves: 6, waveGapMs: 30_000, timeoutMs: 90_000,
    });
    json = r.json;
    log(`resolve via ${r.model || 'n/a'}: kind=${json?.kind}`);
  } catch (e) {
    warn(`resolve LLM failed: ${e.message}`);
  }

  // Fallbacks that never fail. Trust the LLM classification when usable. When it
  // is NOT (call failed / unparseable), a bare screener hit is NOT enough to call
  // the query a "company": only do so if the hit NAME matches the query. Otherwise
  // treat it as an INDUSTRY and keep the query itself as the definition, so
  // "cement" / "ceramic tiles" don't benchmark one arbitrary company (A3).
  const norm = (s) => String(s || '').toLowerCase()
    .replace(/\b(ltd|limited|inc|corp|corporation|co|company|plc|holdings|group|industries|the)\b/g, '')
    .replace(/[^a-z0-9]+/g, '').trim();
  const nameMatches = (a, b) => {
    const na = norm(a), nb = norm(b);
    if (!na || !nb) return false;
    return na === nb || (na.length >= 4 && (na.includes(nb) || nb.includes(na)));
  };

  let kind, canonical_name, business_definition;
  if (json?.kind === 'company' || json?.kind === 'industry') {
    kind = json.kind;
    canonical_name = json.canonical_name || top?.name || query;
    business_definition = (json.business_definition && String(json.business_definition).trim()) || snippet || query;
  } else if (top && nameMatches(top.name, query)) {
    kind = 'company';
    canonical_name = top.name;
    business_definition = String(snippet || '').trim() || query;
  } else {
    kind = 'industry';
    canonical_name = query;
    business_definition = query; // keep the original query as the definition
  }

  return {
    slug,
    kind,
    query,
    canonical_name,
    business_definition,
    main_segment: json?.main_segment || null,
    products: Array.isArray(json?.products) ? json.products : [],
    screener_match: top || null,
  };
}
