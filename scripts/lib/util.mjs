// scripts/lib/util.mjs
// Low-level shared helpers: sleep, jitter, retry/backoff, resilient fetch,
// number parsing, slug, logging. No external deps — safe in Node and Workers.

export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Random gap between ~min and ~max ms (polite, human-like pacing).
export function jitter(min = 300, max = 2000) {
  return Math.floor(min + Math.random() * Math.max(0, max - min));
}

export function slugify(s) {
  const out = String(s || '')
    .toLowerCase()
    .trim()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return out || 'run';
}

export function nowIso() {
  return new Date().toISOString();
}

export function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

export function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

export function warn(...args) {
  console.warn(`[${new Date().toISOString()}] WARN`, ...args);
}

// Parse a messy financial string ("₹ 1,234 Cr.", "12.3%", "(45)", "1,23,456")
// into a Number, or null when it is not a real number. NEVER returns 0 for blanks.
export function parseNum(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  let s = String(raw).trim();
  if (!s || s === '-' || s === '--' || /^n\/?a$/i.test(s)) return null;
  const neg = /^\(.*\)$/.test(s); // accounting negatives
  s = s.replace(/[(),%₹$€£¥\s]/g, '').replace(/cr\.?|crores?|bn|mn|k/gi, '');
  if (s === '' || s === '.' || s === '-') return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

// A year-ish label ("Mar 2023", "2023", "FY23", "Mar-23") -> integer year or null.
export function parseYear(label) {
  if (!label) return null;
  const s = String(label);
  const full = s.match(/(19|20)\d{2}/);
  if (full) return Number(full[0]);
  const fy = s.match(/(?:FY|')\s?(\d{2})/i);
  if (fy) return 2000 + Number(fy[1]);
  return null;
}

// Generic retry with exponential backoff. fn receives the attempt index.
export async function withRetry(fn, opts = {}) {
  const { attempts = 4, baseMs = 2000, label = 'op', onError } = opts;
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn(i);
    } catch (err) {
      lastErr = err;
      if (onError) {
        try { onError(err, i); } catch {}
      }
      warn(`${label} attempt ${i + 1}/${attempts} failed: ${err?.message || err}`);
      if (i < attempts - 1) await sleep(baseMs * Math.pow(2, i));
    }
  }
  throw lastErr;
}

// fetch() with timeout + retry/backoff. Treats 429 and >=500 as retryable.
// Returns the Response (caller inspects .ok / status). Throws only after all tries.
export async function fetchWithRetry(url, init = {}, opts = {}) {
  const {
    attempts = 4,
    baseMs = 1000,
    timeoutMs = 30000,
    label = 'fetch',
    retryStatuses = null, // default: 429 + >=500
  } = opts;
  return withRetry(
    async () => {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), timeoutMs);
      try {
        const res = await fetch(url, {
          ...init,
          headers: { 'user-agent': BROWSER_UA, ...(init.headers || {}) },
          signal: ac.signal,
        });
        const retry = retryStatuses
          ? retryStatuses.includes(res.status)
          : res.status === 429 || res.status >= 500;
        if (!res.ok && retry) throw new Error(`${label} HTTP ${res.status}`);
        return res;
      } finally {
        clearTimeout(t);
      }
    },
    { attempts, baseMs, label }
  );
}

export async function fetchJson(url, init = {}, opts = {}) {
  const res = await fetchWithRetry(url, init, { label: 'fetchJson', ...opts });
  if (!res.ok) throw new Error(`fetchJson HTTP ${res.status} for ${url}`);
  return res.json();
}

export async function fetchText(url, init = {}, opts = {}) {
  const res = await fetchWithRetry(url, init, { label: 'fetchText', ...opts });
  if (!res.ok) throw new Error(`fetchText HTTP ${res.status} for ${url}`);
  return res.text();
}

// Rotate Yahoo query host to spread rate-limits.
export function yahooHost(i = 0) {
  return i % 2 === 0 ? 'query1.finance.yahoo.com' : 'query2.finance.yahoo.com';
}

// Round to n decimals, keeping null for null.
export function round(n, d = 2) {
  if (n === null || n === undefined || !Number.isFinite(n)) return null;
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
}
