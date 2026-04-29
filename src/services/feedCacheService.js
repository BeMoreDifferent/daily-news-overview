import { promises as fs } from 'fs';
import path from 'path';

const CACHE_FILE = path.join('data', 'feed_cache.json');

class FeedCacheService {
  constructor(filePath = CACHE_FILE) {
    this.filePath = filePath;
    this.cache = new Map();
    this.loaded = false;
  }

  async load() {
    if (this.loaded) return;

    try {
      const data = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
      for (const [feedUrl, entry] of Object.entries(data)) {
        this.cache.set(feedUrl, normalizeCacheEntry(entry));
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn(`Could not load feed cache: ${error.message}`);
      }
    }

    this.loaded = true;
  }

  async save() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const data = Object.fromEntries(this.cache.entries());
    const tempPath = `${this.filePath}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(data, null, 2));
    await fs.rename(tempPath, this.filePath);
  }

  shouldProcess(feed, now = Date.now()) {
    const entry = this.cache.get(feed.url);
    return !entry || !entry.nextPollAt || now >= entry.nextPollAt;
  }

  updateSuccess(feed, stats = {}, now = Date.now()) {
    this.cache.set(feed.url, {
      etag: stats.etag || null,
      lastModified: stats.lastModified || null,
      lastSuccessAt: new Date(now).toISOString(),
      lastFailureAt: null,
      failureCount: 0,
      lastItemCount: stats.itemCount || 0,
      lastInsertedCount: stats.insertedCount || 0,
      nextPollAt: now + feed.intervalMinutes * 60 * 1000
    });
  }

  updateFailure(feed, error, now = Date.now()) {
    const previous = this.cache.get(feed.url) || {};
    const failureCount = Number(previous.failureCount || 0) + 1;
    const retryDelayMinutes = Math.min(feed.intervalMinutes * 2 ** Math.min(failureCount - 1, 4), 24 * 60);

    this.cache.set(feed.url, {
      ...previous,
      lastFailureAt: new Date(now).toISOString(),
      failureCount,
      lastError: error?.message || String(error),
      nextPollAt: now + retryDelayMinutes * 60 * 1000
    });
  }

  getStatus(now = Date.now()) {
    const status = {};

    for (const [feedUrl, entry] of this.cache.entries()) {
      status[feedUrl] = {
        ...entry,
        due: !entry.nextPollAt || now >= entry.nextPollAt,
        nextPollInMs: entry.nextPollAt ? Math.max(0, entry.nextPollAt - now) : 0
      };
    }

    return status;
  }
}

function normalizeCacheEntry(entry) {
  if (!entry || typeof entry !== 'object') return {};

  if (entry.nextPollAt || entry.lastSuccessAt || entry.lastFailureAt) {
    return entry;
  }

  const lastProcessed = Number(entry.lastProcessed || 0);
  const ttl = Number(entry.ttl || 10 * 60 * 1000);

  return {
    etag: null,
    lastModified: null,
    lastSuccessAt: lastProcessed ? new Date(lastProcessed).toISOString() : null,
    lastFailureAt: null,
    failureCount: 0,
    lastItemCount: 0,
    lastInsertedCount: 0,
    nextPollAt: lastProcessed ? lastProcessed + ttl : 0
  };
}

export { FeedCacheService };
export const feedCache = new FeedCacheService();
