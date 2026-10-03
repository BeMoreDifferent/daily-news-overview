import { createWriteStream, statSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadFeedConfigs, DEFAULT_FEED_CONCURRENCY, DEFAULT_RUN_INTERVAL_MINUTES } from './config.js';
import { processFeed } from './services/feedProcessor.js';
import { feedCache } from './services/feedCacheService.js';
import { duckDBService } from './services/duckdbService.js';
import { detectTopicsForDate } from './services/topicDetectionService.js';
import { exportNewsForDate } from './services/newsExportService.js';
import { publishNews } from './services/newsPublisher.js';

// Write timestamped logs directly to file with size-based rotation (5 MB → .1), checked at startup
// and before every run. Errors also go to stderr, which launchd captures outside ~/Documents.
const LOG_DIR = 'logs';
const LOG_FILE = join(LOG_DIR, 'rss_fetch.log');
const LOG_MAX_BYTES = 5 * 1024 * 1024;
let logStream = null;

function openLogStream() {
  try { mkdirSync(LOG_DIR, { recursive: true }); } catch {}
  try {
    if (statSync(LOG_FILE).size > LOG_MAX_BYTES) renameSync(LOG_FILE, `${LOG_FILE}.1`);
  } catch {}
  const stream = createWriteStream(LOG_FILE, { flags: 'a' });
  stream.on('error', err => process.stderr.write(`[LOG STREAM ERROR] ${err.message}\n`));
  return stream;
}

function rotateLogIfNeeded() {
  try {
    if (statSync(LOG_FILE).size <= LOG_MAX_BYTES) return;
  } catch { return; }
  const previous = logStream;
  previous.end(() => {});
  logStream = openLogStream();
}

// Resolves once buffered log lines are on disk; used before process.exit so the reason for an
// exit is never lost.
function flushLogs() {
  return new Promise(resolve => {
    if (!logStream || logStream.writableEnded) return resolve();
    logStream.end(resolve);
    setTimeout(resolve, 2000).unref();
  });
}

(function setupFileLogger() {
  logStream = openLogStream();
  const ts = () => new Date().toISOString();
  const fmt = args => args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  const write = line => { if (!logStream.writableEnded) logStream.write(line); };
  console.log   = (...a) => write(`${ts()} [LOG]  ${fmt(a)}\n`);
  console.warn  = (...a) => write(`${ts()} [WARN] ${fmt(a)}\n`);
  console.error = (...a) => {
    const line = `${ts()} [ERR]  ${fmt(a)}\n`;
    write(line);
    process.stderr.write(line);
  };
})();

// DuckDB errors after which the instance is unusable; the old behaviour kept a poisoned instance
// alive and failed every hourly run for two months. Exiting lets launchd start a fresh process.
const FATAL_DB_ERROR = /Out of Memory|TransactionContext|FATAL|database has been invalidated/i;
const SLOW_FEED_MS = 5000;

const FLUSH_INTERVAL_MS = 30_000;
const FLUSH_SIZE_THRESHOLD = 500;

// Transient codes that are expected/noisy and get aggregated rather than per-feed warned.
const TRANSIENT_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE', 'ECONNABORTED', 'EREDIRECT']);

let isRunning = false;

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
  rotateLogIfNeeded();
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
        if (result.timing.totalMs >= SLOW_FEED_MS) {
          console.log([
            'Slow feed',
            `url=${feed.url}`,
            `items=${result.itemCount}`,
            `fetch_parse=${result.timing.fetchParseMs}ms`,
            `total=${result.timing.totalMs}ms`
          ].join(' '));
        }
        flusher.push(result.rows || []);
        feedCache.updateSuccess(feed, { itemCount: result.itemCount, insertedCount: 0 });
        await flusher.maybeFlush();
        // Don't spread result.rows into the return — keeping all article rows
        // referenced in the results array would hold the entire run's articles in
        // memory until the run completes, causing OOM with 2400+ feeds.
        return { success: true, feed };
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

    const total = await duckDBService.countArticles();

    // Topic clustering runs once per day for the completed day, not hourly: hourly
    // replace-all of today's topics left ~15x dead rows in the topics tables.
    const topicsStartedAt = Date.now();
    const topics = await exportYesterdayIfMissing();
    timing.topicsMs = Date.now() - topicsStartedAt;
    // Every run, not only after an export, so a push that failed earlier is retried hourly.
    await publishNewsSafely();

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
    if (FATAL_DB_ERROR.test(error.message)) {
      await feedCache.save().catch(() => {});
      await exitWithLogs(1, 'Fatal database error; exiting so launchd restarts a fresh process.');
    }
    return { error };
  } finally {
    if (flushTimer) clearInterval(flushTimer);
    // Save cache on any exit path so partial run progress is preserved.
    // Without this, a crash leaves the cache stale and the next run retries
    // all 2400+ feeds, compounding the memory pressure.
    await feedCache.save().catch(err => console.warn('Cache save failed in finally:', err.message));
    isRunning = false;
  }
}

// Once per day (retried every run until it succeeds): re-cluster yesterday with the complete day
// of articles and export news/<yesterday>.json (one OpenAI summary call); publishNewsSafely pushes it.
// Returns the day's detected topics (empty when nothing was due).
async function exportYesterdayIfMissing() {
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const relPath = `news/${yesterday}.json`;
  if (existsSync(relPath)) return [];

  let topics = [];
  try {
    const startedAt = Date.now();
    topics = await detectTopicsForDate(duckDBService, yesterday);
    const exportTimeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('news export timed out after 3 min')), 180_000).unref()
    );
    const articleCount = await Promise.race([exportNewsForDate(duckDBService, yesterday), exportTimeout]);
    if (articleCount) {
      console.log(`News export: wrote ${relPath} in ${Date.now() - startedAt}ms`);
    } else {
      console.warn(`News export: no topics for ${yesterday}`);
    }
  } catch (err) {
    console.warn(`News export failed (will retry next run): ${err.message}`);
    if (FATAL_DB_ERROR.test(err.message)) throw err;
  }
  return topics;
}

async function exitWithLogs(code, message) {
  if (message) console.error(message);
  await flushLogs();
  process.exit(code);
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
    console.log(' Top 10 Topics (yesterday)');
    for (let i = 0; i < topTopics.length; i++) {
      const t = topTopics[i];
      const label = t.sampleHeadlines?.[0] || (t.labelKeywords || []).slice(0, 5).join(', ');
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

async function publishNewsSafely() {
  try {
    const result = await publishNews();
    if (result.skipped) console.warn(`News publish skipped: ${result.skipped}`);
    else if (result.pushed) console.log(`News publish: ${result.committed ? 'committed and ' : ''}pushed news/`);
  } catch (err) {
    console.warn(`News publish failed (will retry next run): ${err.stderr || err.message}`);
  }
}

async function shutdown() {
  console.log('Shutting down...');
  clearInterval(interval);
  setTimeout(() => process.exit(1), 10_000).unref();
  await Promise.allSettled([feedCache.save(), duckDBService.close()]);
  await exitWithLogs(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGQUIT', shutdown);

// Exit non-zero on unhandled errors so launchd KeepAlive respawns the process.
process.on('uncaughtException', err => {
  exitWithLogs(1, `Uncaught exception: ${err.message} ${err.stack}`);
});
process.on('unhandledRejection', (reason) => {
  exitWithLogs(1, `Unhandled rejection: ${reason instanceof Error ? reason.message : reason}`);
});

// Open DB once at startup; it stays open for the process lifetime.
await duckDBService.open();

const interval = setInterval(runOnce, DEFAULT_RUN_INTERVAL_MINUTES * 60 * 1000);
console.log(`RSS fetcher started. Interval=${DEFAULT_RUN_INTERVAL_MINUTES}m`);
runOnce();
