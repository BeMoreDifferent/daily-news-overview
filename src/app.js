import dotenv from 'dotenv';
import { loadFeedConfigs, DEFAULT_FEED_CONCURRENCY, DEFAULT_RUN_INTERVAL_MINUTES } from './config.js';
import { processFeed } from './services/feedProcessor.js';
import { feedCache } from './services/feedCacheService.js';
import { duckDBService } from './services/duckdbService.js';
import { detectTopicsForDate } from './services/topicDetectionService.js';

dotenv.config();

let isRunning = false;
let interval = null;

export async function runOnce(options = {}) {
  if (isRunning) {
    console.log('Previous run still active; skipping scheduled run.');
    return;
  }

  isRunning = true;
  const startedAt = Date.now();
  const timing = {};

  try {
    const initStartedAt = Date.now();
    await feedCache.load();
    await duckDBService.open();
    timing.initMs = Date.now() - initStartedAt;

    const configStartedAt = Date.now();
    const feeds = (await loadFeedConfigs()).filter(feed => feed.enabled);
    const maxFeeds = Number(options.maxFeeds || process.env.MAX_FEEDS_PER_RUN || 0);
    const runFeeds = feeds.slice(0, maxFeeds > 0 ? maxFeeds : undefined);
    timing.configMs = Date.now() - configStartedAt;

    if (!runFeeds.length) {
      console.log(`No feeds enabled. Configured=${feeds.length} timing init=${timing.initMs}ms config=${timing.configMs}ms`);
      return;
    }

    const feedStartedAt = Date.now();
    const results = await mapConcurrent(runFeeds, DEFAULT_FEED_CONCURRENCY, async feed => {
      try {
        const result = await processFeed(feed);
        console.log([
          'Feed timing',
          `url=${feed.url}`,
          `items=${result.itemCount}`,
          `candidates=${result.candidateCount}`,
          `fetch_parse=${result.timing.fetchParseMs}ms`,
          `map=${result.timing.mapMs}ms`,
          `total=${result.timing.totalMs}ms`
        ].join(' '));
        feedCache.updateSuccess(feed, {
          itemCount: result.itemCount,
          insertedCount: 0
        });
        return { success: true, feed, ...result };
      } catch (error) {
        feedCache.updateFailure(feed, error);
        return { success: false, feed, error };
      }
    });
    timing.feedsMs = Date.now() - feedStartedAt;

    const flattenStartedAt = Date.now();
    const rows = results.flatMap(result => result.rows || []);
    timing.flattenMs = Date.now() - flattenStartedAt;

    const insertStartedAt = Date.now();
    const insertResult = await duckDBService.insertArticles(rows);
    timing.insertMs = Date.now() - insertStartedAt;

    const cacheUpdateStartedAt = Date.now();
    for (const result of results) {
      if (result.success) {
        const insertedForFeed = rows.length
          ? Math.round(insertResult.inserted * ((result.rows?.length || 0) / rows.length))
          : 0;
        feedCache.updateSuccess(result.feed, {
          itemCount: result.itemCount,
          insertedCount: insertedForFeed
        });
      }
    }
    timing.cacheUpdateMs = Date.now() - cacheUpdateStartedAt;

    const cacheSaveStartedAt = Date.now();
    await feedCache.save();
    timing.cacheSaveMs = Date.now() - cacheSaveStartedAt;

    const topicsStartedAt = Date.now();
    const today = new Date().toISOString().slice(0, 10);
    const topics = await detectTopicsForDate(duckDBService, today);
    timing.topicsMs = Date.now() - topicsStartedAt;

    const failed = results.filter(result => !result.success);
    timing.totalMs = Date.now() - startedAt;

    console.log([
      `RSS run completed in ${(timing.totalMs / 1000).toFixed(2)}s`,
      `configured=${feeds.length}`,
      `fetched=${runFeeds.length}`,
      `concurrency=${DEFAULT_FEED_CONCURRENCY}`,
      `failed=${failed.length}`,
      `candidates=${insertResult.candidates}`,
      `inserted=${insertResult.inserted}`,
      `timing init=${timing.initMs}ms`,
      `config=${timing.configMs}ms`,
      `feeds=${timing.feedsMs}ms`,
      `flatten=${timing.flattenMs}ms`,
      `insert=${timing.insertMs}ms`,
      `cache_update=${timing.cacheUpdateMs}ms`,
      `cache_save=${timing.cacheSaveMs}ms`,
      `db_stage=${insertResult.timing.stageMs}ms`,
      `db_insert=${insertResult.timing.insertMs}ms`,
      `db_total=${insertResult.timing.totalMs}ms`,
      `topics=${topics.length}`,
      `topics_ms=${timing.topicsMs}ms`
    ].join(' '));

    for (const failure of failed.slice(0, 10)) {
      console.warn(`Feed failed: ${failure.feed.url} - ${failure.error.message}`);
    }

    return {
      feeds,
      runFeeds,
      results,
      insertResult,
      timing
    };
  } catch (error) {
    console.error(`RSS run failed: ${error.message}`);
    return { error };
  } finally {
    await duckDBService.close().catch(() => {});
    isRunning = false;
  }
}

function start() {
  runOnce();
  interval = setInterval(runOnce, DEFAULT_RUN_INTERVAL_MINUTES * 60 * 1000);
  console.log(`RSS fetcher started. Interval=${DEFAULT_RUN_INTERVAL_MINUTES}m`);
}

async function shutdown() {
  if (interval) clearInterval(interval);
  await feedCache.save().catch(() => {});
  await duckDBService.close();
  process.exit(0);
}

async function mapConcurrent(items, concurrency, mapper) {
  const results = new Array(items.length);
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const currentIndex = index++;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGQUIT', shutdown);

if (process.env.RUN_ONCE === '1') {
  await runOnce();
  await duckDBService.close();
  process.exit(0);
} else {
  start();
}
