import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { mapFeedItemToArticleRow, isRecentItem, processFeed } from '../src/services/feedProcessor.js';
import { DEFAULT_FEED_DEADLINE_MS } from '../src/config.js';

const feed = {
  url: 'https://example.com/feed.xml',
  sourceType: 1
};

test('maps RSS item to lean article row', () => {
  const row = mapFeedItemToArticleRow({
    title: 'Hello <b>World</b>',
    link: 'https://example.com/article?utm_source=x#frag',
    description: '<p>Short summary &amp; details.</p>',
    pubDate: '2026-04-26T10:00:00Z',
    author: 'Jane',
    category: ['Tech', 'RSS'],
    mediaThumbnail: { $: { url: 'https://example.com/image.jpg' } }
  }, feed, { title: 'Example Feed' }, new Date('2026-04-27T00:00:00Z'));

  assert.equal(row.url, 'https://example.com/article');
  assert.equal(row.title, 'Hello World');
  assert.equal(row.summary, 'Short summary & details.');
  assert.equal(row.feed_title, 'Example Feed');
  assert.equal(row.image_url, 'https://example.com/image.jpg');
  assert.deepEqual(row.tags, ['tech', 'rss']);
  assert.equal(typeof row.url_hash, 'bigint');
  assert.equal(row.content_body, undefined);
});

test('filters old dated items but keeps undated items', () => {
  const now = new Date('2026-04-27T00:00:00Z');

  assert.equal(isRecentItem({ pubDate: '2026-04-26T00:00:00Z' }, now, 3), true);
  assert.equal(isRecentItem({ pubDate: '2026-04-20T00:00:00Z' }, now, 3), false);
  assert.equal(isRecentItem({}, now, 3), true);
});

test('maps youtube media group thumbnail and description', () => {
  const row = mapFeedItemToArticleRow({
    title: 'Video title',
    link: 'https://www.youtube.com/watch?v=abc123',
    pubDate: '2026-04-26T10:00:00Z',
    mediaGroup: {
      'media:thumbnail': [{ $: { url: 'https://i.ytimg.com/vi/abc123/hqdefault.jpg' } }],
      'media:description': ['Video description']
    }
  }, feed, { title: 'YouTube Feed' }, new Date('2026-04-27T00:00:00Z'));

  assert.equal(row.title, 'Video title');
  assert.equal(row.url, 'https://www.youtube.com/watch?v=abc123');
  assert.equal(row.summary, 'Video description');
  assert.equal(row.image_url, 'https://i.ytimg.com/vi/abc123/hqdefault.jpg');
});

test('processFeed rejects when server sends headers but never a body', async (t) => {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/xml' });
    // intentionally never calls res.end() — simulates a hung feed
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/feed.xml`;

  const start = Date.now();
  await assert.rejects(
    () => processFeed({ url, enabled: true, intervalMinutes: 60, maxItems: 10, sourceType: 1 }),
    err => err.code === 'ETIMEDOUT' || err.code === 'ECONNRESET'
  );
  const elapsed = Date.now() - start;
  assert.ok(elapsed < DEFAULT_FEED_DEADLINE_MS + 500, `should reject within deadline, took ${elapsed}ms`);

  await new Promise(resolve => server.close(resolve));
});
