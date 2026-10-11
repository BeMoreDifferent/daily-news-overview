import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPayload, normalizeClient, sendPayload } from '../mcp/src/analytics.js';
import { handleRequest } from '../mcp/src/protocol.js';

const NOW = Date.parse('2026-10-10T12:00:00Z');
const base = {
  origin: 'https://mcp.example',
  era: 'modern',
  protocolVersion: '2026-07-28',
  clientInfo: { name: 'claude-code', version: '2.3.17' },
  userAgent: 'claude-cli/2.3.17 (external, cli)',
  country: 'DE',
  durationMs: 42,
  httpStatus: 200,
  now: NOW,
};

const topic = (id, rank) => ({ id, title: `Story ${id}`, category: 'trending', source_count: 7, keywords: ['a', 'b', 'c', 'd', 'e'], rank });

const eventNames = body => body.events.map(e => e.name);
const event = (body, name) => body.events.find(e => e.name === name).params;

test('client identification is reduced to known products; free text never leaks', () => {
  assert.deepEqual(normalizeClient({ name: 'claude-code', version: '2.3.17' }), { name: 'Claude Code', version: '2.3' });
  assert.deepEqual(normalizeClient({ name: 'Claude Desktop', version: 'v1.9' }), { name: 'Claude Desktop', version: '1.9' });
  assert.equal(normalizeClient(undefined, 'claude-cli/2.3.17').name, 'Claude Code');
  assert.equal(normalizeClient(undefined, 'claude-cli/2.3.17').version, '(not set)');
  assert.deepEqual(normalizeClient({ name: 'jane.doe@corp.example laptop agent', version: '1.0' }), { name: 'other', version: '(not set)' });
  assert.deepEqual(normalizeClient(undefined, undefined), { name: '(not set)', version: '(not set)' });
});

test('payload carries no IP, user agent or person-level identifier', () => {
  const body = buildPayload({ ...base, method: 'tools/list' });
  const text = JSON.stringify(body);
  assert.equal(body.ip_override, undefined);
  assert.equal(body.user_agent, undefined);
  assert.equal(body.user_id, undefined);
  assert.ok(!text.includes('claude-cli'));
  assert.deepEqual(body.user_location, { country_id: 'DE' });
  assert.deepEqual(body.consent, { ad_user_data: 'DENIED', ad_personalization: 'DENIED' });
  assert.deepEqual(body.device, { model: 'MCP client', browser: 'Claude Code', browser_version: '2.3' });
  // Same client product -> same client_id; different product -> different id.
  assert.equal(buildPayload({ ...base, method: 'ping' }).client_id, body.client_id);
  assert.notEqual(buildPayload({ ...base, clientInfo: { name: 'cursor' }, method: 'ping' }).client_id, body.client_id);
  assert.equal(buildPayload({ ...base, country: 'T1', method: 'ping' }).user_location, undefined);
});

test('every request is a page_view on a virtual path with session and engagement', () => {
  const body = buildPayload({ ...base, method: 'tools/list' });
  assert.deepEqual(eventNames(body), ['page_view']);
  const view = event(body, 'page_view');
  assert.equal(view.page_location, 'https://mcp.example/mcp/tools/list');
  assert.match(view.session_id, /^\d+$/);
  assert.equal(view.engagement_time_msec, 42);
  assert.equal(view.mcp_client, 'Claude Code');
  assert.equal(view.outcome, 'success');
  assert.equal(body.timestamp_micros, String(NOW * 1000));

  const unknown = buildPayload({ ...base, method: 'steal/secrets?user=jane', protocolVersion: 'jane', errorCode: -32601, httpStatus: 404 });
  assert.equal(event(unknown, 'page_view').page_location, 'https://mcp.example/mcp/(other)');
  assert.equal(event(unknown, 'page_view').protocol_version, '(not set)');
  assert.equal(event(unknown, 'mcp_error').error_code, '-32601');
});

test('connect, tool call and item events', () => {
  assert.deepEqual(eventNames(buildPayload({ ...base, method: 'initialize', era: 'legacy' })), ['page_view', 'mcp_connect']);

  const daily = buildPayload({
    ...base,
    method: 'tools/call',
    toolName: 'get_daily_news',
    result: { isError: false, structuredContent: { date: '2026-10-09', topics: [topic('t1'), topic('t2')] } },
  });
  assert.deepEqual(eventNames(daily), ['page_view', 'mcp_tool_call', 'view_item_list']);
  assert.equal(event(daily, 'page_view').page_location, 'https://mcp.example/mcp/tools/get_daily_news');
  assert.equal(event(daily, 'mcp_tool_call').result_count, 2);
  assert.equal(event(daily, 'mcp_tool_call').latency_ms, 42);
  const list = event(daily, 'view_item_list');
  assert.equal(list.days_ago, 1);
  assert.deepEqual(list.items[1], { item_id: 't2', item_name: 'Story t2', item_category: 'trending', item_list_id: '2026-10-09', item_list_name: 'Briefing 2026-10-09', index: 1 });

  const detail = buildPayload({
    ...base,
    method: 'tools/call',
    toolName: 'get_topic',
    result: { isError: false, structuredContent: { date: '2026-10-09', topic: topic('t3', 3) } },
  });
  const select = event(detail, 'select_item');
  assert.equal(select.story_rank, 3);
  assert.equal(select.story_keywords, 'a b c d');
  assert.equal(select.story_outlets, 7);
  assert.equal(select.items[0].index, 2);

  const failed = buildPayload({ ...base, method: 'tools/call', toolName: 'get_topic', result: { isError: true } });
  assert.deepEqual(eventNames(failed), ['page_view', 'mcp_tool_call']);
  assert.equal(event(failed, 'mcp_tool_call').outcome, 'tool_error');
});

test('payload respects GA4 limits', () => {
  const body = buildPayload({
    ...base,
    method: 'tools/call',
    toolName: 'get_daily_news',
    result: { isError: false, structuredContent: { date: '2026-10-09', topics: Array.from({ length: 15 }, (_, i) => topic(`t${i}`)) } },
  });
  assert.ok(body.events.length <= 25);
  for (const { name, params } of body.events) {
    assert.ok(name.length <= 40);
    assert.ok(Object.keys(params).length <= 25, `${name} has too many params`);
    for (const [key, value] of Object.entries(params)) {
      assert.ok(key.length <= 40);
      if (typeof value === 'string') assert.ok(value.length <= 100, `${name}.${key}`);
    }
  }
});

test('handleRequest reports one observation per JSON-RPC request', async () => {
  const seen = [];
  const context = { fetchJson: async () => ({ topics: [] }), now: Date.parse('2026-10-10T12:00:00Z'), track: obs => seen.push(obs) };
  const res = await handleRequest(new Request('https://mcp.example/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/call', 'Mcp-Name': 'get_daily_news', 'User-Agent': 'claude-cli/2.3' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'get_daily_news', arguments: {}, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {}, 'io.modelcontextprotocol/clientInfo': { name: 'claude-code', version: '2.3.1' } } },
    }),
  }), { allowedOrigins: [] }, context);
  assert.equal(res.status, 200);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].toolName, 'get_daily_news');
  assert.equal(seen[0].era, 'modern');
  assert.equal(seen[0].clientInfo.name, 'claude-code');
  assert.equal(seen[0].result.structuredContent.date, '2026-10-10');

  await handleRequest(new Request('https://mcp.example/mcp', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  }), { allowedOrigins: [] }, context);
  assert.equal(seen.length, 1, 'notifications are not reported');
});

test('sendPayload posts to the EU endpoint and never throws', async () => {
  const calls = [];
  const ok = await sendPayload({ events: [] }, { measurementId: 'G-TEST', apiSecret: 's3cret', fetchImpl: async (url, init) => { calls.push({ url, init }); return { ok: true }; } });
  assert.equal(ok, true);
  assert.match(calls[0].url, /^https:\/\/region1\.google-analytics\.com\/mp\/collect\?measurement_id=G-TEST&api_secret=s3cret$/);
  assert.equal(await sendPayload({}, { measurementId: 'G', apiSecret: 's', fetchImpl: async () => { throw new Error('down'); } }), false);
});
