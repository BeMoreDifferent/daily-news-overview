#!/usr/bin/env node
/**
 * Archive articles older than --keep-days to date-partitioned ZSTD Parquet.
 *
 * Strategy: NULL-out heavy columns in the hot DB (summary, image_url, author,
 * feed_title, tags, raw_fingerprint) instead of deleting rows.  This preserves
 * the url_hash PRIMARY KEY so INSERT OR IGNORE dedup keeps working for articles
 * that reappear in feeds after being archived.  Full article data lives in the
 * Parquet archive and is queryable via read_parquet('data/archive/*.parquet').
 *
 * Flags:
 *   --dry-run          Show what would be archived without making changes
 *   --keep-days N      Hot-DB retention window in days (default: 30)
 *   --repair           One-time repair: re-import stub rows for any archive
 *                      entries that were previously DELETEd from the hot DB,
 *                      null-out all archived rows, and trim existing summaries
 *                      to 500 chars.  Run once after upgrading from the old
 *                      DELETE-based archive approach.
 */
import { DuckDBInstance } from '@duckdb/node-api';
import { DEFAULT_DB_PATH } from '../src/config.js';
import { promises as fs } from 'fs';
import path from 'path';
import { glob } from 'fs/promises';

const ARCHIVE_DIR = path.join('data', 'archive');
const SUMMARY_MAX = 500;

// Columns exported to Parquet (full fidelity)
const ALL_COLS = 'url_hash, url, feed_url, feed_title, title, summary, image_url, author, published_at, fetched_at, source_type, tags, raw_fingerprint';
// Minimal columns kept in hot DB after archiving (enough for dedup + queries)
const STUB_COLS = 'url_hash, url, feed_url, published_at, fetched_at, source_type';

function parseArgs() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const repair = args.includes('--repair');
  const keepIdx = args.indexOf('--keep-days');
  const keepDays = keepIdx >= 0 ? parseInt(args[keepIdx + 1], 10) : 30;
  if (!Number.isFinite(keepDays) || keepDays < 1) {
    console.error('--keep-days must be a positive integer');
    process.exit(1);
  }
  return { dryRun, repair, keepDays };
}

async function fileExists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function existingParquetPaths() {
  const files = [];
  try {
    for await (const f of glob('data/archive/*.parquet')) files.push(path.resolve(f));
  } catch {}
  return files;
}

// ── repair ────────────────────────────────────────────────────────────────────

async function repair(conn) {
  console.log('=== Repair mode ===\n');

  const parquets = await existingParquetPaths();
  if (!parquets.length) {
    console.log('No archive Parquet files found — nothing to repair.');
    return;
  }

  const parquetGlob = 'data/archive/*.parquet';

  // 1. Re-import stub rows for archive entries that were DELETEd from hot DB
  process.stdout.write('Re-importing missing stub rows from archive... ');
  await conn.run(`
    INSERT OR IGNORE INTO articles (${STUB_COLS})
    SELECT ${STUB_COLS} FROM read_parquet('${parquetGlob}')
  `);
  // DuckDB doesn't expose changes() so count via overlap
  const overlapResult = await conn.runAndReadAll(`
    SELECT COUNT(*) FROM articles
    WHERE url_hash IN (SELECT url_hash FROM read_parquet('${parquetGlob}'))
  `);
  console.log(`done. ${Number(overlapResult.getRowsJS()[0][0])} articles now have a hot DB stub.`);

  // 2. NULL-out heavy columns for every archived article in the hot DB
  process.stdout.write('Nulling heavy columns for all archived rows... ');
  await conn.run(`
    UPDATE articles
    SET
      summary        = NULL,
      image_url      = NULL,
      author         = NULL,
      feed_title     = NULL,
      tags           = NULL,
      raw_fingerprint = NULL
    WHERE url_hash IN (SELECT url_hash FROM read_parquet('${parquetGlob}'))
      AND (summary IS NOT NULL OR image_url IS NOT NULL OR author IS NOT NULL)
  `);
  console.log('done.');

  // 3. Trim existing summaries > SUMMARY_MAX on non-archived articles
  process.stdout.write(`Trimming summaries > ${SUMMARY_MAX} chars on hot articles... `);
  const beforeTrim = await conn.runAndReadAll(`
    SELECT COUNT(*) FROM articles WHERE LENGTH(summary) > ${SUMMARY_MAX}
  `);
  const toTrim = Number(beforeTrim.getRowsJS()[0][0]);
  if (toTrim > 0) {
    await conn.run(`
      UPDATE articles
      SET summary = LEFT(summary, ${SUMMARY_MAX})
      WHERE LENGTH(summary) > ${SUMMARY_MAX}
    `);
  }
  console.log(`done. Trimmed ${toTrim} articles.`);

  // 4. CHECKPOINT
  process.stdout.write('Checkpointing... ');
  await conn.run('CHECKPOINT');
  console.log('done.\n');

  // Summary
  const hotResult = await conn.runAndReadAll('SELECT COUNT(*) FROM articles');
  const stubResult = await conn.runAndReadAll(`
    SELECT COUNT(*) FROM articles
    WHERE summary IS NULL AND image_url IS NULL AND url_hash IN (
      SELECT url_hash FROM read_parquet('${parquetGlob}')
    )
  `);
  const fullResult = await conn.runAndReadAll(`
    SELECT COUNT(*) FROM articles WHERE summary IS NOT NULL OR title IS NOT NULL
  `);
  console.log(`Hot DB total:  ${Number(hotResult.getRowsJS()[0][0])} articles`);
  console.log(`  stub rows:   ${Number(stubResult.getRowsJS()[0][0])} (archived, dedup-only)`);
  console.log(`  full rows:   ${Number(fullResult.getRowsJS()[0][0])} (recent, full content)`);
}

// ── main archive loop ─────────────────────────────────────────────────────────

async function main() {
  const { dryRun, repair: doRepair, keepDays } = parseArgs();
  await fs.mkdir(ARCHIVE_DIR, { recursive: true });

  const inst = await DuckDBInstance.create(DEFAULT_DB_PATH, { threads: '4' });
  const conn = await inst.connect();

  try {
    if (doRepair) {
      await repair(conn);
      return;
    }

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - keepDays);
    const cutoffStr = cutoff.toISOString().slice(0, 19).replace('T', ' ');

    // Only consider rows that still have content (stub rows are already archived)
    const monthsResult = await conn.runAndReadAll(`
      SELECT strftime(fetched_at, '%Y-%m') AS month, COUNT(*) AS cnt
      FROM articles
      WHERE fetched_at < TIMESTAMP '${cutoffStr}'
        AND (summary IS NOT NULL OR image_url IS NOT NULL OR title IS NOT NULL)
      GROUP BY month
      ORDER BY month
    `);
    const months = monthsResult.getRowObjectsJS();

    const sizeBefore = (await fs.stat(DEFAULT_DB_PATH)).size;
    console.log(`DB size before: ${(sizeBefore / 1024 / 1024).toFixed(1)} MB`);
    console.log(`Keep threshold: fetched_at >= ${cutoffStr} (last ${keepDays} days)`);

    if (!months.length) {
      console.log('Nothing to archive.');
      return;
    }

    const totalCandidates = months.reduce((s, r) => s + Number(r.cnt), 0);
    console.log(`\nFound ${totalCandidates} articles in ${months.length} month(s) to archive${dryRun ? ' [DRY RUN]' : ''}:\n`);

    let totalArchived = 0;

    for (const row of months) {
      const month = String(row.month);
      const cnt = Number(row.cnt);
      const parquetPath = path.resolve(ARCHIVE_DIR, `${month}.parquet`);
      const tmpPath = parquetPath + '.tmp';
      const exists = await fileExists(parquetPath);

      if (dryRun) {
        const tag = exists ? ' (merge with existing)' : '';
        console.log(`  ${month}: ${cnt} articles → ${path.relative('.', parquetPath)}${tag}`);
        totalArchived += cnt;
        continue;
      }

      // Export full article data to Parquet (merge if file already exists)
      if (exists) {
        await conn.run(`
          COPY (
            SELECT ${ALL_COLS} FROM read_parquet('${parquetPath}')
            UNION ALL
            SELECT ${ALL_COLS} FROM articles
            WHERE strftime(fetched_at, '%Y-%m') = '${month}'
              AND fetched_at < TIMESTAMP '${cutoffStr}'
              AND (summary IS NOT NULL OR image_url IS NOT NULL OR title IS NOT NULL)
              AND url_hash NOT IN (SELECT url_hash FROM read_parquet('${parquetPath}'))
          ) TO '${tmpPath}' (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 100000)
        `);
      } else {
        await conn.run(`
          COPY (
            SELECT ${ALL_COLS} FROM articles
            WHERE strftime(fetched_at, '%Y-%m') = '${month}'
              AND fetched_at < TIMESTAMP '${cutoffStr}'
              AND (summary IS NOT NULL OR image_url IS NOT NULL OR title IS NOT NULL)
          ) TO '${tmpPath}' (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 100000)
        `);
      }

      // Verify before committing
      const verify = await conn.runAndReadAll(`SELECT COUNT(*) FROM read_parquet('${tmpPath}')`);
      const exported = Number(verify.getRowsJS()[0][0]);
      if (exported === 0 && cnt > 0) throw new Error(`Parquet export was empty for ${month}`);
      await fs.rename(tmpPath, parquetPath);

      // Archive topics and topic_articles for this month (belt-and-suspenders backup;
      // topics are no longer pruned from hot DB, but Parquet ensures they survive any future deletion).
      const topicsParquetPath = path.resolve(ARCHIVE_DIR, `topics-${month}.parquet`);
      const topicsTmpPath = topicsParquetPath + '.tmp';
      const topicsParquetExists = await fileExists(topicsParquetPath);
      if (topicsParquetExists) {
        await conn.run(`
          COPY (
            SELECT * FROM read_parquet('${topicsParquetPath}')
            UNION ALL BY NAME
            SELECT * FROM topics
            WHERE strftime(CAST(topic_date AS TIMESTAMP), '%Y-%m') = '${month}'
              AND id NOT IN (SELECT id FROM read_parquet('${topicsParquetPath}'))
          ) TO '${topicsTmpPath}' (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 100000)
        `);
      } else {
        await conn.run(`
          COPY (
            SELECT * FROM topics
            WHERE strftime(CAST(topic_date AS TIMESTAMP), '%Y-%m') = '${month}'
          ) TO '${topicsTmpPath}' (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 100000)
        `);
      }
      const topicsVerify = await conn.runAndReadAll(`SELECT COUNT(*) FROM read_parquet('${topicsTmpPath}')`);
      if (Number(topicsVerify.getRowsJS()[0][0]) > 0) await fs.rename(topicsTmpPath, topicsParquetPath);
      else try { await fs.unlink(topicsTmpPath); } catch {}

      const taParquetPath = path.resolve(ARCHIVE_DIR, `topic_articles-${month}.parquet`);
      const taTmpPath = taParquetPath + '.tmp';
      const taParquetExists = await fileExists(taParquetPath);
      if (taParquetExists) {
        await conn.run(`
          COPY (
            SELECT * FROM read_parquet('${taParquetPath}')
            UNION ALL BY NAME
            SELECT ta.* FROM topic_articles ta
            JOIN topics t ON t.id = ta.topic_id
            WHERE strftime(CAST(t.topic_date AS TIMESTAMP), '%Y-%m') = '${month}'
              AND ta.topic_id NOT IN (SELECT topic_id FROM read_parquet('${taParquetPath}'))
          ) TO '${taTmpPath}' (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 100000)
        `);
      } else {
        await conn.run(`
          COPY (
            SELECT ta.* FROM topic_articles ta
            JOIN topics t ON t.id = ta.topic_id
            WHERE strftime(CAST(t.topic_date AS TIMESTAMP), '%Y-%m') = '${month}'
          ) TO '${taTmpPath}' (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 100000)
        `);
      }
      const taVerify = await conn.runAndReadAll(`SELECT COUNT(*) FROM read_parquet('${taTmpPath}')`);
      if (Number(taVerify.getRowsJS()[0][0]) > 0) await fs.rename(taTmpPath, taParquetPath);
      else try { await fs.unlink(taTmpPath); } catch {}

      // NULL-out heavy columns in hot DB — keeps url_hash for dedup
      await conn.run(`
        UPDATE articles
        SET
          summary         = NULL,
          image_url       = NULL,
          author          = NULL,
          feed_title      = NULL,
          tags            = NULL,
          raw_fingerprint = NULL
        WHERE strftime(fetched_at, '%Y-%m') = '${month}'
          AND fetched_at < TIMESTAMP '${cutoffStr}'
      `);

      const parquetSize = (await fs.stat(parquetPath)).size;
      console.log(`  ${month}: ${cnt} articles → ${path.relative('.', parquetPath)} (${(parquetSize / 1024 / 1024).toFixed(2)} MB)`);
      totalArchived += cnt;
    }

    if (dryRun) {
      console.log(`\nWould archive ${totalArchived} articles.`);
      return;
    }

    if (totalArchived > 0) {
      process.stdout.write('\nCheckpointing... ');
      await conn.run('CHECKPOINT');
      console.log('done.');
    }

    const hotResult = await conn.runAndReadAll('SELECT COUNT(*) FROM articles');
    const hotCount = Number(hotResult.getRowsJS()[0][0]);

    conn.closeSync();
    inst.closeSync();

    const sizeAfter = (await fs.stat(DEFAULT_DB_PATH)).size;
    const savedMB = (sizeBefore - sizeAfter) / 1024 / 1024;
    console.log(`\nArchived ${totalArchived} articles.`);
    console.log(`Hot DB: ${hotCount} total rows (recent: full content, older: stub for dedup).`);
    console.log(`DB: ${(sizeBefore / 1024 / 1024).toFixed(1)} MB → ${(sizeAfter / 1024 / 1024).toFixed(1)} MB (${savedMB >= 0 ? '-' : '+'}${Math.abs(savedMB).toFixed(1)} MB)`);
    return;
  } finally {
    try { conn.closeSync(); } catch {}
    try { inst.closeSync(); } catch {}
  }
}

main().catch(err => {
  console.error('Archive failed:', err.message);
  process.exit(1);
});
