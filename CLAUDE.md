# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

### Running the Application
```bash
npm start                    # Start with nodemon for development
node src/app.js             # Direct execution
```

### Code Quality
```bash
npx eslint src/             # Run ESLint linter
npx eslint src/ --fix       # Auto-fix linting issues
```

### Testing
Currently no test framework is configured. The project structure suggests Jest support in ESLint config but no tests exist yet.

## Architecture Overview

This is a Node.js RSS feed fetcher and content processor that runs continuously, processing feeds every 10 minutes.

### Core Components

**Entry Point**: `src/app.js`
- Main orchestrator that runs the crawler service
- Manages graceful shutdown and error recovery
- Initializes Bloom Filter and Feed Cache on startup

**Services Architecture**:
- `feedProcessor.js` - Core RSS feed processing logic
- `databaseService.js` - PostgreSQL database operations
- `youtubeService.js` - YouTube-specific content processing with transcript extraction
- `feedCacheService.js` - TTL-based feed caching to prevent over-processing
- `crawlerRunService.js` - Scheduler that runs feed processing every 10 minutes

**Utilities**:
- `bloomFilter.js` - Duplicate article detection using probabilistic data structure
- `parallelProcessor.js` - Controls concurrent feed processing with limits
- `htmlCleaner.js` / `markdownCleaner.js` - Content cleaning and conversion
- `requestQueue.js` - HTTP request management
- `keywordExtractor.js` - Content analysis and tagging

### Data Flow
1. **Feed Discovery**: Reads RSS feeds from `data/rss_feeds.json`
2. **Cache Check**: Uses TTL-based caching to avoid re-processing recent feeds
3. **Parallel Processing**: Processes multiple feeds concurrently with controlled limits
4. **Content Extraction**: Fetches articles using @extractus/article-extractor with robots.txt compliance
5. **Duplicate Detection**: Uses Bloom Filter to skip already-processed articles
6. **Content Processing**: Converts HTML to Markdown, extracts keywords, detects language
7. **Database Storage**: Stores processed articles in PostgreSQL with full metadata

### Configuration Files

**Required Environment Variables** (`.env`):
```
DB_USER, DB_HOST, DB_DATABASE, DB_PASSWORD, DB_PORT
LOG_LEVEL, NODE_ENV
```

**Data Files**:
- `data/rss_feeds.json` - Array of RSS feed URLs to process
- `data/feed_cache.json` - TTL cache state (auto-managed)
- `data/bloom_filter.json` - Duplicate detection state (auto-managed)

## Database Schema

The application expects a PostgreSQL table named `content` with specific columns including:
- Standard article fields (title, url, content_body, author, etc.)
- Metadata fields (language, tags, keywords, image_url)
- Timestamps and status tracking
- JSONB metadata field for flexible data
- Vector embedding support (column exists but not used)

## Special Features

**YouTube Integration**:
- Detects YouTube RSS feeds
- Extracts video transcripts using youtube-transcript library
- Handles YouTube-specific metadata and thumbnails

**Language Detection**:
- Uses `franc` library for automatic language detection
- Stores ISO 639-1 language codes
- Supports content in multiple languages

**Content Processing**:
- Converts HTML to clean Markdown using `turndown`
- Extracts keywords using `keyword-extractor` and `natural` libraries
- Filters for recent content (last 3 days)

## Development Notes

- Uses ES modules (`"type": "module"` in package.json)
- ESLint configured with basic rules, 2-space indentation, single quotes
- Nodemon configured with 2.5s delay, watches src/ directory
- Error handling designed for continuous operation (doesn't exit on errors)
- No existing test suite - tests would need to be implemented from scratch