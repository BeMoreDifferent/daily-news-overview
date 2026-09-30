// Daily topic titles + summaries via one batched OpenAI Responses API call, plus one small call for
// the day's overview ("the day in brief") written from the final titles and summaries.
// Cost controls: called once per exported day (never on hourly runs), compact input (≤5 titles and
// 200-char descriptions per topic), low reasoning effort, capped output, no retries on failure, and
// a hard daily budget: a request is only sent if its worst-case cost fits in what is left of today's
// budget (ledger in data/summary_usage.json). Typical cost is ~$0.001 per day.
// The API key is read from the environment only and never logged.

import { promises as fs } from 'fs';
import path from 'path';

const API_URL = 'https://api.openai.com/v1/responses';
const DEFAULT_MODEL = 'gpt-6-luna';
const TIMEOUT_MS = 60_000;
const MAX_OUTPUT_TOKENS = 2000;
const TITLES_PER_TOPIC = 5;
const DESCRIPTION_CHARS = 200;
const LEDGER_PATH = path.join('data', 'summary_usage.json');
// gpt-6-luna list prices (USD per 1M tokens). Budget is in EUR; treating USD as EUR overstates the
// cost (1 EUR > 1 USD), so the guard stays conservative.
const DEFAULT_PRICE_INPUT_PER_M = 0.10;
const DEFAULT_PRICE_OUTPUT_PER_M = 0.50;
const DEFAULT_DAILY_BUDGET_EUR = 0.02;

const INSTRUCTIONS = [
  'You edit a neutral daily news digest. Each cluster below groups headlines (from many outlets and',
  'languages) about one story. For every cluster return:',
  '- title: English, at most 12 words, factual, no clickbait, no source names.',
  '- summary: English, 1-2 sentences, at most 45 words, only facts supported by the given headlines',
  '  and descriptions; neutral wording; no speculation.',
  '- duplicate_of: the key of an EARLIER cluster that covers the same story, otherwise null.'
].join('\n');

const RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['topics'],
  properties: {
    topics: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'title', 'summary', 'duplicate_of'],
        properties: {
          key: { type: 'string' },
          title: { type: 'string' },
          summary: { type: 'string' },
          duplicate_of: { type: ['string', 'null'] }
        }
      }
    }
  }
};

const OVERVIEW_MAX_OUTPUT_TOKENS = 800;
const OVERVIEW_MAX_POINTS = 5;
const OVERVIEW_INSTRUCTIONS = [
  'You write the opening "day in brief" of a neutral daily news digest. Below are the day\'s stories,',
  'numbered by importance. Return 3-5 points covering the most important developments, most important',
  'first. Each point:',
  '- text: English, one sentence, at most 28 words, only facts stated in the given stories, neutral',
  '  wording, no speculation, no source names. Combine closely related stories into one point.',
  '- stories: the numbers of the stories the point is based on.'
].join('\n');

const OVERVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['points'],
  properties: {
    points: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'stories'],
        properties: {
          text: { type: 'string' },
          stories: { type: 'array', items: { type: 'integer' } }
        }
      }
    }
  }
};

export function isSummaryEnabled(env = process.env) {
  return Boolean(env.OPENAI_API_KEY) && env.SUMMARY_ENABLED !== '0';
}

/**
 * topics: [{ id, articles: [{ title, description?, source? }] }] in rank order.
 * Returns Map<topicId, { title, summary, duplicateOf }>, or null when disabled or on any failure
 * (callers fall back to extractive headlines).
 */
export async function summarizeTopics(topics, {
  env = process.env,
  fetchImpl = globalThis.fetch,
  logger = console,
  ledgerPath = LEDGER_PATH,
  now = new Date()
} = {}) {
  if (!topics.length || !isSummaryEnabled(env)) return null;

  const keyToId = new Map(topics.map((topic, index) => [`t${index + 1}`, topic.id]));
  const input = topics.map((topic, index) => {
    const lines = (topic.articles || []).slice(0, TITLES_PER_TOPIC).map(article => {
      const description = article.description ? ` — ${truncate(article.description, DESCRIPTION_CHARS)}` : '';
      return `- ${truncate(article.title, 200)}${description}`;
    });
    return `[t${index + 1}]\n${lines.join('\n')}`;
  }).join('\n\n');

  const parsed = await requestJson({
    instructions: INSTRUCTIONS,
    input,
    schemaName: 'daily_topics',
    schema: RESPONSE_SCHEMA,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    label: `topics=${topics.length}`
  }, { env, fetchImpl, logger, ledgerPath, now });
  if (!parsed) return null;

  const results = new Map();
  for (const item of parsed.topics || []) {
    const id = keyToId.get(item.key);
    if (!id || !item.title) continue;
    results.set(id, {
      title: item.title.trim(),
      summary: (item.summary || '').trim() || null,
      duplicateOf: item.duplicate_of && item.duplicate_of !== item.key ? keyToId.get(item.duplicate_of) || null : null
    });
  }
  return results.size ? results : null;
}

/**
 * topics: the final exported topics in rank order ({ title, summary? }).
 * Returns [{ text, stories: [rank, ...] }] (3-5 points, ranks are 1-based), or null when disabled,
 * on any failure, or when the model returns nothing usable. One small request (~$0.0003).
 */
export async function summarizeDay(topics, {
  env = process.env,
  fetchImpl = globalThis.fetch,
  logger = console,
  ledgerPath = LEDGER_PATH,
  now = new Date()
} = {}) {
  if (topics.length < 3 || !isSummaryEnabled(env)) return null;

  const input = topics.map((topic, index) =>
    `[${index + 1}] ${truncate(topic.title, 160)}${topic.summary ? ` — ${truncate(topic.summary, 320)}` : ''}`
  ).join('\n');

  const parsed = await requestJson({
    instructions: OVERVIEW_INSTRUCTIONS,
    input,
    schemaName: 'daily_overview',
    schema: OVERVIEW_SCHEMA,
    maxOutputTokens: OVERVIEW_MAX_OUTPUT_TOKENS,
    label: 'overview'
  }, { env, fetchImpl, logger, ledgerPath, now });

  const points = (parsed?.points || [])
    .map(point => ({
      text: String(point.text || '').replace(/\s+/g, ' ').trim(),
      stories: [...new Set((point.stories || []).filter(rank => Number.isInteger(rank) && rank >= 1 && rank <= topics.length))].sort((a, b) => a - b)
    }))
    .filter(point => point.text && point.stories.length)
    .slice(0, OVERVIEW_MAX_POINTS);
  return points.length >= 2 ? points : null;
}

// One structured-output request under the daily budget. Returns the parsed JSON or null.
async function requestJson({ instructions, input, schemaName, schema, maxOutputTokens, label }, { env, fetchImpl, logger, ledgerPath, now }) {
  const pricing = {
    input: positiveNumber(env.SUMMARY_PRICE_INPUT_PER_M, DEFAULT_PRICE_INPUT_PER_M),
    output: positiveNumber(env.SUMMARY_PRICE_OUTPUT_PER_M, DEFAULT_PRICE_OUTPUT_PER_M)
  };
  const budget = positiveNumber(env.SUMMARY_DAILY_BUDGET_EUR, DEFAULT_DAILY_BUDGET_EUR);
  const day = now.toISOString().slice(0, 10);
  const ledger = await readLedger(ledgerPath);
  const spent = ledger[day] || 0;
  // Worst case: generous token estimate for the prompt (3 chars/token) + the full output cap, doubled
  // for the possible no-reasoning resend.
  const estimatedInputTokens = Math.ceil((instructions.length + input.length) / 3) + 500;
  const worstCase = 2 * cost(pricing, estimatedInputTokens, maxOutputTokens);
  if (spent + worstCase > budget) {
    logger.warn(`Summary skipped (${label}): daily budget ${budget} EUR (spent ${spent.toFixed(4)}, worst case ${worstCase.toFixed(4)})`);
    return null;
  }

  const model = env.SUMMARY_MODEL || DEFAULT_MODEL;
  const body = {
    model,
    instructions,
    input,
    reasoning: { effort: 'low' },
    max_output_tokens: maxOutputTokens,
    text: { format: { type: 'json_schema', name: schemaName, strict: true, schema } }
  };

  try {
    let response = await post(fetchImpl, env.OPENAI_API_KEY, body);
    // A 400 about `reasoning` means the model has no reasoning controls; a rejected request is not
    // billed, so retry once without it.
    if (response.status === 400 && /reasoning/i.test(await peekError(response))) {
      delete body.reasoning;
      response = await post(fetchImpl, env.OPENAI_API_KEY, body);
    }
    if (!response.ok) {
      logger.warn(`Summary request failed (${label}): HTTP ${response.status} ${await peekError(response)}`);
      return null;
    }

    const payload = await response.json();
    const usage = payload.usage || {};
    const callCost = Number.isFinite(usage.input_tokens) && Number.isFinite(usage.output_tokens)
      ? cost(pricing, usage.input_tokens, usage.output_tokens)
      : worstCase;
    await recordSpend(ledgerPath, day, callCost);
    logger.log(`Summary request ok model=${model} ${label} input_tokens=${usage.input_tokens ?? '?'} output_tokens=${usage.output_tokens ?? '?'} cost≈${callCost.toFixed(5)} day_total≈${(spent + callCost).toFixed(5)}`);

    return JSON.parse(extractOutputText(payload));
  } catch (error) {
    logger.warn(`Summary request failed (${label}): ${error.name === 'TimeoutError' ? 'timeout' : error.message}`);
    return null;
  }
}

function cost(pricing, inputTokens, outputTokens) {
  return (inputTokens * pricing.input + outputTokens * pricing.output) / 1e6;
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

async function readLedger(ledgerPath) {
  try {
    return JSON.parse(await fs.readFile(ledgerPath, 'utf8'));
  } catch {
    return {};
  }
}

// Spend per UTC day; only the last 60 days are kept.
async function recordSpend(ledgerPath, day, amount) {
  const ledger = await readLedger(ledgerPath);
  ledger[day] = (ledger[day] || 0) + amount;
  const kept = Object.fromEntries(Object.entries(ledger).sort().slice(-60));
  await fs.mkdir(path.dirname(ledgerPath), { recursive: true });
  await fs.writeFile(ledgerPath, JSON.stringify(kept, null, 2));
}

function post(fetchImpl, apiKey, body) {
  return fetchImpl(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
}

// Error bodies are logged, so only the API's error message is kept (never request headers).
async function peekError(response) {
  if (response._errorMessage !== undefined) return response._errorMessage;
  let message = '';
  try {
    const payload = await response.clone().json();
    message = String(payload?.error?.message || '').slice(0, 200);
  } catch { /* non-JSON body */ }
  response._errorMessage = message;
  return message;
}

function extractOutputText(payload) {
  if (typeof payload.output_text === 'string') return payload.output_text;
  for (const item of payload.output || []) {
    for (const part of item.content || []) {
      if (part.type === 'output_text' && part.text) return part.text;
    }
  }
  throw new Error('response had no output text');
}

function truncate(value, length) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}
