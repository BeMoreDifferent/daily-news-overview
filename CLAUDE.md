# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

### Running the Application
```bash
npm run once                 # Single crawl run, then exit
npm start                    # Continuous mode with nodemon (reruns every 60 min)
node src/app.js             # Direct execution
```

### Utilities
```bash
npm run info                 # Print feed cache stats and DB article count
npm run dry-run              # Fetch and parse feeds without writing to DB
npm run topics               # Run topic detection for today
```

### Code Quality
```bash
npx eslint src/             # Run ESLint linter
npx eslint src/ --fix       # Auto-fix linting issues
```

### Testing
```bash
npm test                     # Run all unit tests (node:test)
npm run test:smoke:live      # Live integration test against real feeds
```

### Feed Management
```bash
npm run feeds:expand         # Expand/migrate rss_feeds.json entries
npm run feeds:expand:dry     # Dry-run expand (no writes)
```

## Architecture Overview

Node.js RSS feed fetcher that crawls 2400+ feeds, deduplicates via DuckDB primary key, and clusters articles into topics using TF-IDF. Runs as a one-shot process (`RUN_ONCE=1`) invoked hourly by cron.

### Core Components

**Entry Point**: `src/app.js`
- Orchestrates a single crawl run: load cache → fetch feeds → insert articles → detect topics → print summary
- Hardened shutdown: 10s watchdog + `destroyAgents()` ensures clean exit even mid-fetch
- `isRunning` guard prevents overlapping runs within the same process

**Services**:
- `feedProcessor.js` — RSS fetch + parse. Custom `fetchXml` with `req.destroy()` on timeout to prevent socket leaks. Module-scoped HTTP/HTTPS agents (`maxSockets: 10`). Export `destroyAgents()` for shutdown.
- `duckdbService.js` — DuckDB storage. Articles deduplicated by `url_hash UBIGINT PRIMARY KEY` (`INSERT OR IGNORE`). Topics stored per-date and replaced on each run.
- `feedCacheService.js` — TTL-based cache (`data/feed_cache.json`). `shouldProcess()` skips feeds fetched within their `intervalMinutes` window.
- `topicDetectionService.js` — Two-tier TF-IDF clustering: cluster headlines by cosine similarity, then score and classify clusters into named topics.

**Utilities**:
- `utils/hash.js` — `hash64(str)`: BigInt SHA-256 for url_hash and topic IDs
- `utils/urlNormalizer.js` — `normalizeUrl(url)`: strips tracking params, normalises casing; YouTube and BBC special-cased

**Other entry points**:
- `src/info.js` — DB + cache stats
- `src/dryRun.js` — parse feeds without DB writes
- `src/topics.js` — topic detection CLI

### Data Flow
1. **Feed Discovery**: `loadFeedConfigs()` reads `data/rss_feeds.json` (2400+ feed objects)
2. **Cache Filter**: `feedCache.shouldProcess()` skips feeds fetched within their TTL
3. **Concurrent Fetch**: `mapConcurrent` worker pool (concurrency=10) calls `processFeed()` per feed
4. **Parse & Map**: `rss-parser` + `mapFeedItemToArticleRow()` produces article rows with `url_hash`
5. **Dedup & Insert**: DuckDB `INSERT OR IGNORE` on `url_hash` primary key
6. **Topic Detection**: TF-IDF clustering on today's article headlines → stored in `topics` table
7. **Run Summary**: printed to stdout with counts, timing, and top 10 topics

### Configuration

**Environment Variables** (`.env`):
```
# No required vars — DuckDB path and defaults are hardcoded with env overrides
FEED_CONCURRENCY=10          # parallel feed fetches (default: 10)
FEED_TIMEOUT_MS=5000         # per-feed HTTP timeout (default: 5000)
MAX_FEEDS_PER_RUN=0          # 0 = all feeds
DB_PATH=data/rss.duckdb      # DuckDB file path
```

**Data Files**:
- `data/rss_feeds.json` — feed config objects (`url`, `enabled`, `intervalMinutes`, `maxItems`, `sourceType`)
- `data/feed_cache.json` — TTL state per feed URL (auto-managed)
- `data/rss.duckdb` — DuckDB database (articles + topics)

### Cron Setup
`scripts/cron-run.sh` wraps `npm run once` with a PID file guard to prevent concurrent invocations. Installed via `crontab -e`:
```
0 * * * * /Users/daniel/Documents/rss_feed_fetcher/scripts/cron-run.sh >> /Users/daniel/Documents/rss_feed_fetcher/logs/rss_fetch.log 2>&1
```

### Network Tuning (macOS)
Run once with sudo to persist TCP settings across reboots (prevents port exhaustion with 2400+ feeds):
```bash
sudo bash scripts/setup-network.sh
```
Sets `net.inet.tcp.msl=2500` (TIME_WAIT 5s) and `net.inet.ip.portrange.first=10000` (~55k ephemeral ports).

## Development Notes

- ES modules (`"type": "module"` in package.json)
- ESLint: 2-space indent, single quotes
- Nodemon: 2.5s delay, watches `src/`
- DuckDB file locked per process — only one `node src/app.js` at a time
