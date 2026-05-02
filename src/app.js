import { createWriteStream, statSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);
import dotenv from 'dotenv';
import { loadFeedConfigs, DEFAULT_FEED_CONCURRENCY, DEFAULT_RUN_INTERVAL_MINUTES } from './config.js';
import { processFeed } from './services/feedProcessor.js';
import { feedCache } from './services/feedCacheService.js';
import { duckDBService } from './services/duckdbService.js';
import { detectTopicsForDate } from './services/topicDetectionService.js';
import { exportNewsForDate } from './services/newsExportService.js';

dotenv.config();

// Write timestamped logs directly to file with size-based rotation (5 MB → .1).
// The app owns the log file; launchd plist has no StandardOutPath.
(function setupFileLogger() {
  const LOG_DIR = 'logs';
  const LOG_FILE = join(LOG_DIR, 'rss_fetch.log');
  try { mkdirSync(LOG_DIR, { recursive: true }); } catch {}
  try {
    if (statSync(LOG_FILE).size > 5 * 1024 * 1024) renameSync(LOG_FILE, `${LOG_FILE}.1`);
  } catch {}
  const stream = createWriteStream(LOG_FILE, { flags: 'a' });
  const ts = () => new Date().toISOString();
  const fmt = args => args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  console.log   = (...a) => stream.write(`${ts()} [LOG]  ${fmt(a)}\n`);
  console.warn  = (...a) => stream.write(`${ts()} [WARN] ${fmt(a)}\n`);
  console.error = (...a) => stream.write(`${ts()} [ERR]  ${fmt(a)}\n`);
})();

const FLUSH_INTERVAL_MS = 30_000;
const FLUSH_SIZE_THRESHOLD = 500;

// Transient codes that are expected/noisy and get aggregated rather than per-feed warned.
const TRANSIENT_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE', 'ECONNABORTED', 'EREDIRECT']);

let isRunning = false;
let lastPruneDate = null;
let lastNewsExportDate = null;

function createFlusher(db) {
  const pending = [];
  let flushing = false;
  let totalCandidates = 0;
  let totalInserted = 0;
  let flushCount = 0;
  let totalInsertMs = 0;

  async function flush(label) {
    if (flushing || !pending.length) return;
    flushing = true;
    const rows = pending.splice(0);
    const t0 = Date.now();
    try {
      const result = await db.insertArticles(rows);
      totalCandidates += result.candidates;
      totalInserted += result.inserted;
      flushCount++;
      totalInsertMs += Date.now() - t0;
      console.log(`DB flush #${flushCount} [${label}]: ${rows.length} candidates, +${result.inserted} new`);
    } finally {
      flushing = false;
    }
  }

  return {
    push(rows) { pending.push(...rows); },
    maybeFlush() { return pending.length >= FLUSH_SIZE_THRESHOLD ? flush('size') : Promise.resolve(); },
    flush,
    get summary() {
      return {
        candidates: totalCandidates,
        inserted: totalInserted,
        flushCount,
        timing: { totalMs: totalInsertMs }
      };
    }
  };
}

export async function runOnce() {
  if (isRunning) {
    console.log('Previous run still active; skipping scheduled run.');
    return;
  }

  isRunning = true;
  const startedAt = Date.now();
  const timing = {};

  const flusher = createFlusher(duckDBService);
  let flushTimer = null;

  try {
    const initStartedAt = Date.now();
    await feedCache.load();
    timing.initMs = Date.now() - initStartedAt;

    const configStartedAt = Date.now();
    const feeds = (await loadFeedConfigs()).filter(feed => feed.enabled);
    const runFeeds = feeds.filter(feed => feedCache.shouldProcess(feed));
    timing.configMs = Date.now() - configStartedAt;

    if (!runFeeds.length) {
      console.log(`No feeds due. Configured=${feeds.length} timing init=${timing.initMs}ms config=${timing.configMs}ms`);
      return;
    }

    flushTimer = setInterval(
      () => flusher.flush('timer').catch(err => console.error('flush timer failed', err.message)),
      FLUSH_INTERVAL_MS
    );

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
        flusher.push(result.rows || []);
        feedCache.updateSuccess(feed, { itemCount: result.itemCount, insertedCount: 0 });
        await flusher.maybeFlush();
        return { success: true, feed, ...result };
      } catch (error) {
        feedCache.updateFailure(feed, error);
        return { success: false, feed, error };
      }
    });
    timing.feedsMs = Date.now() - feedStartedAt;

    clearInterval(flushTimer);
    flushTimer = null;

    const insertStartedAt = Date.now();
    await flusher.flush('final');
    const insertResult = flusher.summary;
    timing.insertMs = Date.now() - insertStartedAt;

    const cacheUpdateStartedAt = Date.now();
    await feedCache.save();
    timing.cacheUpdateMs = Date.now() - cacheUpdateStartedAt;

    const topicsStartedAt = Date.now();
    const today = new Date().toISOString().slice(0, 10);
    const topics = await detectTopicsForDate(duckDBService, today);
    timing.topicsMs = Date.now() - topicsStartedAt;

    const total = await duckDBService.countArticles();

    // Prune topics older than 30 days once per calendar day (first run of the day).
    const pruneStartedAt = Date.now();
    let prunedTopics = 0;
    if (!lastPruneDate || lastPruneDate !== today) {
      prunedTopics = await duckDBService.pruneOldTopics(30);
      lastPruneDate = today;
    }
    timing.pruneMs = Date.now() - pruneStartedAt;

    // Export yesterday's top topics to news/<date>.json once per calendar day, then commit+push.
    if (!lastNewsExportDate || lastNewsExportDate !== today) {
      const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
      try {
        const articleCount = await exportNewsForDate(duckDBService, yesterday);
        if (articleCount !== null && articleCount > 0) {
          console.log(`News export: wrote news/${yesterday}.json`);
          await gitCommitAndPush(`news/${yesterday}.json`, yesterday);
        }
        lastNewsExportDate = today;
      } catch (err) {
        console.warn(`News export failed: ${err.message}`);
      }
    }

    // Checkpoint WAL into the main DB file so the WAL stays small between runs.
    await duckDBService.checkpoint();

    const failed = results.filter(result => !result.success);
    const transientFailed = failed.filter(r => TRANSIENT_CODES.has(r.error?.code));
    const hardFailed = failed.filter(r => !TRANSIENT_CODES.has(r.error?.code));
    timing.totalMs = Date.now() - startedAt;

    console.log([
      `RSS run completed in ${(timing.totalMs / 1000).toFixed(2)}s`,
      `configured=${feeds.length}`,
      `skipped=${feeds.length - runFeeds.length}`,
      `fetched=${runFeeds.length}`,
      `concurrency=${DEFAULT_FEED_CONCURRENCY}`,
      `failed=${failed.length}(${transientFailed.length} transient)`,
      `candidates=${insertResult.candidates}`,
      `inserted=${insertResult.inserted}`,
      `total=${total}`,
      `flushes=${insertResult.flushCount}`,
      `pruned_topics=${prunedTopics}`,
      `timing init=${timing.initMs}ms`,
      `config=${timing.configMs}ms`,
      `feeds=${timing.feedsMs}ms`,
      `insert_total=${insertResult.timing.totalMs}ms`,
      `cache=${timing.cacheUpdateMs}ms`,
      `topics=${topics.length}`,
      `topics_ms=${timing.topicsMs}ms`
    ].join(' '));

    for (const failure of hardFailed) {
      const err = failure.error;
      const detail = [err.code, err.message].filter(Boolean).join(': ') || String(err);
      console.warn(`Feed failed: ${failure.feed.url} - ${detail}`);
    }

    printRunSummary({ total, insertResult, failed, runFeeds, skipped: feeds.length - runFeeds.length, topics });

    return { feeds, runFeeds, results, insertResult, timing };
  } catch (error) {
    console.error(`RSS run failed: ${error.message}`);
    return { error };
  } finally {
    if (flushTimer) clearInterval(flushTimer);
    isRunning = false;
  }
}

function printRunSummary({ total, insertResult, failed, runFeeds, skipped, topics }) {
  const date = new Date().toISOString().slice(0, 10);
  const totalStr = (total ?? 0).toLocaleString();
  const added = insertResult.inserted;
  const addedStr = added > 0 ? `+${added}` : String(added);
  const bar = '─'.repeat(52);

  console.log(`\n${bar}`);
  console.log(` RSS Run Summary  ${date}`);
  console.log(bar);
  console.log(` Total articles   ${totalStr.padStart(8)}  (${addedStr} new)`);
  console.log(` Feeds fetched    ${String(runFeeds.length).padStart(8)}  (${failed.length} failed, ${skipped} skipped)`);
  console.log(` Topics detected  ${String(topics.length).padStart(8)}`);

  const topTopics = topics.slice(0, 10);
  if (topTopics.length) {
    console.log(bar);
    console.log(' Top 10 Topics');
    for (let i = 0; i < topTopics.length; i++) {
      const t = topTopics[i];
      const label = (t.labelKeywords || []).slice(0, 5).join(', ');
      const score = typeof t.finalScore === 'number' ? t.finalScore.toFixed(2) : '—';
      const n = String(i + 1).padStart(2);
      console.log(`  ${n}. [${label}]  ${t.articleCount} arts  score=${score}`);
    }
  }

  console.log(`${bar}\n`);
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

async function gitCommitAndPush(filePath, date) {
  try {
    await execFile('git', ['add', filePath]);
    await execFile('git', ['commit', '-m', `news: add ${date} daily topics export`]);
    await execFile('git', ['push']);
    console.log(`News export: committed and pushed ${filePath}`);
  } catch (err) {
    console.warn(`News export git push failed: ${err.stderr || err.message}`);
  }
}

async function shutdown() {
  console.log('Shutting down...');
  clearInterval(interval);
  setTimeout(() => process.exit(1), 10_000).unref();
  await Promise.allSettled([feedCache.save(), duckDBService.close()]);
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGQUIT', shutdown);

// Exit non-zero on unhandled errors so launchd KeepAlive respawns the process.
process.on('uncaughtException', err => {
  console.error('Uncaught exception:', err.message, err.stack);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason instanceof Error ? reason.message : reason);
  process.exit(1);
});

// Open DB once at startup; it stays open for the process lifetime.
await duckDBService.open();

const interval = setInterval(runOnce, DEFAULT_RUN_INTERVAL_MINUTES * 60 * 1000);
console.log(`RSS fetcher started. Interval=${DEFAULT_RUN_INTERVAL_MINUTES}m`);
runOnce();
