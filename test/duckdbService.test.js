import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DuckDBService } from '../src/services/duckdbService.js';
import { hash64 } from '../src/utils/hash.js';

test('dedupes articles by url_hash', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rss-duckdb-'));
  const service = new DuckDBService(path.join(dir, 'rss.duckdb'));
  const url = 'https://example.com/a';
  const row = {
    url_hash: hash64(url),
    url,
    feed_url: 'https://example.com/feed.xml',
    feed_title: 'Example',
    title: 'A',
    summary: 'Summary',
    image_url: null,
    author: null,
    published_at: new Date('2026-04-26T00:00:00Z'),
    fetched_at: new Date('2026-04-27T00:00:00Z'),
    source_type: 1,
    tags: [],
    raw_fingerprint: hash64('A|Summary')
  };

  try {
    const first = await service.insertArticles([row, row]);
    const second = await service.insertArticles([row]);

    assert.equal(first.candidates, 2);
    assert.equal(first.inserted, 1);
    assert.equal(second.inserted, 0);
    assert.equal(await service.countArticles(), 1);
  } finally {
    await service.close();
  }
});

test('fills missing summary and image_url on duplicate article insert', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rss-duckdb-'));
  const service = new DuckDBService(path.join(dir, 'rss.duckdb'));
  const url = 'https://example.com/video';
  const baseRow = {
    url_hash: hash64(url),
    url,
    feed_url: 'https://example.com/feed.xml',
    feed_title: 'Example',
    title: 'Video',
    summary: null,
    image_url: null,
    author: null,
    published_at: new Date('2026-04-26T00:00:00Z'),
    fetched_at: new Date('2026-04-27T00:00:00Z'),
    source_type: 2,
    tags: [],
    raw_fingerprint: hash64('Video')
  };

  try {
    await service.insertArticles([baseRow]);
    await service.insertArticles([{
      ...baseRow,
      summary: 'Video description',
      image_url: 'https://i.ytimg.com/vi/example/hqdefault.jpg'
    }]);

    const connection = await service.open();
    const reader = await connection.runAndReadAll(`
      SELECT summary, image_url
      FROM articles
      WHERE url_hash = ${String(baseRow.url_hash)}
    `);
    const [summary, imageUrl] = reader.getRowsJS()[0];

    assert.equal(summary, 'Video description');
    assert.equal(imageUrl, 'https://i.ytimg.com/vi/example/hqdefault.jpg');
  } finally {
    await service.close();
  }
});
