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
  attachVideos,
  createTfidfVectorizer,
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
    maxHistoricalSimilarity: 0.3,
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

test('tokenizer keeps accented words and drops non-English stopwords', () => {
  const tokens = normalizeHeadline('La France prohíbe las redes sociales à des menores de 15 años');
  assert.equal(tokens.includes('la'), false);
  assert.equal(tokens.includes('de'), false);
  assert.equal(tokens.includes('des'), false);
  assert.equal(tokens.includes('15'), false);
  assert.equal(tokens.includes('prohibe'), true);
});

test('labels use readable surface forms instead of stems', () => {
  const topics = detectTopicsFromArticles([
    article('Bill Gates says Epstein used affairs as leverage', '2026-04-27T08:00:00Z', 'source-a', 1),
    article('Gates: Epstein used affairs as leverage against me', '2026-04-27T09:00:00Z', 'source-b', 2),
    article('Bill Gates tells of Epstein leverage over affairs', '2026-04-27T10:00:00Z', 'source-c', 3)
  ], { minTopicSize: 3, minSources: 3 });
  assert.equal(topics.length, 1);
  assert.equal(topics[0].labelKeywords.includes('gates'), true);
  assert.equal(topics[0].labelKeywords.includes('gat'), false);
  assert.equal(topics[0].sampleHeadlines[0].split(' ').length >= 5, true);
});

test('syndicated copies collapse but still count as articles and sources', () => {
  const topics = detectTopicsFromArticles([
    article('Storm Bertha forms near the Gulf Coast', '2026-04-27T08:00:00Z', 'source-a', 1),
    article('Storm Bertha forms near the Gulf Coast', '2026-04-27T08:05:00Z', 'source-b', 2),
    article('Storm Bertha forms near the Gulf Coast', '2026-04-27T08:10:00Z', 'source-c', 3)
  ], { minTopicSize: 3, minSources: 3 });
  assert.equal(topics.length, 1);
  assert.equal(topics[0].articleCount, 3);
  assert.equal(topics[0].uniqueSourceCount, 3);
  assert.deepEqual(topics[0].sampleHeadlines, ['Storm Bertha forms near the Gulf Coast']);
});

test('unrelated stories sharing one phrase do not chain into one cluster', () => {
  const titles = [
    'White House announces new tariffs on Chinese steel imports',
    'Tariffs on Chinese steel imports announced by White House',
    'White House steel tariffs target Chinese imports',
    'White House hosts state dinner for Japanese prime minister',
    'Japanese prime minister attends White House state dinner',
    'State dinner at White House honours Japanese prime minister'
  ];
  const topics = detectTopicsFromArticles(
    titles.map((title, index) => article(title, `2026-04-27T0${index}:00:00Z`, `source-${index}`, index)),
    { minTopicSize: 3, minSources: 3 }
  );
  assert.equal(topics.length, 2);
  assert.deepEqual(topics.map(topic => topic.articleCount), [3, 3]);
});

test('widely covered stories outrank small novel clusters', () => {
  const big = Array.from({ length: 20 }, (_, index) =>
    article(`Earthquake strikes Japan coast report ${['early', 'late', 'major', 'strong', 'deadly'][index % 5]}`,
      '2026-04-27T08:00:00Z', `wire-${index}`, index));
  const small = [
    article('Local bakery wins regional bread award', '2026-04-27T08:00:00Z', 'small-a', 100),
    article('Regional bread award goes to local bakery', '2026-04-27T09:00:00Z', 'small-b', 101),
    article('Local bakery takes bread award in region', '2026-04-27T10:00:00Z', 'small-c', 102)
  ];
  const topics = scoreTopics(detectTopicsFromArticles([...big, ...small], { minTopicSize: 3, minSources: 3 }));
  const quake = topics.find(topic => topic.labelKeywords.includes('earthquake'));
  const bakery = topics.find(topic => topic.labelKeywords.includes('bakery'));
  assert.equal(quake.finalScore > bakery.finalScore, true);
});

test('videos attach to the matching topic without changing its counts', () => {
  const news = [
    article('Wildfire destroys Eagle Nest historic site in Bavaria', '2026-04-27T08:00:00Z', 'source-a', 1),
    article('Eagle Nest historic site in Bavaria hit by wildfire', '2026-04-27T09:00:00Z', 'source-b', 2),
    article('Bavaria wildfire reaches Eagle Nest historic site', '2026-04-27T10:00:00Z', 'source-c', 3),
    article('Central bank raises interest rates to fight inflation', '2026-04-27T08:00:00Z', 'source-a', 4),
    article('Interest rates raised by central bank amid inflation', '2026-04-27T09:00:00Z', 'source-b', 5),
    article('Inflation pushes central bank to raise interest rates', '2026-04-27T10:00:00Z', 'source-c', 6)
  ];
  const videos = [
    video('Wildfire engulfs Eagle Nest historic site in Bavaria | DW News', 'dw', 1),
    video('Eagle Nest wildfire: historic Bavaria site burns', 'dw', 2),
    video('Bavaria wildfire at Eagle Nest historic site', 'sky', 3),
    video('Top ten cooking tips for beginners', 'food', 4)
  ];
  const plain = detectTopicsFromArticles(news, { minTopicSize: 3, minSources: 3 });
  const topics = detectTopicsFromArticles(news, { minTopicSize: 3, minSources: 3, videos });
  const fire = topics.find(topic => topic.labelKeywords.includes('wildfire'));
  const rates = topics.find(topic => topic.labelKeywords.includes('inflation'));

  // One per channel: dw's closer first video wins over its second.
  assert.deepEqual([...fire.videoHashes].sort(), [String(videos[0].url_hash), String(videos[2].url_hash)].sort());
  assert.deepEqual(rates.videoHashes, []);
  assert.deepEqual(topics.map(t => [t.id, t.articleCount, t.uniqueSourceCount]), plain.map(t => [t.id, t.articleCount, t.uniqueSourceCount]));
});

test('attachVideos caps videos per topic', () => {
  const vectorize = createTfidfVectorizer([['storm', 'coast']]);
  const topic = { centroidVector: vectorize(['storm', 'coast']) };
  const videos = Array.from({ length: 5 }, (_, index) => video('Storm coast', `channel-${index}`, index));
  attachVideos([topic], videos, vectorize, { maxVideosPerTopic: 2 });
  assert.equal(topic.videoHashes.length, 2);
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

test('videos are stored with their topic but kept out of clustering', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rss-topics-'));
  const service = new DuckDBService(path.join(dir, 'rss.duckdb'));

  try {
    const clip = { ...video('Storm Bertha makes landfall on Gulf Coast', 'dw', 1), published_at: new Date('2026-04-27T11:00:00Z'), fetched_at: new Date('2026-04-27T11:00:00Z'), source_type: 2, url: 'https://www.youtube.com/watch?v=abc123', image_url: null, author: null, tags: [] };
    await service.insertArticles([
      article('Storm Bertha makes landfall on Gulf Coast', '2026-04-27T08:00:00Z', 'source-a', 1),
      article('Gulf Coast braces as Storm Bertha makes landfall', '2026-04-27T09:00:00Z', 'source-b', 2),
      clip
    ]);

    assert.deepEqual((await service.getVideosForDate('2026-04-27')).map(row => row.title), [clip.title]);
    assert.equal((await service.getArticlesForDate('2026-04-27')).length, 2);

    const [topic] = await detectTopicsForDate(service, '2026-04-27', { minTopicSize: 2, minSources: 2 });
    assert.equal(topic.articleCount, 2);
    const rows = await service.getArticlesForTopic(topic.id);
    assert.deepEqual(rows.map(row => Number(row.source_type)).sort(), [1, 1, 2]);
    assert.equal(rows[0].url, clip.url);
  } finally {
    await service.close();
  }
});

function video(title, channel, index) {
  const url = `https://www.youtube.com/watch?v=${channel}${index}`;
  return {
    url_hash: hash64(url),
    url,
    feed_url: `https://www.youtube.com/feeds/videos.xml?channel_id=${channel}`,
    feed_title: channel,
    title,
    summary: null
  };
}

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
