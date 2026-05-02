#!/usr/bin/env node
// Daily topic export CLI.
// Usage:
//   node scripts/exportDailyTopics.js             # yesterday (UTC)
//   node scripts/exportDailyTopics.js --date YYYY-MM-DD
//   node scripts/exportDailyTopics.js --backfill  # all dates not yet exported
//   node scripts/exportDailyTopics.js --backfill --force

import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DuckDBInstance } from '@duckdb/node-api';
import { exportNewsForDate } from '../src/services/newsExportService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DB_PATH = process.env.DUCKDB_PATH || path.join(ROOT, 'data', 'rss.duckdb');
const NEWS_DIR = path.join(ROOT, 'news');

function yesterdayUTC() {
  return new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
}

function escapeSql(value) {
  return String(value ?? '').replace(/'/g, '\'\'');
}

function parseArgs() {
  const args = process.argv.slice(2);
  const backfill = args.includes('--backfill');
  const force = args.includes('--force');
  const dateIdx = args.indexOf('--date');
  const date = dateIdx !== -1 ? args[dateIdx + 1] : null;
  return { backfill, force, date };
}

// Minimal adapter: wraps a raw DuckDB connection to match the db interface expected by exportNewsForDate
function makeDbAdapter(conn) {
  return {
    async getTopicsBetweenDates(startDate, endDate) {
      const esc = v => String(v ?? '').replace(/'/g, '\'\'');
      const reader = await conn.runAndReadAll(`
        SELECT
          id,
          status,
          label_keywords      AS labelKeywords,
          entities,
          article_count       AS articleCount,
          unique_source_count AS uniqueSourceCount,
          final_score         AS finalScore,
          sample_headlines    AS sampleHeadlines,
          theme_id            AS themeId,
          theme_label         AS themeLabel
        FROM topics
        WHERE topic_date BETWEEN DATE '${esc(startDate)}' AND DATE '${esc(endDate)}'
        ORDER BY topic_date DESC, final_score DESC
      `);
      return reader.getRowObjectsJS();
    },
    async getArticlesForTopic(topicId, limit = 5) {
      const esc = v => String(v ?? '').replace(/'/g, '\'\'');
      const reader = await conn.runAndReadAll(`
        SELECT a.title, a.url, a.feed_title, a.published_at, a.image_url
        FROM topic_articles ta
        JOIN articles a ON a.url_hash = ta.url_hash
        WHERE ta.topic_id = '${esc(topicId)}' AND a.title IS NOT NULL
        ORDER BY COALESCE(a.published_at, a.fetched_at) DESC
        LIMIT ${Number(limit)}
      `);
      return reader.getRowObjectsJS();
    }
  };
}

async function getAllTopicDates(conn) {
  const reader = await conn.runAndReadAll(`
    SELECT DISTINCT CAST(topic_date AS VARCHAR) AS d FROM topics ORDER BY d
  `);
  return reader.getRowObjectsJS().map(r => r.d);
}

async function main() {
  const { backfill, force, date } = parseArgs();

  // Open read-only — safe to run while the fetcher daemon holds the DB write lock.
  const inst = await DuckDBInstance.create(DB_PATH, { access_mode: 'READ_ONLY', threads: '2' });
  const conn = await inst.connect();
  const db = makeDbAdapter(conn);

  try {
    let dates;

    if (backfill) {
      const allDates = await getAllTopicDates(conn);
      if (!force) {
        const pending = [];
        for (const d of allDates) {
          try { await fs.access(path.join(NEWS_DIR, `${d}.json`)); }
          catch { pending.push(d); }
        }
        dates = pending;
      } else {
        dates = allDates;
      }
    } else {
      dates = [date || yesterdayUTC()];
    }

    if (!dates.length) {
      console.log('Nothing to export.');
      return;
    }

    let written = 0;
    for (const d of dates) {
      const articleCount = await exportNewsForDate(db, d, { force });
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

    if (backfill) console.log(`\nBackfill complete: ${written}/${dates.length} date(s) written.`);
  } finally {
    conn.closeSync();
    inst.closeSync();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
