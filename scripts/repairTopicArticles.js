#!/usr/bin/env node
/**
 * Best-effort repair: rebuild topic_articles rows for dates where topics exist
 * but have zero article links (topic_articles was wiped by a legacy delete-based archive).
 *
 * For each broken topic, matches articles.title against topics.sample_headlines
 * (exact, case-insensitive). Inserts recovered (topic_id, url_hash) pairs.
 *
 * Usage:
 *   node scripts/repairTopicArticles.js [--date YYYY-MM-DD] [--dry-run]
 *
 * Without --date, repairs ALL dates that have topics with zero article links.
 * Stop the daemon before running (DB needs write access).
 */
import { DuckDBInstance } from '@duckdb/node-api';
import { DEFAULT_DB_PATH } from '../src/config.js';

function parseArgs() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const dateIdx = args.indexOf('--date');
  const date = dateIdx !== -1 ? args[dateIdx + 1] : null;
  return { dryRun, date };
}

async function main() {
  const { dryRun, date } = parseArgs();

  const inst = await DuckDBInstance.create(DEFAULT_DB_PATH, { threads: '2' });
  const conn = await inst.connect();

  try {
    // Find dates that have topics but zero topic_articles links
    const dateFilter = date ? `AND t.topic_date = DATE '${date}'` : '';
    const brokenResult = await conn.runAndReadAll(`
      SELECT t.topic_date::VARCHAR AS topic_date, COUNT(DISTINCT t.id) AS topic_count
      FROM topics t
      LEFT JOIN topic_articles ta ON ta.topic_id = t.id
      WHERE ta.topic_id IS NULL
        ${dateFilter}
      GROUP BY t.topic_date
      ORDER BY t.topic_date
    `);
    const brokenDates = brokenResult.getRowObjectsJS();

    if (!brokenDates.length) {
      console.log('No broken dates found — topic_articles links look intact.');
      return;
    }

    console.log(`Found ${brokenDates.length} date(s) with broken topic→article links:`);
    for (const row of brokenDates) {
      console.log(`  ${row.topic_date}: ${row.topic_count} topics with zero links`);
    }
    if (dryRun) { console.log('\n[dry-run] No changes made.'); return; }
    console.log('');

    let totalInserted = 0;

    for (const row of brokenDates) {
      const d = row.topic_date;

      // Fetch all topics for this date with their sample_headlines
      const topicsResult = await conn.runAndReadAll(`
        SELECT id, sample_headlines
        FROM topics
        WHERE topic_date = DATE '${d}'
          AND id NOT IN (SELECT DISTINCT topic_id FROM topic_articles)
      `);
      const topics = topicsResult.getRowObjectsJS();

      let dateInserted = 0;
      for (const topic of topics) {
        const headlines = topic.sample_headlines || [];
        if (!headlines.length) continue;

        for (const headline of headlines) {
          const escaped = String(headline).replace(/'/g, "''");
          const matchResult = await conn.runAndReadAll(`
            SELECT url_hash FROM articles
            WHERE LOWER(title) = LOWER('${escaped}')
            LIMIT 1
          `);
          const rows = matchResult.getRowsJS();
          if (!rows.length) continue;

          const urlHash = rows[0][0];
          await conn.run(`
            INSERT OR IGNORE INTO topic_articles (topic_id, url_hash)
            VALUES ('${topic.id}', ${String(urlHash)})
          `);
          dateInserted++;
          totalInserted++;
        }
      }

      console.log(`  ${d}: inserted ${dateInserted} topic_article links across ${topics.length} topics`);
    }

    await conn.run('CHECKPOINT');
    console.log(`\nDone. Total links inserted: ${totalInserted}`);
  } finally {
    try { conn.closeSync(); } catch {}
    try { inst.closeSync(); } catch {}
  }
}

main().catch(err => {
  console.error('Repair failed:', err.message);
  process.exit(1);
});
