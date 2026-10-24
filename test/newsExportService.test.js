import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildVideoObj, exportNewsForDate, youtubeVideoId } from '../src/services/newsExportService.js';

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
