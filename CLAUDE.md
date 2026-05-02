# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

### Running the Application
```bash
npm start                    # Long-running daemon (reruns every 60 min)
node src/app.js             # Direct execution
```

### Utilities
```bash
npm run info                 # Print feed cache stats and DB article count
npm run dry-run              # Fetch and parse feeds without writing to DB
npm run topics               # Run topic detection for today
npm run news:export          # Export yesterday's topics to news/YYYY-MM-DD.json
npm run news:backfill        # Export all historical dates missing a JSON file
node scripts/exportDailyTopics.js --date 2026-05-01  # Export a specific date
node scripts/exportDailyTopics.js --backfill --force # Overwrite all existing files
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

Node.js RSS feed fetcher that crawls 2400+ feeds, deduplicates via DuckDB primary key, and clusters articles into topics using TF-IDF. Runs as a long-lived daemon managed by launchd; `isRunning` guard prevents overlapping hourly runs.

### Core Components

**Entry Point**: `src/app.js`
- Opens DuckDB once at startup; keeps it open for the process lifetime.
- `setInterval` triggers `runOnce()` every 60 min; launchd `KeepAlive: true` restarts on crash.
- `isRunning` guard prevents overlapping runs. Graceful shutdown on SIGINT/SIGTERM/SIGQUIT.

**Services**:
- `feedProcessor.js` — RSS fetch + parse. `fetchXml` retries once on transient network errors (ECONNRESET, EPIPE). Redirect race fixed (marks settled before recursing). Single-pass `cleanText`. Short-circuit `extractImageUrl`.
- `duckdbService.js` — DuckDB storage. Persistent TEMP staging table (created once per connection). `INSERT OR IGNORE … RETURNING url_hash` gives insert count without full table scans. Topics stored per-date and replaced on each run.
- `feedCacheService.js` — TTL-based cache (`data/feed_cache.json`). Dirty flag prevents disk write when nothing changed. `shouldProcess()` skips feeds fetched within their `intervalMinutes` window.
- `topicDetectionService.js` — Two-tier TF-IDF clustering (unigrams + bigrams). Historical centroid vectors parsed once per run. Entity extraction deferred to cluster creation.

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
DB_PATH=data/rss.duckdb      # DuckDB file path
```

**Data Files**:
- `data/rss_feeds.json` — feed config objects (`url`, `enabled`, `intervalMinutes`, `maxItems`, `sourceType`)
- `data/feed_cache.json` — TTL state per feed URL (auto-managed)
- `data/rss.duckdb` — DuckDB database (articles + topics)

### launchd Setup (macOS daemon, auto-restart on crash)

Install once:
```bash
cp scripts/com.daniel.rss-fetcher.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.daniel.rss-fetcher.plist
```

Manage:
```bash
launchctl print gui/$UID/com.daniel.rss-fetcher   # status
launchctl kickstart -k gui/$UID/com.daniel.rss-fetcher  # restart now
launchctl bootout gui/$UID ~/Library/LaunchAgents/com.daniel.rss-fetcher.plist  # stop & unload
```

`KeepAlive: true` + `ThrottleInterval: 30` means launchd respawns within 30 s of any exit. Stdout/stderr go to `logs/rss_fetch.log`.


### Network Tuning (macOS)
Run once with sudo to persist TCP settings across reboots (prevents port exhaustion with 2400+ feeds):
```bash
sudo bash scripts/setup-network.sh
```
Sets `net.inet.tcp.msl=2500` (TIME_WAIT 5s) and `net.inet.ip.portrange.first=10000` (~55k ephemeral ports).

## Development Notes

- ES modules (`"type": "module"` in package.json)
- ESLint: 2-space indent, single quotes
- DuckDB file locked per process — only one `node src/app.js` at a time
