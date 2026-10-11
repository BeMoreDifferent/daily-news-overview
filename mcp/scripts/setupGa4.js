#!/usr/bin/env node
// One-time GA4 setup for the MCP server via the Google Analytics Admin API (idempotent):
//   1. find or create a web data stream "MCP server" in the property (so MCP traffic can be
//      filtered with the Stream name dimension, separate from the website),
//   2. create a Measurement Protocol API secret on it (only if GA_API_SECRET is not set yet),
//   3. register the custom dimensions and metrics the MCP events use, so every parameter is
//      usable in standard reports and explorations,
//   4. write GA_MEASUREMENT_ID / GA_API_SECRET to the repo-root .env (gitignored).
//
// Needs: GA_PROPERTY_ID (numeric) and GA_ADMIN_TOKEN, an OAuth access token with the
// https://www.googleapis.com/auth/analytics.edit scope (e.g. from the OAuth 2.0 Playground).
// Usage (from mcp/): npm run ga:setup        then: npm run ga:push

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ENV_PATH = fileURLToPath(new URL('../../.env', import.meta.url));
const API = 'https://analyticsadmin.googleapis.com/v1beta';
const STREAM_NAME = 'MCP server';
const STREAM_URI = 'https://daily-news-mcp.bemoredifferent.workers.dev';

export const CUSTOM_DIMENSIONS = [
  ['mcp_method', 'MCP method', 'JSON-RPC method (tools/call, tools/list, initialize, ...)'],
  ['tool_name', 'MCP tool', 'Tool called (get_daily_news, get_topic)'],
  ['mcp_client', 'MCP client', 'Client software (known products only, otherwise "other")'],
  ['mcp_client_version', 'MCP client version', 'Declared client version, major.minor'],
  ['mcp_era', 'MCP era', 'modern (2026-07-28, stateless) or legacy (initialize-based)'],
  ['protocol_version', 'MCP protocol version', 'Negotiated MCP protocol revision'],
  ['outcome', 'MCP outcome', 'success, tool_error or protocol_error'],
  ['error_code', 'MCP error code', 'JSON-RPC error code of protocol errors'],
  ['http_status', 'MCP HTTP status', 'HTTP status of the error response'],
  ['days_ago', 'Briefing age (days)', 'Days between the requested briefing and the request'],
  // Shared with the website's story events; reused if the site already registered them.
  ['story_date', 'Story date', 'Briefing date of the story'],
  ['story_rank', 'Story rank', 'Position of the story in its briefing'],
  ['story_title', 'Story title', 'English story title'],
  ['story_category', 'Story category', 'Story category'],
  ['story_keywords', 'Story keywords', 'Top story keywords'],
];

export const CUSTOM_METRICS = [
  ['latency_ms', 'MCP latency', 'Server processing time of the request', 'MILLISECONDS'],
  ['result_count', 'MCP result count', 'Items returned by a tool call', 'STANDARD'],
  ['story_outlets', 'Story outlets', 'Number of outlets covering the story', 'STANDARD'],
];

const { GA_PROPERTY_ID: propertyId, GA_ADMIN_TOKEN: token } = process.env;

async function api(path, init = {}) {
  const res = await fetch(`${API}/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...init.headers },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${init.method || 'GET'} ${path}: ${res.status} ${body.error?.message || ''}`);
  return body;
}

async function listAll(path, key) {
  const items = [];
  let pageToken = '';
  do {
    const page = await api(`${path}?pageSize=200${pageToken ? `&pageToken=${pageToken}` : ''}`);
    items.push(...(page[key] || []));
    pageToken = page.nextPageToken || '';
  } while (pageToken);
  return items;
}

function updateEnv(values) {
  let text = readFileSync(ENV_PATH, 'utf8');
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${value}`;
    text = new RegExp(`^${key}=.*$`, 'm').test(text)
      ? text.replace(new RegExp(`^${key}=.*$`, 'm'), line)
      : `${text.replace(/\n?$/, '\n')}${line}\n`;
  }
  writeFileSync(ENV_PATH, text);
}

async function main() {
  if (!propertyId || !token) {
    console.error('Set GA_PROPERTY_ID and GA_ADMIN_TOKEN (OAuth token with analytics.edit scope).');
    process.exit(1);
  }
  const property = `properties/${propertyId}`;

  const streams = await listAll(`${property}/dataStreams`, 'dataStreams');
  let stream = streams.find(s => s.displayName === STREAM_NAME);
  if (!stream) {
    stream = await api(`${property}/dataStreams`, {
      method: 'POST',
      body: JSON.stringify({ type: 'WEB_DATA_STREAM', displayName: STREAM_NAME, webStreamData: { defaultUri: STREAM_URI } }),
    });
    console.log(`created data stream "${STREAM_NAME}"`);
  }
  const measurementId = stream.webStreamData.measurementId;
  console.log(`stream ${stream.name} -> ${measurementId}`);

  const env = { GA_MEASUREMENT_ID: measurementId };
  if (!process.env.GA_API_SECRET) {
    const secret = await api(`${stream.name}/measurementProtocolSecrets`, {
      method: 'POST',
      body: JSON.stringify({ displayName: 'daily-news-mcp worker' }),
    });
    env.GA_API_SECRET = secret.secretValue;
    console.log('created Measurement Protocol API secret');
  }
  updateEnv(env);
  console.log('wrote GA_MEASUREMENT_ID / GA_API_SECRET to .env');

  const dims = await listAll(`${property}/customDimensions`, 'customDimensions');
  const metrics = await listAll(`${property}/customMetrics`, 'customMetrics');
  const registered = new Set([...dims, ...metrics].map(d => d.parameterName));
  for (const [parameterName, displayName, description] of CUSTOM_DIMENSIONS) {
    if (registered.has(parameterName)) continue;
    await api(`${property}/customDimensions`, { method: 'POST', body: JSON.stringify({ parameterName, displayName, description, scope: 'EVENT' }) });
    console.log(`+ dimension ${parameterName}`);
  }
  for (const [parameterName, displayName, description, measurementUnit] of CUSTOM_METRICS) {
    if (registered.has(parameterName)) continue;
    await api(`${property}/customMetrics`, { method: 'POST', body: JSON.stringify({ parameterName, displayName, description, measurementUnit, scope: 'EVENT' }) });
    console.log(`+ metric ${parameterName}`);
  }
  console.log('GA4 setup complete. Next: npm run ga:push');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    console.error(err.message);
    process.exit(1);
  });
}
