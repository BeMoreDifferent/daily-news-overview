import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { summarizeTopics } from '../src/services/newsSummaryService.js';

const KEY = 'sk-test-secret-key';
const TOPICS = [
  { id: 'topic_a', articles: [{ title: 'France bans social media for under-15s', description: 'Lawmakers approved the bill.' }] },
  { id: 'topic_b', articles: [{ title: 'French parliament passes social media ban for children' }] },
  { id: 'topic_c', articles: [{ title: 'Tropical Storm Bertha forms in the Gulf' }] }
];

async function tempLedger() {
  return path.join(await mkdtemp(path.join(os.tmpdir(), 'summary-ledger-')), 'usage.json');
}

function recordingLogger() {
  const lines = [];
  return { lines, log: (...a) => lines.push(a.join(' ')), warn: (...a) => lines.push(a.join(' ')) };
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

test('returns titles, summaries and duplicate links from one request', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return jsonResponse(200, {
      usage: { input_tokens: 120, output_tokens: 60 },
      output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ topics: [
        { key: 't1', title: 'France Bans Social Media for Under-15s', summary: 'Lawmakers approved a ban.', duplicate_of: null },
        { key: 't2', title: 'Same story', summary: 'Dup.', duplicate_of: 't1' },
        { key: 't3', title: 'Tropical Storm Bertha Forms', summary: 'A storm formed.', duplicate_of: null }
      ] }) }] }]
    });
  };
  const logger = recordingLogger();
  const ledgerPath = await tempLedger();
  const now = new Date('2026-09-27T12:00:00Z');

  const result = await summarizeTopics(TOPICS, { env: { OPENAI_API_KEY: KEY }, fetchImpl, logger, ledgerPath, now });

  assert.equal(calls.length, 1);
  const ledger = JSON.parse(await readFile(ledgerPath, 'utf8'));
  assert.equal(Math.abs(ledger['2026-09-27'] - (120 * 0.10 + 60 * 0.50) / 1e6) < 1e-12, true);
  assert.equal(calls[0].body.model, 'gpt-6-luna');
  assert.equal(calls[0].body.max_output_tokens, 2000);
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(result.get('topic_a').title, 'France Bans Social Media for Under-15s');
  assert.equal(result.get('topic_b').duplicateOf, 'topic_a');
  assert.equal(result.get('topic_c').duplicateOf, null);
  assert.equal(logger.lines.some(line => line.includes(KEY)), false);
});

test('makes no request without an API key or when disabled', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; };
  assert.equal(await summarizeTopics(TOPICS, { env: {}, fetchImpl }), null);
  assert.equal(await summarizeTopics(TOPICS, { env: { OPENAI_API_KEY: KEY, SUMMARY_ENABLED: '0' }, fetchImpl }), null);
  assert.equal(called, false);
});

test('falls back to null on HTTP errors without retrying or leaking the key', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return jsonResponse(500, { error: { message: 'server exploded' } });
  };
  const logger = recordingLogger();

  const result = await summarizeTopics(TOPICS, { env: { OPENAI_API_KEY: KEY }, fetchImpl, logger, ledgerPath: await tempLedger() });

  assert.equal(result, null);
  assert.equal(calls, 1);
  assert.equal(logger.lines.some(line => line.includes('HTTP 500')), true);
  assert.equal(logger.lines.some(line => line.includes(KEY)), false);
});

test('retries once without reasoning when the model rejects it', async () => {
  const bodies = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    if (body.reasoning) return jsonResponse(400, { error: { message: 'Unsupported parameter: reasoning.effort' } });
    return jsonResponse(200, { output_text: JSON.stringify({ topics: [{ key: 't3', title: 'Storm', summary: 'S.', duplicate_of: null }] }) });
  };

  const result = await summarizeTopics(TOPICS, { env: { OPENAI_API_KEY: KEY }, fetchImpl, logger: recordingLogger(), ledgerPath: await tempLedger() });

  assert.equal(bodies.length, 2);
  assert.equal(bodies[1].reasoning, undefined);
  assert.equal(result.get('topic_c').title, 'Storm');
});

test('skips the request when the daily budget would be exceeded', async () => {
  const ledgerPath = await tempLedger();
  await writeFile(ledgerPath, JSON.stringify({ '2026-09-27': 0.0199 }));
  let called = false;
  const logger = recordingLogger();

  const result = await summarizeTopics(TOPICS, {
    env: { OPENAI_API_KEY: KEY },
    fetchImpl: async () => { called = true; },
    logger,
    ledgerPath,
    now: new Date('2026-09-27T18:00:00Z')
  });

  assert.equal(result, null);
  assert.equal(called, false);
  assert.equal(logger.lines.some(line => line.includes('daily budget')), true);
});
