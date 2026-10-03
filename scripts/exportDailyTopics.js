#!/usr/bin/env node
// Daily topic export CLI.
// Usage:
//   node scripts/exportDailyTopics.js             # yesterday (UTC)
//   node scripts/exportDailyTopics.js --date YYYY-MM-DD
//   node scripts/exportDailyTopics.js --backfill  # all dates not yet exported
//   node scripts/exportDailyTopics.js --backfill --force
//   node scripts/exportDailyTopics.js --recluster [--date YYYY-MM-DD] [--from YYYY-MM-DD]
//       Re-run topic detection before exporting (overwrites files). Needs write access, so the
//       fetcher daemon must be stopped. Without --date it walks every article date oldest-first
//       so each day's novelty/history is computed from already-reclustered days.
//   --no-summary  skip the OpenAI title/summary call
//   --no-push     write files only; by default changes under news/ are committed and pushed
//   node scripts/exportDailyTopics.js --overview [--date YYYY-MM-DD] [--force]
//       Add the AI "day in brief" to existing exports that lack one (the latest export when no
//       --date is given). Reads and rewrites only the JSON files; no database access.

import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DuckDBService } from '../src/services/duckdbService.js';
import { addOverviewToExport, exportNewsForDate } from '../src/services/newsExportService.js';
import { detectTopicsForDate } from '../src/services/topicDetectionService.js';
import { publishNews } from '../src/services/newsPublisher.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DB_PATH = process.env.DUCKDB_PATH || path.join(ROOT, 'data', 'rss.duckdb');
const NEWS_DIR = path.join(ROOT, 'news');
// Days below this are feed backlog (old items first seen later), not a real crawl day.
const MIN_ARTICLES_PER_DAY = 2000;

function yesterdayUTC() {
  return new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const valueOf = flag => {
    const index = args.indexOf(flag);
    return index !== -1 ? args[index + 1] : null;
  };
  return {
    backfill: args.includes('--backfill'),
    recluster: args.includes('--recluster'),
    force: args.includes('--force'),
    summarize: !args.includes('--no-summary'),
    push: !args.includes('--no-push'),
    overview: args.includes('--overview'),
    date: valueOf('--date'),
    from: valueOf('--from')
  };
}

async function getAllTopicDates(db) {
  const connection = await db.open();
  const reader = await connection.runAndReadAll(`
    SELECT DISTINCT CAST(topic_date AS VARCHAR) AS d FROM topics ORDER BY d
  `);
  return reader.getRowObjectsJS().map(r => r.d);
}

async function resolveDates(db, { backfill, recluster, force, date, from }) {
  if (date) return [date];
  if (recluster) {
    const today = new Date().toISOString().slice(0, 10);
    return (await db.getArticleDates(MIN_ARTICLES_PER_DAY))
      .filter(d => d < today && (!from || d >= from));
  }
  if (!backfill) return [yesterdayUTC()];

  const allDates = await getAllTopicDates(db);
  if (force) return allDates;
  const pending = [];
  for (const d of allDates) {
    try { await fs.access(path.join(NEWS_DIR, `${d}.json`)); } catch { pending.push(d); }
  }
  return pending;
}

async function addOverviews({ date, force }) {
  const { dates = [] } = JSON.parse(await fs.readFile(path.join(NEWS_DIR, 'index.json'), 'utf8'));
  const targets = date ? [date] : dates.slice(-1);
  for (const d of targets) {
    const points = await addOverviewToExport(d, { force });
    console.log(points ? `wrote overview news/${d}.json — ${points} points` : `skip  news/${d}.json — overview exists or could not be made`);
  }
}

async function main() {
  const options = parseArgs();
  process.chdir(ROOT);
  if (options.overview) await addOverviews(options);
  else await exportDates(options);
  if (options.push) await publish();
}

async function publish() {
  try {
    const result = await publishNews({ cwd: ROOT });
    if (result.skipped) console.warn(`\nNot published: ${result.skipped}`);
    else console.log(result.pushed ? '\nPublished: news/ pushed' : '\nPublished: nothing new to push');
  } catch (err) {
    console.error(`\nPublish failed (the daemon retries hourly): ${err.stderr || err.message}`);
    process.exitCode = 1;
  }
}

async function exportDates(options) {

  // Plain exports open read-only; reclustering rewrites the topics table.
  const db = new DuckDBService(DB_PATH, { readOnly: !options.recluster });
  await db.open();

  try {
    const dates = await resolveDates(db, options);
    if (!dates.length) {
      console.log('Nothing to export.');
      return;
    }

    // Drop dead rows first so each per-date replace touches only live data.
    if (options.recluster) await db.compactTopicTables();

    let written = 0;
    for (const d of dates) {
      if (options.recluster) {
        const startedAt = Date.now();
        const topics = await detectTopicsForDate(db, d);
        console.log(`topics ${d} — ${topics.length} topics in ${Date.now() - startedAt}ms`);
      }
      const articleCount = await exportNewsForDate(db, d, {
        force: options.force || options.recluster,
        summarize: options.summarize
      });
      if (articleCount === null) {
        console.log(`skip  news/${d}.json — already exists`);
      } else if (articleCount === 0) {
        console.log(`skip  news/${d}.json — no topics`);
      } else {
        const payload = JSON.parse(await fs.readFile(path.join(NEWS_DIR, `${d}.json`), 'utf8'));
        console.log(`wrote news/${d}.json — ${payload.topics.length} topics, ${articleCount} articles`);
        written++;
      }
    }

    if (options.recluster) await db.compactTopicTables();
    if (dates.length > 1) console.log(`\nDone: ${written}/${dates.length} date(s) written.`);
  } finally {
    await db.close();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
