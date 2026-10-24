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
node scripts/checkNewsImages.js [--date D] [--dry-run]  # Drop pictures the site cannot load from existing exports
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
- `topicDetectionService.js` — TF-IDF (unigrams + bigrams) over all news headlines of a day (source_type 1). Unicode tokenizer with multilingual stopwords; syndicated identical headlines collapsed; centroid-guarded leader clustering (no single-link chaining) + centroid merge pass. Ranking: 0.45 source coverage (log) + 0.25 burst + 0.20 novelty + 0.10 persistence. `sampleHeadlines` are in centrality order; `[0]` is the representative headline. Follow-ups: day-2/3 coverage of a big story takes new angles that don't cluster, so each top-20 topic of the previous 2 days gives one anchor (a top-3 label keyword in ≥60% of its headlines, ≤0.5% of today's headlines, ≥5× more frequent than 7 days before); clusters mostly made of headlines with the anchor plus another specific word of that story's centroid merge into one follow-up cluster (feeds with >3 anchor headlines that day, i.e. CVE firehoses, are ignored). YouTube videos (source_type 2) are matched to finished topics afterwards (cosine to the centroid in the news TF-IDF space, ≥0.30 and ≥2 shared words, ≤3 per topic, one per channel) and linked via `topic_articles`; they never affect clustering, counts or ranking.
- `sectionService.js` — sections `world, politics, business, technology, science-health, sports, culture`; fallback heuristic = vote of the topic's specialist feeds (feed `category` in `rss_feeds.json`, ≥30% of distinct sources), else `world`.
- `newsExportService.js` — candidates: ≤40 topics (one per theme, above 0.4× top score); each gets a `section` (model via `classifyTopics`, heuristic fallback). Picks ≤15 balanced by section: the best Technology/Business/Science & Health/Sports/Culture story if it scores ≥0.5× top, then by score with ≤5 per section. ≤5 articles per topic (one per outlet, central first, descriptions trimmed), writes `news/<date>.json`. Linked videos go to a separate `videos` list (`title`, `url`, `video_id`, `channel`, `published_at`, `thumbnail` from i.ytimg.com); the site shows them as thumbnails that link out to YouTube (no embed). Each topic has `section` (the old `category` field is the status: new/trending/ongoing); the site shows it in the kicker and as filter chips, and a filtered view lays stories out as full-width rows.
- `imageCheckService.js` — run by the export: each article picture is requested once as the page would (anonymous CORS from `SITE_ORIGIN`, https) and dropped unless it is an image that allows the origin, so the site never logs failed image loads.
- `newsPublisher.js` — `publishNews()`: idempotent commit + push of `news/` on `master`; used by the daemon (hourly) and `exportDailyTopics.js`.
- `newsSummaryService.js` — one small section call over the ≤40 candidates (`classifyTopics`) plus one batched OpenAI Responses call per exported day (`SUMMARY_MODEL`, default `gpt-6-luna`, low reasoning, 2000 output-token cap, no retries, hard €0.02/day budget; typical ~$0.001/day) for English `title`/`summary` and cross-language duplicate merging. Falls back to extractive headlines on any failure.

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


### MCP server (`mcp/`, Cloudflare Worker)
GitHub Pages rejects POST (405), so it cannot host an MCP server itself. `mcp/` is a stateless Streamable HTTP MCP endpoint (protocol 2026-07-28 + session-less legacy `initialize`) on Cloudflare Workers Free that reads the published `news/*.json` from Pages: `https://daily-news-mcp.bemoredifferent.workers.dev/mcp`. Tools (barebone by design, no listing or search): `get_daily_news` (date defaults to today UTC, falling back to yesterday until it is published) and `get_topic`; each call reads one `news/<date>.json` directly. `protocol.js`/`tools.js` are pure (tests: `test/mcpServer.test.js`); `worker.js` adds edge caching + per-isolate memo to stay within the free 10 ms CPU limit. `analytics.js` sends GA4 Measurement Protocol events (no PII: client_id = client *product*, country only, no free-text arguments) via `waitUntil`; active only when Worker secrets `GA_MEASUREMENT_ID` + `GA_API_SECRET` exist (`npm run ga:setup` / `ga:push` in `mcp/`, see `mcp/README.md`).
```bash
cd mcp && npm run deploy     # reads CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN from root .env (gitignored)
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
- DuckDB file locked per process — only one `node src/app.js` at a time
