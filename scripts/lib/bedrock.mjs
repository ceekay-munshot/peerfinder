// scripts/lib/bedrock.mjs
// Claude on Amazon Bedrock via the CONVERSE endpoint + Bearer key.
// NO AWS SDK, NO SigV4 — a plain HTTPS POST with an Authorization: Bearer token.
// Reused by both the GitHub Actions pipeline (patient retry) and the Worker (quick).

import { sleep, log, warn } from './util.mjs';

// `process` is undefined in a Worker without nodejs_compat, so guard the access.
const ENV = typeof process !== 'undefined' && process.env ? process.env : {};

const DEFAULT_MODELS = 'anthropic.claude-sonnet-5,us.anthropic.claude-sonnet-5';

function cfg(env) {
  env = env || ENV || {};
  const region = env.AWS_REGION || 'us-east-1';
  const apiKey = env.BEDROCK_API_KEY || '';
  const models = String(env.BEDROCK_MODEL_IDS || DEFAULT_MODELS)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return { region, apiKey, models };
}

// One Converse attempt against ONE model.
// Returns { ok:true, text } on 200-with-text, else { ok:false, retryable, status? }.
async function converseOnce({ region, apiKey, model, system, user, timeoutMs }) {
  const url =
    `https://bedrock-runtime.${region}.amazonaws.com/model/` +
    `${encodeURIComponent(model)}/converse`;
  const body = {
    system: [{ text: system }],
    messages: [{ role: 'user', content: [{ text: user }] }],
    inferenceConfig: { temperature: 0, maxTokens: 16000 },
  };
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    if (res.status === 200) {
      const data = await res.json();
      const text = (data?.output?.message?.content || [])
        .map((c) => c?.text || '')
        .join('')
        .trim();
      if (text) return { ok: true, text };
      return { ok: false, retryable: false, status: 200 }; // empty -> model unusable
    }
    // 429 or >=500 => busy (retryable); 400/403/404 => model unusable (skip to next).
    const retryable = res.status === 429 || res.status >= 500;
    let detail = '';
    try { detail = (await res.text()).slice(0, 300); } catch {}
    warn(`bedrock ${model} HTTP ${res.status} ${detail}`);
    return { ok: false, retryable, status: res.status };
  } catch (err) {
    // network / timeout -> retryable
    warn(`bedrock ${model} error: ${err?.message || err}`);
    return { ok: false, retryable: true, status: 0 };
  } finally {
    clearTimeout(t);
  }
}

// One pass over the model fallback chain. Returns { text, model } or null.
async function modelLoop({ region, apiKey, models, system, user, timeoutMs }) {
  for (const model of models) {
    const r = await converseOnce({ region, apiKey, model, system, user, timeoutMs });
    if (r.ok) return { text: r.text, model };
    // any non-ok (busy or unusable) -> fall through to the next model in the chain
  }
  return null;
}

// PATIENT retry for the pipeline (no time wall): ~15 waves, 60s between waves,
// 5-min timeout per attempt. Throws only after every wave is exhausted.
export async function callBedrock(system, user, opts = {}) {
  const {
    env,
    waves = 15,
    waveGapMs = 60_000,
    timeoutMs = 5 * 60 * 1000,
  } = opts;
  const { region, apiKey, models } = cfg(env);
  if (!apiKey) throw new Error('BEDROCK_API_KEY is not set');
  for (let w = 0; w < waves; w++) {
    const out = await modelLoop({ region, apiKey, models, system, user, timeoutMs });
    if (out) {
      log(`bedrock ok via ${out.model} (wave ${w + 1}/${waves})`);
      return out;
    }
    if (w < waves - 1) {
      warn(`bedrock: all models busy/unusable — wave ${w + 1}/${waves}, sleeping ${waveGapMs}ms`);
      await sleep(waveGapMs);
    }
  }
  throw new Error(`bedrock exhausted ${waves} waves across models [${models.join(', ')}]`);
}

// TRIMMED version for the Worker's short /api/resolve call: 2–3 attempts, no long waves.
export async function callBedrockQuick(system, user, opts = {}) {
  const { env, attempts = 3, timeoutMs = 20_000 } = opts;
  const { region, apiKey, models } = cfg(env);
  if (!apiKey) throw new Error('BEDROCK_API_KEY is not set');
  for (let i = 0; i < attempts; i++) {
    const out = await modelLoop({ region, apiKey, models, system, user, timeoutMs });
    if (out) return out;
    if (i < attempts - 1) await sleep(1000 * (i + 1));
  }
  throw new Error('bedrock quick call failed after retries');
}

// Slice the outermost {...} and repair common truncation, then JSON.parse.
// Best-effort: balances open strings/brackets and drops trailing junk.
export function repairJson(text) {
  let s = String(text || '').trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const start = s.indexOf('{');
  if (start === -1) throw new Error('no JSON object found in model output');
  s = s.slice(start);

  // 1) Try the largest {...} span directly.
  const lastBrace = s.lastIndexOf('}');
  if (lastBrace > 0) {
    try { return JSON.parse(s.slice(0, lastBrace + 1)); } catch { /* fall through */ }
  }

  // 2) Repair: walk the string, track string state + bracket stack, then close.
  const stack = [];
  let inStr = false;
  let esc = false;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    out += ch;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') stack.pop();
  }
  if (inStr) out += '"';                 // close a dangling string
  out = out.replace(/,\s*$/, '');        // drop a trailing comma
  if (/:\s*$/.test(out)) out += 'null';  // "key": <cut> -> "key": null
  while (stack.length) out += stack.pop(); // close open brackets/braces
  out = out.replace(/,(\s*[}\]])/g, '$1'); // remove trailing commas before close
  return JSON.parse(out);
}

// Patient JSON call. Returns { json, model, raw, error? }; json is null if unparseable.
export async function callBedrockJSON(system, user, opts = {}) {
  const { text, model } = await callBedrock(system, user, opts);
  try {
    return { json: repairJson(text), model, raw: text };
  } catch (e) {
    warn(`callBedrockJSON parse failed: ${e.message}`);
    return { json: null, model, raw: text, error: e.message };
  }
}

// Quick JSON call for the Worker.
export async function callBedrockQuickJSON(system, user, opts = {}) {
  const { text, model } = await callBedrockQuick(system, user, opts);
  try {
    return { json: repairJson(text), model, raw: text };
  } catch (e) {
    return { json: null, model, raw: text, error: e.message };
  }
}
