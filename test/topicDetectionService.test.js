import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DuckDBService } from '../src/services/duckdbService.js';
import {
  classifyTopic,
  clusterHeadlines,
  cosineSimilarity,
  detectTopicsForDate,
  detectTopicsFromArticles,
  extractHeadlineTerms,
  normalizeHeadline,
  scoreTopics
} from '../src/services/topicDetectionService.js';
import { hash64 } from '../src/utils/hash.js';

test('normalizes headlines and extracts ngrams', () => {
  assert.deepEqual(
    normalizeHeadline('OpenAI launches new reasoning models in Europe!'),
    ['openai', 'launch', 'reason', 'model', 'europe']
  );

  const terms = extractHeadlineTerms('OpenAI launches reasoning model in Europe');
  assert.equal(terms.includes('openai launch'), true);
  assert.equal(terms.includes('reason model'), true);
});

test('calculates cosine similarity for sparse vectors', () => {
  const a = new Map([['openai', 1], ['model', 1]]);
  const b = new Map([['openai', 1], ['reasoning', 1]]);
  const c = new Map([['tariff', 1], ['import', 1]]);

  assert.equal(Math.abs(cosineSimilarity(a, a) - 1) < 0.000001, true);
  assert.equal(cosineSimilarity(a, b) > cosineSimilarity(a, c), true);
});

test('clusters similar headlines', () => {
  const documents = [
    { vector: new Map([['ukraine', 1], ['peace', 1]]) },
    { vector: new Map([['ukraine', 1], ['peace', 1], ['talks', 1]]) },
    { vector: new Map([['openai', 1], ['model', 1]]) }
  ];

  const clusters = clusterHeadlines(documents, 0.5);
  assert.deepEqual(clusters.map(cluster => cluster.length).sort(), [1, 2]);
});

test('classifies new, trending, ongoing, and monitor topics', () => {
  assert.equal(classifyTopic({
    noveltyScore: 0.9,
    burstZScore: 0,
    burstScore: 0,
    maxHistoricalSimilarity: 0,
    persistenceScore: 0.25,
    articleCount: 3
  }), 'new');

  assert.equal(classifyTopic({
    noveltyScore: 0.2,
    burstZScore: 3,
    burstScore: 1,
    maxHistoricalSimilarity: 0.8,
    persistenceScore: 0.5,
    articleCount: 6
  }), 'trending');

  assert.equal(classifyTopic({
    noveltyScore: 0.2,
    burstZScore: 0,
    burstScore: 0,
    maxHistoricalSimilarity: 0.8,
    persistenceScore: 0.5,
    articleCount: 3
  }), 'ongoing');

  assert.equal(classifyTopic({
    noveltyScore: 0.5,
    burstZScore: 0,
    burstScore: 0,
    maxHistoricalSimilarity: 0.5,
    persistenceScore: 0.25,
    articleCount: 3
  }), 'monitor');
});

test('source diversity improves ranking against one-source duplicates', () => {
  const articles = [
    article('OpenAI launches reasoning model in Europe', '2026-04-27T08:00:00Z', 'source-a', 1),
    article('OpenAI launches reasoning model for Europe', '2026-04-27T09:00:00Z', 'source-b', 2),
    article('OpenAI reasoning model launches across Europe', '2026-04-27T10:00:00Z', 'source-c', 3),
    article('Celebrity wedding rumors spread online', '2026-04-27T08:00:00Z', 'source-z', 4),
    article('Celebrity wedding rumor spreads online', '2026-04-27T09:00:00Z', 'source-z', 5),
    article('Celebrity wedding rumors spread again online', '2026-04-27T10:00:00Z', 'source-z', 6)
  ];

  const topics = scoreTopics(detectTopicsFromArticles(articles, {
    minTopicSize: 3,
    minSources: 1
  }));
  const diverse = topics.find(topic => topic.labelKeywords.includes('openai'));
  const duplicate = topics.find(topic => topic.labelKeywords.includes('celebrity'));

  assert.equal(diverse.sourceDiversity > duplicate.sourceDiversity, true);
  assert.equal(diverse.finalScore > duplicate.finalScore, true);
});

test('detects and stores new, trending, and ongoing topics through DuckDB', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rss-topics-'));
  const service = new DuckDBService(path.join(dir, 'rss.duckdb'));

  try {
    await service.insertArticles([
      article('Ukraine peace talks continue in Paris', '2026-04-24T08:00:00Z', 'source-a', 1),
      article('Ukraine peace talks enter second day', '2026-04-24T12:00:00Z', 'source-b', 2),
      article('Ukraine peace talks continue in Paris', '2026-04-25T08:00:00Z', 'source-a', 3),
      article('Ukraine peace talks enter second day', '2026-04-25T12:00:00Z', 'source-b', 4),
      article('Ukraine peace talks continue in Paris', '2026-04-26T08:00:00Z', 'source-a', 5),
      article('Ukraine peace talks enter second day', '2026-04-26T12:00:00Z', 'source-b', 6)
    ]);

    await detectTopicsForDate(service, '2026-04-24', { minTopicSize: 2, minSources: 2 });
    await detectTopicsForDate(service, '2026-04-25', { minTopicSize: 2, minSources: 2 });
    await detectTopicsForDate(service, '2026-04-26', { minTopicSize: 2, minSources: 2 });

    await service.insertArticles([
      article('Ukraine peace talks continue in Paris', '2026-04-27T06:00:00Z', 'source-a', 7),
      article('Ukraine peace talks enter second day', '2026-04-27T08:00:00Z', 'source-b', 8),
      article('Ukraine peace talks continue as leaders meet', '2026-04-27T10:00:00Z', 'source-c', 9),
      article('Ukraine peace talks continue in Paris', '2026-04-27T12:00:00Z', 'source-d', 10),
      article('Ukraine peace talks enter second day', '2026-04-27T14:00:00Z', 'source-e', 11),
      article('Ukraine peace talks continue as leaders meet', '2026-04-27T16:00:00Z', 'source-f', 12),
      article('OpenAI launches reasoning model in Europe', '2026-04-27T08:00:00Z', 'source-a', 13),
      article('OpenAI reasoning model launches across Europe', '2026-04-27T09:00:00Z', 'source-b', 14),
      article('OpenAI launches Europe reasoning model', '2026-04-27T10:00:00Z', 'source-c', 15)
    ]);

    const topics = await detectTopicsForDate(service, '2026-04-27', { minTopicSize: 2, minSources: 2 });
    const trending = topics.find(topic => topic.labelKeywords.includes('ukraine'));
    const fresh = topics.find(topic => topic.labelKeywords.includes('openai'));

    assert.equal(trending.status, 'trending');
    assert.equal(fresh.status, 'new');

    await service.insertArticles([
      article('Ukraine peace talks continue in Paris', '2026-04-28T08:00:00Z', 'source-a', 16),
      article('Ukraine peace talks enter second day', '2026-04-28T12:00:00Z', 'source-b', 17)
    ]);
    const nextDayTopics = await detectTopicsForDate(service, '2026-04-28', { minTopicSize: 2, minSources: 2 });
    const ongoing = nextDayTopics.find(topic => topic.labelKeywords.includes('ukraine'));

    assert.equal(ongoing.status, 'ongoing');

    const stored = await service.getTopicsBetweenDates('2026-04-27', '2026-04-28');
    assert.equal(stored.length >= 3, true);
  } finally {
    await service.close();
  }
});

function article(title, isoDate, source, index) {
  const url = `https://example.com/${source}/${index}`;
  return {
    url_hash: hash64(url),
    url,
    feed_url: `https://${source}.example.com/feed.xml`,
    feed_title: source,
    title,
    summary: null,
    image_url: null,
    author: null,
    published_at: new Date(isoDate),
    fetched_at: new Date(isoDate),
    source_type: 1,
    tags: [],
    raw_fingerprint: hash64(`${title}|${isoDate}`)
  };
}
