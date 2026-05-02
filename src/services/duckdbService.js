import { promises as fs } from 'fs';
import path from 'path';
import { DuckDBInstance, LIST, VARCHAR, timestampValue } from '@duckdb/node-api';
import { DEFAULT_DB_PATH } from '../config.js';
import { vectorToObject } from './topicDetectionService.js';

const STAGE_TABLE = 'article_stage';

class DuckDBService {
  constructor(dbPath = DEFAULT_DB_PATH) {
    this.dbPath = dbPath;
    this.instance = null;
    this.connection = null;
  }

  async open() {
    if (this.connection) return this.connection;
    if (this._opening) return this._opening;
    this._opening = (async () => {
      await fs.mkdir(path.dirname(this.dbPath), { recursive: true });
      this.instance = await DuckDBInstance.create(this.dbPath, {
        threads: String(process.env.DUCKDB_THREADS || 2)
      });
      this.connection = await this.instance.connect();
      await this.initializeSchema();
      return this.connection;
    })().finally(() => { this._opening = null; });
    return this._opening;
  }

  async close() {
    if (this.connection) {
      this.connection.closeSync();
      this.connection = null;
    }
    if (this.instance) {
      this.instance.closeSync();
      this.instance = null;
    }
  }

  async initializeSchema() {
    const connection = await this.open();
    await connection.run(`
      CREATE TABLE IF NOT EXISTS articles (
        url_hash UBIGINT PRIMARY KEY,
        url VARCHAR NOT NULL,
        feed_url VARCHAR NOT NULL,
        feed_title VARCHAR,
        title VARCHAR,
        summary VARCHAR,
        image_url VARCHAR,
        author VARCHAR,
        published_at TIMESTAMP,
        fetched_at TIMESTAMP NOT NULL,
        source_type UTINYINT NOT NULL,
        tags VARCHAR[]
      )
    `);

    // One-time migration: drop raw_fingerprint from existing databases.
    // Indexes must be dropped first because DuckDB blocks ALTER on indexed tables.
    const colCheck = await connection.runAndReadAll(`
      SELECT COUNT(*) FROM information_schema.columns
      WHERE table_name = 'articles' AND column_name = 'raw_fingerprint'
    `);
    if (Number(colCheck.getRowsJS()[0][0]) > 0) {
      await connection.run('DROP INDEX IF EXISTS idx_articles_published_at');
      await connection.run('DROP INDEX IF EXISTS idx_articles_feed_url');
      await connection.run('ALTER TABLE articles DROP COLUMN raw_fingerprint');
    }

    await connection.run('CREATE INDEX IF NOT EXISTS idx_articles_published_at ON articles(published_at)');
    await connection.run('CREATE INDEX IF NOT EXISTS idx_articles_feed_url ON articles(feed_url)');

    await connection.run(`
      CREATE TABLE IF NOT EXISTS topics (
        id VARCHAR PRIMARY KEY,
        topic_date DATE NOT NULL,
        status VARCHAR NOT NULL,
        label_keywords VARCHAR[],
        entities VARCHAR[],
        centroid_vector VARCHAR NOT NULL,
        article_count UINTEGER NOT NULL,
        unique_source_count UINTEGER NOT NULL,
        novelty_score DOUBLE NOT NULL,
        burst_score DOUBLE NOT NULL,
        burst_z_score DOUBLE NOT NULL,
        source_diversity DOUBLE NOT NULL,
        persistence_score DOUBLE NOT NULL,
        entity_importance DOUBLE NOT NULL,
        final_score DOUBLE NOT NULL,
        max_historical_similarity DOUBLE NOT NULL,
        active_windows VARCHAR[],
        matched_historical_topic_ids VARCHAR[],
        sample_headlines VARCHAR[],
        top_sources VARCHAR[],
        created_at TIMESTAMP NOT NULL,
        theme_id VARCHAR,
        theme_label VARCHAR[]
      )
    `);

    await connection.run(`
      CREATE TABLE IF NOT EXISTS topic_articles (
        topic_id VARCHAR NOT NULL,
        url_hash UBIGINT NOT NULL,
        PRIMARY KEY (topic_id, url_hash)
      )
    `);

    await connection.run('CREATE INDEX IF NOT EXISTS idx_topics_topic_date ON topics(topic_date)');
    await connection.run('CREATE INDEX IF NOT EXISTS idx_topic_articles_url_hash ON topic_articles(url_hash)');
    await connection.run('ALTER TABLE topics ADD COLUMN IF NOT EXISTS theme_id VARCHAR');
    await connection.run('ALTER TABLE topics ADD COLUMN IF NOT EXISTS theme_label VARCHAR[]');

    // Persistent staging table — lives for the connection lifetime (cleared after each flush)
    await connection.run(`
      CREATE TEMP TABLE IF NOT EXISTS ${STAGE_TABLE} (
        url_hash UBIGINT,
        url VARCHAR,
        feed_url VARCHAR,
        feed_title VARCHAR,
        title VARCHAR,
        summary VARCHAR,
        image_url VARCHAR,
        author VARCHAR,
        published_at TIMESTAMP,
        fetched_at TIMESTAMP,
        source_type UTINYINT,
        tags VARCHAR[]
      )
    `);
  }

  async insertArticles(rows) {
    const totalStartedAt = Date.now();
    if (!rows.length) {
      return { candidates: 0, inserted: 0, timing: { totalMs: Date.now() - totalStartedAt } };
    }

    const connection = await this.open();
    await connection.run('BEGIN TRANSACTION');
    let stageMs = 0;
    let insertMs = 0;
    try {
      const stageStartedAt = Date.now();
      const appender = await connection.createAppender(STAGE_TABLE);
      try {
        for (const row of rows) {
          appendRow(appender, row);
        }
      } finally {
        appender.closeSync();
      }
      stageMs = Date.now() - stageStartedAt;

      const insertStartedAt = Date.now();
      const insertReader = await connection.runAndReadAll(`
        INSERT OR IGNORE INTO articles
        SELECT
          url_hash, url, feed_url, feed_title, title, summary, image_url, author,
          published_at, fetched_at, source_type, tags
        FROM ${STAGE_TABLE}
        RETURNING url_hash
      `);
      const inserted = insertReader.getRowsJS().length;

      // Only enrich existing rows when there are duplicates with potentially missing fields
      if (inserted < rows.length) {
        await connection.run(`
          UPDATE articles
          SET
            title = COALESCE(NULLIF(articles.title, ''), ${STAGE_TABLE}.title),
            summary = COALESCE(NULLIF(articles.summary, ''), ${STAGE_TABLE}.summary),
            image_url = COALESCE(NULLIF(articles.image_url, ''), ${STAGE_TABLE}.image_url)
          FROM ${STAGE_TABLE}
          WHERE articles.url_hash = ${STAGE_TABLE}.url_hash
            AND (
              articles.title IS NULL OR articles.title = ''
              OR articles.summary IS NULL OR articles.summary = ''
              OR articles.image_url IS NULL OR articles.image_url = ''
            )
        `);
      }
      insertMs = Date.now() - insertStartedAt;

      await connection.run(`DELETE FROM ${STAGE_TABLE}`);
      await connection.run('COMMIT');

      return {
        candidates: rows.length,
        inserted,
        timing: { totalMs: Date.now() - totalStartedAt, stageMs, insertMs }
      };
    } catch (error) {
      await connection.run('ROLLBACK');
      await connection.run(`DELETE FROM ${STAGE_TABLE}`).catch(() => {});
      throw error;
    }
  }

  async countArticles() {
    const connection = await this.open();
    const reader = await connection.runAndReadAll('SELECT COUNT(*) AS count FROM articles');
    return Number(reader.getRowsJS()[0][0]);
  }

  async getStats() {
    const connection = await this.open();
    const reader = await connection.runAndReadAll(`
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE fetched_at >= now() - INTERVAL 1 DAY) AS fetched_last_day,
        COUNT(*) FILTER (WHERE published_at >= now() - INTERVAL 7 DAY) AS published_last_7_days,
        COUNT(DISTINCT feed_url) AS feeds
      FROM articles
    `);
    const [total, fetchedLastDay, publishedLast7Days, feeds] = reader.getRowsJS()[0];

    const latestReader = await connection.runAndReadAll(`
      SELECT title, url, feed_url, published_at, source_type
      FROM articles
      ORDER BY fetched_at DESC
      LIMIT 5
    `);

    return {
      total: Number(total),
      fetchedLastDay: Number(fetchedLastDay),
      publishedLast7Days: Number(publishedLast7Days),
      feeds: Number(feeds),
      latest: latestReader.getRowObjectsJS()
    };
  }

  async getArticlesForDate(date, limit = 0) {
    const connection = await this.open();
    const limitClause = limit > 0 ? `LIMIT ${Number(limit)}` : '';
    const reader = await connection.runAndReadAll(`
      SELECT
        url_hash,
        url,
        feed_url,
        feed_title,
        title,
        summary,
        published_at,
        fetched_at,
        source_type,
        tags
      FROM articles
      WHERE COALESCE(CAST(published_at AS DATE), CAST(fetched_at AS DATE)) = DATE '${escapeSql(date)}'
      ORDER BY COALESCE(published_at, fetched_at) DESC, feed_url, title
      ${limitClause}
    `);
    return reader.getRowObjectsJS();
  }

  async getTopicsBetweenDates(startDate, endDate) {
    const connection = await this.open();
    const reader = await connection.runAndReadAll(`
      SELECT
        id,
        CAST(topic_date AS VARCHAR) AS date,
        status,
        label_keywords AS labelKeywords,
        entities,
        centroid_vector AS centroidVector,
        article_count AS articleCount,
        unique_source_count AS uniqueSourceCount,
        novelty_score AS noveltyScore,
        burst_score AS burstScore,
        burst_z_score AS burstZScore,
        source_diversity AS sourceDiversity,
        persistence_score AS persistenceScore,
        entity_importance AS entityImportance,
        final_score AS finalScore,
        max_historical_similarity AS maxHistoricalSimilarity,
        active_windows AS activeWindows,
        matched_historical_topic_ids AS matchedHistoricalTopicIds,
        sample_headlines AS sampleHeadlines,
        top_sources AS topSources,
        theme_id AS themeId,
        theme_label AS themeLabel
      FROM topics
      WHERE topic_date BETWEEN DATE '${escapeSql(startDate)}' AND DATE '${escapeSql(endDate)}'
      ORDER BY topic_date DESC, final_score DESC
    `);
    return reader.getRowObjectsJS();
  }

  async getArticlesForTopic(topicId, limit = 5) {
    const connection = await this.open();
    const reader = await connection.runAndReadAll(`
      SELECT
        a.title,
        a.url,
        a.feed_title,
        a.published_at,
        a.image_url
      FROM topic_articles ta
      JOIN articles a ON a.url_hash = ta.url_hash
      WHERE ta.topic_id = '${escapeSql(topicId)}'
        AND a.title IS NOT NULL
      ORDER BY COALESCE(a.published_at, a.fetched_at) DESC
      LIMIT ${Number(limit)}
    `);
    return reader.getRowObjectsJS();
  }

  async replaceTopicsForDate(date, topics) {
    const connection = await this.open();
    await connection.run('BEGIN TRANSACTION');
    try {
      await connection.run(`
        DELETE FROM topic_articles
        WHERE topic_id IN (
          SELECT id FROM topics WHERE topic_date = DATE '${escapeSql(date)}'
        )
      `);
      await connection.run(`DELETE FROM topics WHERE topic_date = DATE '${escapeSql(date)}'`);

      for (const topic of topics) {
        await connection.run(`
          INSERT INTO topics (
            id,
            topic_date,
            status,
            label_keywords,
            entities,
            centroid_vector,
            article_count,
            unique_source_count,
            novelty_score,
            burst_score,
            burst_z_score,
            source_diversity,
            persistence_score,
            entity_importance,
            final_score,
            max_historical_similarity,
            active_windows,
            matched_historical_topic_ids,
            sample_headlines,
            top_sources,
            created_at,
            theme_id,
            theme_label
          )
          VALUES (
            '${escapeSql(topic.id)}',
            DATE '${escapeSql(date)}',
            '${escapeSql(topic.status)}',
            ${stringArrayLiteral(topic.labelKeywords)},
            ${stringArrayLiteral(topic.entities)},
            '${escapeSql(JSON.stringify(vectorToObject(topic.centroidVector)))}',
            ${Number(topic.articleCount) || 0},
            ${Number(topic.uniqueSourceCount) || 0},
            ${numberLiteral(topic.noveltyScore)},
            ${numberLiteral(topic.burstScore)},
            ${numberLiteral(topic.burstZScore)},
            ${numberLiteral(topic.sourceDiversity)},
            ${numberLiteral(topic.persistenceScore)},
            ${numberLiteral(topic.entityImportance)},
            ${numberLiteral(topic.finalScore)},
            ${numberLiteral(topic.maxHistoricalSimilarity)},
            ${stringArrayLiteral(topic.activeWindows)},
            ${stringArrayLiteral(topic.matchedHistoricalTopicIds)},
            ${stringArrayLiteral(topic.sampleHeadlines)},
            ${stringArrayLiteral(topic.topSources)},
            now(),
            ${topic.themeId ? `'${escapeSql(topic.themeId)}'` : 'NULL'},
            ${stringArrayLiteral(topic.themeLabel)}
          )
        `);

        for (const urlHash of topic.articleHashes || []) {
          await connection.run(`
            INSERT OR IGNORE INTO topic_articles (topic_id, url_hash)
            VALUES ('${escapeSql(topic.id)}', ${String(urlHash)})
          `);
        }
      }

      await connection.run('COMMIT');
    } catch (error) {
      await connection.run('ROLLBACK');
      throw error;
    }
  }

  // Prune topics (and their article links) older than `daysToKeep` days.
  // Keeps the topics table from growing unboundedly; 30 days is enough for trend analysis.
  async pruneOldTopics(daysToKeep = 30) {
    const connection = await this.open();
    await connection.run('BEGIN TRANSACTION');
    try {
      await connection.run(`
        DELETE FROM topic_articles
        WHERE topic_id IN (
          SELECT id FROM topics
          WHERE topic_date < CURRENT_DATE - INTERVAL '${Number(daysToKeep)} days'
        )
      `);
      const result = await connection.runAndReadAll(`
        DELETE FROM topics
        WHERE topic_date < CURRENT_DATE - INTERVAL '${Number(daysToKeep)} days'
        RETURNING id
      `);
      await connection.run('COMMIT');
      return result.getRowsJS().length;
    } catch (error) {
      await connection.run('ROLLBACK');
      throw error;
    }
  }

  async checkpoint() {
    const connection = await this.open();
    await connection.run('CHECKPOINT');
  }
}

function appendRow(appender, row) {
  appender.appendUBigInt(row.url_hash);
  appendString(appender, row.url);
  appendString(appender, row.feed_url);
  appendString(appender, row.feed_title);
  appendString(appender, row.title);
  appendString(appender, row.summary);
  appendString(appender, row.image_url);
  appendString(appender, row.author);
  appendTimestamp(appender, row.published_at);
  appendTimestamp(appender, row.fetched_at);
  appender.appendUTinyInt(row.source_type);
  appender.appendList(row.tags || [], LIST(VARCHAR));
  appender.endRow();
}

function appendString(appender, value) {
  if (value === null || value === undefined) {
    appender.appendNull();
  } else {
    appender.appendVarchar(String(value));
  }
}

function appendTimestamp(appender, value) {
  if (!value) {
    appender.appendNull();
    return;
  }

  const date = value instanceof Date ? value : new Date(value);
  appender.appendTimestamp(timestampValue(BigInt(date.getTime()) * 1000n));
}

function stringArrayLiteral(values = []) {
  const items = values
    .filter(value => value !== null && value !== undefined)
    .map(value => `'${escapeSql(value)}'`);
  return `[${items.join(', ')}]`;
}

function numberLiteral(value) {
  const number = Number(value);
  return Number.isFinite(number) ? String(number) : '0';
}

function escapeSql(value) {
  return String(value ?? '').replace(/'/g, '\'\'');
}

export { DuckDBService };
export const duckDBService = new DuckDBService();
