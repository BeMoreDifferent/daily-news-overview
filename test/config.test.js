import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeFeedConfig } from '../src/config.js';

test('normalizes string feed entries', () => {
  const feed = normalizeFeedConfig('https://example.com/rss.xml');

  assert.equal(feed.url, 'https://example.com/rss.xml');
  assert.equal(feed.enabled, true);
  assert.equal(feed.sourceType, 1);
  assert.equal(feed.maxItems > 0, true);
});

test('normalizes object feed entries and detects source type', () => {
  const feed = normalizeFeedConfig({
    url: 'https://www.youtube.com/feeds/videos.xml?channel_id=abc',
    enabled: false,
    intervalMinutes: 30,
    maxItems: 7
  });

  assert.equal(feed.enabled, false);
  assert.equal(feed.intervalMinutes, 30);
  assert.equal(feed.maxItems, 7);
  assert.equal(feed.sourceType, 2);
});
