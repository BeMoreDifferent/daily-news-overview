import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildVideoObj, candidateTopics, exportNewsForDate, selectTopics, youtubeVideoId } from '../src/services/newsExportService.js';
import { sectionFromSources } from '../src/services/sectionService.js';

test('extracts YouTube video ids from watch, shorts and short links', () => {
  assert.equal(youtubeVideoId('https://www.youtube.com/watch?v=yNlc8nNrHh4'), 'yNlc8nNrHh4');
  assert.equal(youtubeVideoId('https://www.youtube.com/shorts/DBJeADEkMXw'), 'DBJeADEkMXw');
  assert.equal(youtubeVideoId('https://youtu.be/abc_123'), 'abc_123');
  assert.equal(youtubeVideoId('https://example.com/video/1'), null);
});

test('builds a video with channel and a CORS-safe thumbnail', () => {
  assert.deepEqual(buildVideoObj({
    title: 'Storm hits coast',
    url: 'https://www.youtube.com/watch?v=abc',
    feed_title: 'DW News',
    published_at: new Date('2026-10-23T10:00:00Z'),
    image_url: 'https://i4.ytimg.com/vi/abc/hqdefault.jpg'
  }), {
    title: 'Storm hits coast',
    url: 'https://www.youtube.com/watch?v=abc',
    video_id: 'abc',
    channel: 'DW News',
    published_at: '2026-10-23T10:00:00.000Z',
    thumbnail: 'https://i.ytimg.com/vi/abc/hqdefault.jpg'
  });
});

test('export lists videos separately and never in place of articles', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rss-export-'));
  const cwd = process.cwd();
  const row = (title, url, feed, sourceType) => ({ title, url, feed_url: feed, feed_title: feed, published_at: null, image_url: null, summary: null, source_type: sourceType });
  const db = {
    getTopicsBetweenDates: async () => [{ id: 't1', finalScore: 1, sampleHeadlines: ['Storm hits coast'], articleCount: 2, uniqueSourceCount: 2 }],
    getArticlesForTopic: async () => [
      row('Storm hits coast (video)', 'https://www.youtube.com/watch?v=a', 'DW News', 2),
      row('Storm on the coast', 'https://www.youtube.com/watch?v=b', 'DW News', 2),
      row('Storm hits coast', 'https://news.example/1', 'Example', 1),
      row('Coast hit by storm', 'https://other.example/2', 'Other', 1)
    ]
  };

  process.chdir(dir);
  try {
    await exportNewsForDate(db, '2026-10-23', { summarize: false, imageCheck: false });
    const [topic] = JSON.parse(await readFile(path.join(dir, 'news', '2026-10-23.json'), 'utf8')).topics;
    assert.deepEqual(topic.articles.map(a => a.url), ['https://news.example/1', 'https://other.example/2']);
    assert.deepEqual(topic.videos.map(v => v.video_id), ['a']);
  } finally {
    process.chdir(cwd);
  }
});

const scored = (id, finalScore, section) => ({ id, finalScore, section });
const bySection = topic => topic.section;

test('selection caps each section and keeps score order', () => {
  const candidates = [
    ...Array.from({ length: 8 }, (_, index) => scored(`w${index}`, 1 - index * 0.01, 'world')),
    scored('p1', 0.9, 'politics'),
    scored('t1', 0.6, 'technology')
  ].sort((a, b) => b.finalScore - a.finalScore);
  const picked = selectTopics(candidates, bySection);
  assert.equal(picked.filter(topic => topic.section === 'world').length, 5);
  assert.deepEqual(picked.map(topic => topic.id), ['w0', 'w1', 'w2', 'w3', 'w4', 'p1', 't1']);
});

test('soft minimum adds a section\'s best story only above half the top score', () => {
  const sections = ['world', 'politics', 'business'];
  const candidates = [
    ...Array.from({ length: 18 }, (_, index) => scored(`s${index}`, 1 - index * 0.02, sections[index % 3])),
    scored('tech', 0.55, 'technology'),
    scored('sport', 0.45, 'sports')
  ];
  const ids = selectTopics(candidates, bySection).map(topic => topic.id);
  assert.equal(ids.length, 15);
  assert.equal(ids.includes('tech'), true);
  assert.equal(ids.includes('sport'), false);
  assert.equal(ids.at(-1), 'tech');
});

test('a one-section day still shows the minimum number of stories', () => {
  const candidates = Array.from({ length: 9 }, (_, index) => scored(`w${index}`, 1 - index * 0.01, 'world'));
  assert.equal(selectTopics(candidates, bySection).length, 5);
});

test('candidates keep one topic per theme', () => {
  const topics = [
    { id: 'a', finalScore: 1, themeId: 'x' },
    { id: 'b', finalScore: 0.9, themeId: 'x' },
    { id: 'c', finalScore: 0.8 }
  ];
  assert.deepEqual(candidateTopics(topics).map(topic => topic.id), ['a', 'c']);
});

test('specialist feeds decide the section only with a real share of sources', () => {
  const feedSections = new Map([['tech1', 'technology'], ['tech2', 'technology'], ['sport1', 'sports']]);
  const rows = feeds => feeds.map(feed_url => ({ feed_url }));
  assert.equal(sectionFromSources(rows(['tech1', 'tech2', 'bbc', 'cnn', 'ap']), feedSections), 'technology');
  assert.equal(sectionFromSources(rows(['tech1', 'bbc', 'cnn', 'ap', 'nyt', 'dw']), feedSections), 'world');
  assert.equal(sectionFromSources(rows([]), feedSections), 'world');
});
