import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { normalizeFeedConfig } from '../src/config.js';
import { DuckDBService } from '../src/services/duckdbService.js';
import { processFeed } from '../src/services/feedProcessor.js';

const SMASHING_FEED_URL = 'https://www.smashingmagazine.com/feed/';
const YOUTUBE_FEED_URL = 'https://www.youtube.com/feeds/videos.xml?channel_id=UC16niRr50-MSBwiO3YDb3RA';

test('live feeds collect title, url, description, and preview image into DuckDB', {
  skip: process.env.LIVE_FEED_SMOKE === '1' ? false : 'Set LIVE_FEED_SMOKE=1 to run network smoke test',
  timeout: 30000
}, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rss-live-smoke-'));
  const service = new DuckDBService(path.join(dir, 'rss.duckdb'));

  try {
    const smashingRows = await fetchRows(SMASHING_FEED_URL);
    const youtubeRows = await fetchRows(YOUTUBE_FEED_URL);
    await service.insertArticles([...smashingRows, ...youtubeRows]);

    const connection = await service.open();
    const reader = await connection.runAndReadAll(`
      SELECT title, url, summary, image_url, feed_url
      FROM articles
      WHERE feed_url IN ('${SMASHING_FEED_URL}', '${YOUTUBE_FEED_URL}')
    `);
    const storedRows = reader.getRowObjectsJS();
    const smashingStored = storedRows.filter(row => row.feed_url === SMASHING_FEED_URL);
    const youtubeStored = storedRows.filter(row => row.feed_url === YOUTUBE_FEED_URL);

    assert.equal(hasCompletePreviewRow(smashingStored), true, 'Smashing feed should store title, url, summary, and image_url');
    assert.equal(hasCompletePreviewRow(youtubeStored), true, 'YouTube feed should store title, url, summary, and image_url for at least one item');
    assert.equal(youtubeStored.some(row => isValidUrl(row.image_url) && row.image_url.includes('ytimg.com')), true);
  } finally {
    await service.close();
  }
});

async function fetchRows(feedUrl) {
  const result = await processFeed(normalizeFeedConfig(feedUrl));
  assert.equal(result.rows.length > 0, true, `${feedUrl} should return recent rows`);
  return result.rows;
}

function hasCompletePreviewRow(rows) {
  return rows.some(row => (
    hasText(row.title)
    && isValidUrl(row.url)
    && hasText(row.summary)
    && isValidUrl(row.image_url)
  ));
}

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isValidUrl(value) {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}
