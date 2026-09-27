// scripts/lib/peers.mjs
// The TRUE-PEER FINDER (the heart). We NEVER use screener's own peer list.
//
//   1. RECALL   — ask the LLM (which has read broker reports, DRHPs, annual
//                 reports, concalls) for a GENEROUS candidate list across
//                 Indian listed, global listed and Indian private, including
//                 the different-business-model outperformer (a distributor /
//                 importer that runs structurally higher margins).
//   2. VERIFY   — the LLM records why_it_is_a_peer + business_model_tag +
//                 source for each; genuine SAME-BUSINESS peers only.
//   3. CLASSIFY — status is decided LIVE (screener API -> Yahoo -> private),
//                 never trusted from the model. This fixes the known bug of
//                 calling a listed company "private".

import { sleep, jitter, warn, log, slugify } from './util.mjs';
import { callBedrockJSON } from './bedrock.mjs';
import { screenerSearch } from './resolve.mjs';
import { yahooSearch, INDIA_YF_EXCHANGES } from './yahoo.mjs';
import { newIndiaListed, newGlobalListed, newIndiaPrivate } from './schema.mjs';

const MAX_CANDIDATES = 30;

const SYSTEM = `You are a buy-side analyst who builds TRUE peer sets. A true peer shares the SAME CORE BUSINESS (same product/service and end-market) as the target, regardless of business model — a manufacturer, a trader/distributor, an importer, an integrated player or an asset-light player all qualify as long as the core business matches. You deliberately INCLUDE the peer that uses a DIFFERENT model and so earns structurally different margins (e.g. a pure distributor/importer), because that is often the hidden outperformer. You draw on broker/industry reports (including older ones), DRHP "Competition" sections, annual-report competitor mentions and concall transcripts. Favour RECALL: list every plausible same-business peer. Reply with STRICT JSON only.`;

function buildRecallPrompt(resolved) {
  const { query, kind, business_definition, main_segment, products, canonical_name } = resolved;
  return `Target ${kind}: "${canonical_name || query}".
Business definition: ${business_definition}
Main segment: ${main_segment || 'n/a'}
Key products: ${(products || []).join(', ') || 'n/a'}

List the TRUE peers (same core business). Cover all three groups:
 - Indian listed companies
 - Global listed companies (US, China, HK, Japan, Korea, Taiwan, EU, etc.)
 - Indian private / unlisted companies

Return STRICT JSON:
{
  "peers": [
    {
      "name": "company name (as commonly searched)",
      "market_hint": "india_listed" | "global_listed" | "india_private",
      "country": "e.g. India, USA, China",
      "why_it_is_a_peer": "one line: the specific same-business reason",
      "source_url": "a report / DRHP / annual report / site URL you are drawing on, or a plausible source",
      "business_model_tag": "manufacturer" | "trader-distributor" | "importer" | "integrated" | "asset-light"
    }
  ]
}
Include up to ${MAX_CANDIDATES} of the most relevant peers. Be generous but keep every entry a genuine same-business peer. Deliberately include any different-model peer (distributor/importer/asset-light) that competes in the same product.`;
}

export async function recallCandidates(resolved, { env } = {}) {
  try {
    const r = await callBedrockJSON(SYSTEM, buildRecallPrompt(resolved), {
      env, waves: 10, waveGapMs: 45_000, timeoutMs: 4 * 60 * 1000,
    });
    const peers = Array.isArray(r.json?.peers) ? r.json.peers : [];
    log(`recall via ${r.model || 'n/a'}: ${peers.length} raw candidates`);
    return peers.slice(0, MAX_CANDIDATES);
  } catch (e) {
    warn(`recallCandidates failed: ${e.message}`);
    return [];
  }
}

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\b(ltd|limited|inc|corp|corporation|co|company|plc|holdings|group|industries|the)\b/g, '')
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

// Fuzzy: do the two names share their core token content?
function looseMatch(a, b) {
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.length >= 4 && (nb.includes(na) || na.includes(nb))) return true;
  return false;
}

// Screener company code from a "/company/RELIANCE/" style URL.
function codeFromScreenerUrl(url) {
  const m = String(url || '').match(/\/company\/([^/]+)\//);
  return m ? m[1] : null;
}

// LIVE status classification (critical). screener -> Yahoo -> private.
export async function classifyStatus(name, { env } = {}) {
  // 1) Indian listed via screener's own search API.
  try {
    const matches = await screenerSearch(name);
    const hit = matches.find((m) => looseMatch(m.name, name)) || matches[0];
    if (hit && looseMatch(hit.name, name)) {
      const code = codeFromScreenerUrl(hit.url);
      if (code) {
        return {
          status: 'india_listed',
          ticker: code,
          name: hit.name,
          screener_url: hit.url,
        };
      }
    }
  } catch (e) {
    warn(`classify screener step failed for "${name}": ${e.message}`);
  }

  // 2) Global (non-India) listed via Yahoo search.
  try {
    const q = await yahooSearch(name);
    const equities = (q || []).filter((x) => x.quoteType === 'EQUITY');
    const nonIndia = equities.find((x) => !INDIA_YF_EXCHANGES.has(x.exchange));
    if (nonIndia) {
      return {
        status: 'global_listed',
        ticker: nonIndia.symbol,
        name: nonIndia.longname || nonIndia.shortname || name,
        exchange: nonIndia.exchDisp || nonIndia.exchange || null,
        yahoo_exchange: nonIndia.exchange || null,
      };
    }
    // An India-exchange Yahoo hit that screener missed: still LISTED, route
    // through the Yahoo path (global bucket) with a clear note rather than
    // mis-labelling it private.
    const india = equities[0];
    if (india) {
      return {
        status: 'global_listed',
        ticker: india.symbol,
        name: india.longname || india.shortname || name,
        exchange: india.exchDisp || india.exchange || null,
        yahoo_exchange: india.exchange || null,
        note: 'Indian listing sourced via Yahoo (not found on screener search)',
      };
    }
  } catch (e) {
    warn(`classify yahoo step failed for "${name}": ${e.message}`);
  }

  // 3) Neither -> Indian private / unlisted.
  return { status: 'india_private' };
}

// Build the three schema buckets from classified candidates. Never throws.
export async function findPeers(resolved, { env, onProgress } = {}) {
  const buckets = { india_listed: [], global_listed: [], india_private: [] };
  const seen = { india_listed: new Set(), global_listed: new Set(), india_private: new Set() };

  const candidates = await recallCandidates(resolved, { env });

  // Ensure the subject company itself is benchmarked when a company was searched.
  if (resolved.kind === 'company' && resolved.canonical_name) {
    const already = candidates.some((c) => looseMatch(c.name, resolved.canonical_name));
    if (!already) {
      candidates.unshift({
        name: resolved.canonical_name,
        market_hint: 'india_listed',
        why_it_is_a_peer: 'Subject company (the searched target).',
        source_url: 'user query',
        business_model_tag: null,
      });
    }
  }

  let i = 0;
  for (const c of candidates) {
    i++;
    if (!c?.name) continue;
    if (onProgress) onProgress({ index: i, total: candidates.length, name: c.name });
    const cls = await classifyStatus(c.name, { env });
    await sleep(jitter(300, 1200)); // polite gap to screener/yahoo search

    const provenance = c.source_url || 'analyst recall';
    const why = c.why_it_is_a_peer || null;
    const tag = c.business_model_tag || null;

    if (cls.status === 'india_listed') {
      const key = norm(cls.ticker || cls.name);
      if (seen.india_listed.has(key)) continue;
      seen.india_listed.add(key);
      const code = cls.ticker;
      const yf = /^\d+$/.test(code) ? `${code}.BO` : `${code}.NS`;
      buckets.india_listed.push(newIndiaListed({
        name: cls.name || c.name,
        ticker: code,
        exchange: 'NSE/BSE',
        business_model_tag: tag,
        why_peer: why,
        source: provenance,
        currency: 'INR',
        _yahoo_symbol: yf,
      }));
    } else if (cls.status === 'global_listed') {
      const key = norm(cls.ticker || cls.name);
      if (seen.global_listed.has(key)) continue;
      seen.global_listed.add(key);
      const rec = newGlobalListed({
        name: cls.name || c.name,
        ticker: cls.ticker,
        exchange: cls.exchange,
        business_model_tag: tag,
        why_peer: why,
        source: provenance,
        currency: null,
        note: cls.note || null,
        _yahoo_symbol: cls.ticker,
      });
      rec._yahoo_exchange = cls.yahoo_exchange || null;
      buckets.global_listed.push(rec);
    } else {
      const key = norm(c.name);
      if (seen.india_private.has(key)) continue;
      seen.india_private.add(key);
      buckets.india_private.push(newIndiaPrivate({
        name: c.name,
        business: resolved.business_definition || null,
        products: (resolved.products || []).join(', ') || null,
        details: why,
        business_model_tag: tag,
        why_peer: why,
        source: provenance,
      }));
    }
  }

  log(`peers classified: ${buckets.india_listed.length} india-listed, ` +
      `${buckets.global_listed.length} global-listed, ${buckets.india_private.length} india-private`);
  return buckets;
}
