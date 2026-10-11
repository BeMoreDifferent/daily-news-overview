// Cloudflare Worker entry: a stateless MCP endpoint in front of the static news JSON that GitHub
// Pages serves. Pages cannot answer POST (it returns 405), so this is the smallest piece of compute
// that makes the exports reachable as an MCP server. GitHub stays the single source of truth.

import { buildPayload, sendPayload } from './analytics.js';
import { handleRequest } from './protocol.js';

const DAY_SECONDS = 24 * 60 * 60;
const FRESH_SECONDS = 10 * 60;

// Exports older than two days are final; the most recent days can still appear or change.
function cacheTtl(path) {
  const m = /^(\d{4}-\d{2}-\d{2})\.json$/.exec(path);
  if (!m) return FRESH_SECONDS;
  const ageDays = (Date.now() - Date.parse(`${m[1]}T00:00:00Z`)) / (DAY_SECONDS * 1000);
  return ageDays > 2 ? DAY_SECONDS : FRESH_SECONDS;
}

// Parsed exports are kept per isolate: a warm request skips both the subrequest and JSON.parse,
// which keeps CPU time far below the free plan's 10 ms per request. Bounded so memory stays small.
const MEMO_MAX = 40;
const memo = new Map();

function newsFetcher(baseUrl) {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return async path => {
    const hit = memo.get(path);
    if (hit && hit.expires > Date.now()) return hit.data;
    const ttl = cacheTtl(path);
    const data = fetch(base + path, { cf: { cacheTtl: ttl, cacheEverything: true } }).then(res => {
      // A missing day is an answer, not a failure: the tools turn null into a helpful message.
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
      return res.json();
    });
    // Store the promise so concurrent lookups share one fetch; forget it if it fails.
    memo.delete(path);
    memo.set(path, { data, expires: Date.now() + ttl * 1000 });
    data.catch(() => memo.get(path)?.data === data && memo.delete(path));
    while (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value);
    return data;
  };
}

export default {
  async fetch(request, env, ctx) {
    const config = {
      allowedOrigins: (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),
    };
    const context = {
      fetchJson: newsFetcher(env.NEWS_BASE_URL),
      rateLimit: env.RATE_LIMITER
        ? async req => (await env.RATE_LIMITER.limit({ key: req.headers.get('cf-connecting-ip') || 'unknown' })).success
        : undefined,
      // GA4 is sent after the response (waitUntil), so it adds no latency. Off unless both are set.
      track: env.GA_MEASUREMENT_ID && env.GA_API_SECRET
        ? obs => ctx.waitUntil(sendPayload(
          buildPayload({ ...obs, country: request.cf?.country }),
          { measurementId: env.GA_MEASUREMENT_ID, apiSecret: env.GA_API_SECRET },
        ))
        : undefined,
    };
    return handleRequest(request, config, context);
  },
};
