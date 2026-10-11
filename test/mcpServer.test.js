import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeHeaderValue, handleRequest } from '../mcp/src/protocol.js';
import { TOOLS } from '../mcp/src/tools.js';

const VERSION = '2026-07-28';
const CONFIG = { allowedOrigins: ['https://claude.ai'] };

function topic(id, title, extra = {}) {
  return {
    id,
    title,
    headline: title,
    summary: `${title} summary`,
    category: 'trending',
    label: ['keyword'],
    entities: [],
    article_count: 3,
    source_count: 2,
    articles: [{ title, url: `https://news.example/${id}`, source: 'Example', published_at: '2026-10-09T10:00:00Z', description: 'Long text' }],
    ...extra,
  };
}

const NEWS = {
  '2026-10-08.json': { date: '2026-10-08', overview: { points: [] }, topics: [topic('t_old', 'Hurricane Isaias forms')] },
  '2026-10-10.json': { date: '2026-10-10', overview: { points: [] }, topics: [] },
  '2026-10-09.json': {
    date: '2026-10-09',
    generated_at: '2026-10-10T02:00:00Z',
    overview: { points: [{ text: 'Pillay wins.', stories: [1] }, { text: 'Storm.', stories: [2, 9] }] },
    topics: [topic('t_nobel', 'Navi Pillay Wins Nobel Peace Prize', { entities: ['Navi Pillay'] }), topic('t_storm', 'Hurricane Isaias strengthens')],
  },
};

const context = {
  // Like the Worker: a missing file resolves to null. "Now" is mid-day on 2026-10-10 (UTC).
  fetchJson: async path => (path in NEWS ? structuredClone(NEWS[path]) : null),
  now: Date.parse('2026-10-10T12:00:00Z'),
};

const meta = { 'io.modelcontextprotocol/protocolVersion': VERSION, 'io.modelcontextprotocol/clientCapabilities': {} };

function modernHeaders(method, name) {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': VERSION,
    'Mcp-Method': method,
    ...(name !== undefined ? { 'Mcp-Name': name } : {}),
  };
}

async function post(body, headers, ctx = context) {
  const res = await handleRequest(new Request('https://mcp.example/mcp', {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }), CONFIG, ctx);
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}

const call = (name, args, id = 1, ctx = context) => post(
  { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args, _meta: meta } },
  modernHeaders('tools/call', name),
  ctx,
);

test('server/discover lists versions, capabilities and caching hints', async () => {
  const { status, body } = await post({ jsonrpc: '2.0', id: 'd', method: 'server/discover', params: { _meta: meta } }, modernHeaders('server/discover'));
  assert.equal(status, 200);
  assert.equal(body.id, 'd');
  assert.equal(body.result.resultType, 'complete');
  assert.ok(body.result.supportedVersions.includes(VERSION));
  assert.deepEqual(body.result.capabilities, { tools: {} });
  assert.equal(body.result.cacheScope, 'public');
  assert.ok(body.result.ttlMs > 0);
  assert.equal(body.result._meta['io.modelcontextprotocol/serverInfo'].name, 'daily-news-overview');
});

test('tools/list returns every tool with schemas', async () => {
  const { status, headers, body } = await post({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: meta } }, modernHeaders('tools/list'));
  assert.equal(status, 200);
  assert.deepEqual(body.result.tools.map(t => t.name), ['get_daily_news', 'get_topic']);
  assert.match(headers.get('cache-control'), /max-age/);
  for (const tool of TOOLS) assert.equal(tool.inputSchema.type, 'object');
});

test('header validation: missing, mismatched and base64-encoded values', async () => {
  const listBody = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: meta } };
  const noMethod = modernHeaders('tools/list');
  delete noMethod['Mcp-Method'];
  assert.equal((await post(listBody, noMethod)).body.error.code, -32020);
  assert.equal((await post(listBody, modernHeaders('tools/call'))).body.error.code, -32020);

  const otherVersion = { ...modernHeaders('tools/list'), 'MCP-Protocol-Version': '2025-11-25' };
  const mismatch = await post(listBody, otherVersion);
  assert.equal(mismatch.status, 400);
  assert.equal(mismatch.body.error.code, -32020);

  const callBody = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_daily_news', arguments: {}, _meta: meta } };
  assert.equal((await post(callBody, modernHeaders('tools/call'))).body.error.code, -32020);
  assert.equal((await post(callBody, modernHeaders('tools/call', 'get_topic'))).body.error.code, -32020);
  const encoded = `=?base64?${btoa('get_daily_news')}?=`;
  assert.equal((await post(callBody, modernHeaders('tools/call', encoded))).status, 200);
  assert.equal(decodeHeaderValue('=?base64?SGVsbG8sIOS4lueVjA==?='), 'Hello, 世界');
});

test('unsupported versions, missing capabilities and unknown methods', async () => {
  const oldMeta = { ...meta, 'io.modelcontextprotocol/protocolVersion': '1900-01-01' };
  const unsupported = await post(
    { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: oldMeta } },
    { ...modernHeaders('tools/list'), 'MCP-Protocol-Version': '1900-01-01' },
  );
  assert.equal(unsupported.status, 400);
  assert.equal(unsupported.body.error.code, -32022);
  assert.equal(unsupported.body.error.data.requested, '1900-01-01');
  assert.ok(unsupported.body.error.data.supported.includes(VERSION));

  const noCaps = await post(
    { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': VERSION } } },
    modernHeaders('tools/list'),
  );
  assert.equal(noCaps.status, 400);
  assert.equal(noCaps.body.error.code, -32602);

  const unknown = await post({ jsonrpc: '2.0', id: 1, method: 'prompts/list', params: { _meta: meta } }, modernHeaders('prompts/list'));
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error.code, -32601);
});

test('malformed bodies, notifications and non-POST methods', async () => {
  assert.equal((await post('{nope', modernHeaders('x'))).body.error.code, -32700);
  assert.equal((await post([{ jsonrpc: '2.0', id: 1, method: 'ping' }], modernHeaders('ping'))).body.error.code, -32600);
  const note = await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, { 'Content-Type': 'application/json' });
  assert.equal(note.status, 202);
  assert.equal(note.body, null);

  for (const method of ['GET', 'DELETE']) {
    const res = await handleRequest(new Request('https://mcp.example/mcp', { method }), CONFIG, context);
    assert.equal(res.status, 405);
  }
});

test('Origin must be allowlisted when present', async () => {
  const body = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: meta } };
  assert.equal((await post(body, { ...modernHeaders('tools/list'), Origin: 'https://evil.example' })).status, 403);
  const allowed = await post(body, { ...modernHeaders('tools/list'), Origin: 'https://claude.ai' });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://claude.ai');
});

test('legacy clients: stateless initialize, then calls without _meta', async () => {
  const init = await post(
    { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'old', version: '1' } } },
    { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
  );
  assert.equal(init.status, 200);
  assert.equal(init.body.result.protocolVersion, '2025-06-18');
  assert.equal(init.headers.get('mcp-session-id'), null);

  const list = await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { 'Content-Type': 'application/json', 'MCP-Protocol-Version': '2025-06-18' });
  assert.equal(list.status, 200);
  assert.equal(list.body.result.resultType, undefined);
  assert.equal(list.body.result.tools.length, 2);

  const tool = await post(
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_daily_news', arguments: { date: '2026-10-09' } } },
    { 'Content-Type': 'application/json', 'MCP-Protocol-Version': '2025-11-25' },
  );
  assert.equal(tool.body.result.structuredContent.date, '2026-10-09');
});

test('get_daily_news defaults to today, falling back to yesterday until today is published', async () => {
  const day = (await call('get_daily_news', {})).body.result;
  assert.equal(day.structuredContent.date, '2026-10-10');
  assert.deepEqual(JSON.parse(day.content[0].text), day.structuredContent);

  const early = (await call('get_daily_news', {}, 1, { ...context, now: Date.parse('2026-10-11T01:00:00Z') })).body.result.structuredContent;
  assert.equal(early.date, '2026-10-10');

  const late = (await call('get_daily_news', {}, 1, { ...context, now: Date.parse('2026-10-20T12:00:00Z') })).body.result;
  assert.equal(late.isError, true);
});

test('get_daily_news reads a specific date directly, without an index', async () => {
  const fetched = [];
  const tracking = { ...context, fetchJson: path => { fetched.push(path); return context.fetchJson(path); } };
  const day = (await call('get_daily_news', { date: '2026-10-09' }, 1, tracking)).body.result.structuredContent;
  assert.equal(day.date, '2026-10-09');
  assert.deepEqual(fetched, ['2026-10-09.json']);
  assert.deepEqual(day.overview, [{ text: 'Pillay wins.', topic_ids: ['t_nobel'] }, { text: 'Storm.', topic_ids: ['t_storm'] }]);
  assert.equal(day.topics.length, 2);
  assert.equal(day.topics[0].articles[0].description, undefined);

  for (const date of ['2020-01-01', '2026-10-30', '10/08/2026']) {
    const res = (await call('get_daily_news', { date })).body.result;
    assert.equal(res.isError, true, date);
  }
});

test('get_topic returns details; bad input is a tool error, unknown tool a protocol error', async () => {
  const detail = (await call('get_topic', { date: '2026-10-09', topic_id: 't_nobel' })).body.result;
  assert.equal(detail.isError, false);
  assert.equal(detail.structuredContent.topic.articles[0].description, 'Long text');
  assert.deepEqual(detail.structuredContent.topic.entities, ['Navi Pillay']);

  for (const args of [{ date: '2026-10-09', topic_id: 'missing' }, { date: '2020-01-01', topic_id: 't_nobel' }, { date: 'yesterday', topic_id: 'x' }, { topic_id: 't_nobel' }]) {
    const res = (await call('get_topic', args)).body.result;
    assert.equal(res.isError, true);
    assert.equal(res.structuredContent, undefined);
  }

  const unknown = await call('drop_tables', {});
  assert.equal(unknown.body.error.code, -32602);
});

test('upstream failures surface as tool errors and rate limits as 429', async () => {
  const broken = { fetchJson: async () => { throw new Error('2026-10-10.json: HTTP 503'); } };
  const res = await post(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_daily_news', arguments: {}, _meta: meta } },
    modernHeaders('tools/call', 'get_daily_news'),
    broken,
  );
  assert.equal(res.body.result.isError, true);
  assert.match(res.body.result.content[0].text, /503/);

  const limited = await post(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_daily_news', arguments: {}, _meta: meta } },
    modernHeaders('tools/call', 'get_daily_news'),
    { ...context, rateLimit: async () => false },
  );
  assert.equal(limited.status, 429);
});

test('server card and root describe the endpoint', async () => {
  const card = await handleRequest(new Request('https://mcp.example/.well-known/mcp/server-card.json'), CONFIG, context);
  const body = await card.json();
  assert.deepEqual(body.remotes, [{ type: 'streamable-http', url: 'https://mcp.example/mcp' }]);
  const root = await (await handleRequest(new Request('https://mcp.example/'), CONFIG, context)).json();
  assert.equal(root.mcp_endpoint, 'https://mcp.example/mcp');
});
