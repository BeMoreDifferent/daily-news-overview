# Daily News Overview

A Node.js daemon that crawls 2,400+ RSS feeds, deduplicates articles, clusters them into topics using TF-IDF, and stores everything in a local DuckDB database. Runs continuously via launchd on macOS, triggering a full fetch cycle every 60 minutes.

## How it works

1. **Feed fetch** — reads `data/rss_feeds.json` (2,400+ sources), skips feeds within their TTL window, then fetches the rest in parallel (concurrency = 10)
2. **Dedup** — every article gets a 64-bit SHA-256 hash of its URL; `INSERT OR IGNORE` on the primary key discards duplicates without table scans
3. **Topic detection** — TF-IDF clustering (unigrams + bigrams) over today's headlines produces ranked topic clusters with novelty, burst, and persistence scores
4. **Archive** — articles older than 30 days are offloaded to date-partitioned ZSTD Parquet files; URL-hash stubs remain in the hot DB so dedup keeps working

## Project structure

```
src/
├── app.js                      # Daemon entry point — setInterval + isRunning guard
├── services/
│   ├── feedProcessor.js        # RSS fetch, parse, retry on ECONNRESET/EPIPE
│   ├── duckdbService.js        # DuckDB storage, schema init, topic upserts
│   ├── feedCacheService.js     # TTL cache (data/feed_cache.json), dirty-flag writes
│   └── topicDetectionService.js # Two-tier TF-IDF clustering, centroid vectors
├── utils/
│   ├── hash.js                 # hash64(str) — BigInt SHA-256
│   └── urlNormalizer.js        # Strip tracking params, YouTube/BBC special cases
├── info.js                     # CLI: DB + cache stats
├── dryRun.js                   # CLI: fetch feeds without writing to DB
└── topics.js                   # CLI: run topic detection for today

scripts/
├── archiveArticles.js          # Offload old articles to Parquet, keep url_hash stubs
├── expandFeeds.js              # Expand/migrate rss_feeds.json entries
└── setup-network.sh            # macOS TCP tuning for 2400+ concurrent connections

data/
├── rss_feeds.json              # Feed config objects (url, intervalMinutes, maxItems, …)
├── feed_cache.json             # Per-feed TTL state (auto-managed)
├── rss.duckdb                  # Hot database — articles + topics
└── archive/                    # ZSTD Parquet exports by month
```

## Quick start

```bash
# Install dependencies
npm install

# Optional: tune macOS TCP settings (prevents port exhaustion)
sudo bash scripts/setup-network.sh

# Run once (no daemon)
node src/app.js

# Run as daemon (triggers every 60 min)
npm start
```

## Useful commands

```bash
npm run info           # Feed cache stats + DB article count
npm run dry-run        # Fetch and parse feeds without writing to DB
npm run topics         # Run topic detection for today
npx eslint src/        # Lint
npm test               # Unit tests (node:test)
npm run test:smoke:live  # Live integration test against real feeds
```

## Configuration

**Environment variables** (`.env`, all optional):

| Variable | Default | Description |
|---|---|---|
| `DB_PATH` | `data/rss.duckdb` | DuckDB file path |
| `FEED_CONCURRENCY` | `10` | Parallel feed fetches |
| `FEED_TIMEOUT_MS` | `5000` | Per-feed HTTP timeout |

## launchd daemon (macOS)

Install once to auto-start on login and restart on crash:

```bash
cp scripts/com.daniel.rss-fetcher.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.daniel.rss-fetcher.plist
```

Manage:

```bash
launchctl print gui/$UID/com.daniel.rss-fetcher      # status
launchctl kickstart -k gui/$UID/com.daniel.rss-fetcher  # restart now
launchctl bootout gui/$UID ~/Library/LaunchAgents/com.daniel.rss-fetcher.plist  # stop
```

Logs go to `logs/rss_fetch.log`. `KeepAlive: true` + `ThrottleInterval: 30` means launchd respawns within 30 s of any crash.

## Querying the database

DuckDB is locked while the daemon runs. To query, either stop the daemon or copy the file:

```bash
cp data/rss.duckdb /tmp/rss_copy.duckdb
duckdb /tmp/rss_copy.duckdb
```

Useful queries:

```sql
-- Top topics today
SELECT label_keywords, article_count, final_score
FROM topics
WHERE topic_date = current_date
ORDER BY final_score DESC
LIMIT 20;

-- Articles for a topic
SELECT a.title, a.url
FROM topic_articles ta
JOIN articles a ON a.url_hash = ta.url_hash
WHERE ta.topic_id = 'topic_xxx';

-- Article counts by day
SELECT DATE_TRUNC('day', published_at) AS day, COUNT(*) AS n
FROM articles
GROUP BY 1
ORDER BY 1 DESC;

-- Query archived articles
SELECT * FROM read_parquet('data/archive/*.parquet')
WHERE published_at > '2026-01-01';
```

## License

ISC
