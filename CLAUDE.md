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
node scripts/exportDailyTopics.js --recluster [--date D|--from D] [--no-summary]
                             # Re-run topic detection + export (daemon must be stopped: needs DB write lock)
                             # All export commands commit + push changes under news/ (--no-push to skip)
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
- Fatal DuckDB errors (OOM, aborted transaction) exit the process so launchd starts a fresh instance.
- Topic detection runs once per day, not hourly: while `news/<yesterday>.json` is missing, each run re-clusters yesterday and exports it (one OpenAI call). Retries next run on failure.
- Every run then calls `publishNews()` (`services/newsPublisher.js`): commits any change under `news/` (only those paths) and pushes while a news commit is missing upstream, so a failed push is retried hourly. Only acts on `master`, the branch the site is served from.
- Logs: `logs/rss_fetch.log` rotated at 5 MB (checked every run); only slow feeds (≥5 s) are logged individually.

**Services**:
- `feedProcessor.js` — RSS fetch + parse. `fetchXml` retries once on transient network errors (ECONNRESET, EPIPE). Redirect race fixed (marks settled before recursing). Single-pass `cleanText`. Short-circuit `extractImageUrl`.
- `duckdbService.js` — DuckDB storage, capped by `memory_limit` (default 1GB) with spill to `data/rss.duckdb.tmp`. Persistent TEMP staging table (created once per connection). `INSERT OR IGNORE … RETURNING url_hash` gives insert count without full table scans. Only the articles PK index exists (secondary ART indexes cost memory, no query used them). Topics stored per-date (top 200) and replaced on re-run; `compactTopicTables()` rewrites topic tables without tombstones.
- `feedCacheService.js` — TTL-based cache (`data/feed_cache.json`). Dirty flag prevents disk write when nothing changed. `shouldProcess()` skips feeds fetched within their `intervalMinutes` window.
- `topicDetectionService.js` — TF-IDF (unigrams + bigrams) over all news headlines of a day (source_type 1). Unicode tokenizer with multilingual stopwords; syndicated identical headlines collapsed; centroid-guarded leader clustering (no single-link chaining) + centroid merge pass. Ranking: 0.45 source coverage (log) + 0.25 burst + 0.20 novelty + 0.10 persistence. `sampleHeadlines` are in centrality order; `[0]` is the representative headline.
- `newsExportService.js` — picks ≤15 topics (one per theme), ≤5 articles per topic (one per outlet, central first, descriptions trimmed), writes `news/<date>.json`.
- `newsPublisher.js` — `publishNews()`: idempotent commit + push of `news/` on `master`; used by the daemon (hourly) and `exportDailyTopics.js`.
- `newsSummaryService.js` — one batched OpenAI Responses call per exported day (`SUMMARY_MODEL`, default `gpt-6-luna`, low reasoning, 2000 output-token cap, no retries, hard €0.02/day budget; typical ~$0.001/day) for English `title`/`summary` and cross-language duplicate merging. Falls back to extractive headlines on any failure.

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
6. **Daily Topics + Export** (once per day): cluster yesterday's headlines → `topics` table → `news/<date>.json` with GPT titles/summaries → git commit + push
7. **Run Summary**: logged with counts and timing

### Configuration

**Environment Variables** (`.env`):
```
# No required vars — DuckDB path and defaults are hardcoded with env overrides
FEED_CONCURRENCY=10          # parallel feed fetches (default: 10)
FEED_TIMEOUT_MS=5000         # per-feed HTTP timeout (default: 5000)
DUCKDB_PATH=data/rss.duckdb  # DuckDB file path
DUCKDB_MEMORY_LIMIT=1GB      # DuckDB buffer cap (default 1GB)
OPENAI_API_KEY=...           # enables daily GPT titles/summaries (never commit .env)
SUMMARY_MODEL=gpt-6-luna     # optional override
SUMMARY_ENABLED=0            # optional: disable summaries
SUMMARY_DAILY_BUDGET_EUR=0.02 # hard cap: request skipped if worst-case cost exceeds today's remainder (ledger: data/summary_usage.json)
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

`KeepAlive: true` + `ThrottleInterval: 300` means launchd respawns within 5 min of any exit. Runs as `ProcessType=Background`, `Nice=10`, `LowPriorityIO`. The app writes `logs/rss_fetch.log`; launchd stdout/stderr (startup failures) go to `~/Library/Logs/rss-fetcher.launchd.log`.

Because the repo lives in `~/Documents` (TCC-protected), `/opt/homebrew/bin/node` needs **Full Disk Access** (System Settings → Privacy & Security). Without it the agent crash-loops with `EPERM: operation not permitted` in the launchd log; re-check after macOS upgrades or Homebrew node upgrades.


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
