import { promises as fs } from 'fs';
import path from 'path';

export const DEFAULT_RUN_INTERVAL_MINUTES = Number(process.env.RUN_INTERVAL_MINUTES || 60);
export const DEFAULT_FEED_INTERVAL_MINUTES = Number(process.env.FEED_INTERVAL_MINUTES || 10);
export const DEFAULT_FEED_CONCURRENCY = Number(process.env.FEED_CONCURRENCY || 50);
export const DEFAULT_FEED_TIMEOUT_MS = Number(process.env.FEED_TIMEOUT_MS || 5000);
export const DEFAULT_MAX_ITEMS_PER_FEED = Number(process.env.MAX_ITEMS_PER_FEED || 50);
export const DEFAULT_RECENT_DAYS = Number(process.env.RECENT_DAYS || 3);
export const DEFAULT_DB_PATH = process.env.DUCKDB_PATH || path.join('data', 'rss.duckdb');

const SOURCE_TYPES = new Map([
  ['news', 1],
  ['article', 1],
  ['youtube', 2],
  ['research', 3],
  ['arxiv', 3]
]);

export function sourceTypeToId(sourceType, feedUrl = '') {
  const normalized = String(sourceType || '').toLowerCase();
  if (SOURCE_TYPES.has(normalized)) {
    return SOURCE_TYPES.get(normalized);
  }
  if (feedUrl.includes('youtube.com/feeds/videos.xml')) {
    return 2;
  }
  if (feedUrl.includes('arxiv.org/rss/')) {
    return 3;
  }
  return 1;
}

export function normalizeFeedConfig(entry, index = 0) {
  const feed = typeof entry === 'string' ? { url: entry } : { ...entry };
  const url = typeof feed.url === 'string' ? feed.url.trim() : '';

  if (!url) {
    throw new Error(`Invalid feed config at index ${index}: missing url`);
  }

  return {
    url,
    enabled: feed.enabled !== false,
    intervalMinutes: positiveNumber(feed.intervalMinutes, DEFAULT_FEED_INTERVAL_MINUTES),
    maxItems: positiveNumber(feed.maxItems, DEFAULT_MAX_ITEMS_PER_FEED),
    sourceType: sourceTypeToId(feed.sourceType, url)
  };
}

export async function loadFeedConfigs(filePath = path.join('data', 'rss_feeds.json')) {
  const raw = await fs.readFile(filePath, 'utf8');
  const entries = JSON.parse(raw);

  if (!Array.isArray(entries)) {
    throw new Error(`${filePath} must contain an array of feed URLs or feed config objects`);
  }

  return entries.map(normalizeFeedConfig);
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}
