# RSS Feed Fetcher

A robust Node.js application for processing RSS feeds, extracting article content, and storing it in a PostgreSQL database. The application is designed to handle various RSS feed formats, clean and process content, and maintain a structured database of articles.

## Features

- **Feed Processing**
  - Fetches and processes RSS feeds from various sources
  - Handles multiple RSS feed formats (RSS 2.0, Atom, etc.)
  - Processes feeds in parallel with controlled concurrency
  - Configurable feed list via JSON file
  - TTL-based feed caching to reduce server load

- **Content Extraction**
  - Extracts article content using @extractus/article-extractor
  - Respects robots.txt compliance for all requests
  - Converts HTML content to clean Markdown format
  - Preserves article metadata (author, date, etc.)
  - Special handling for YouTube content with transcript extraction
  - Automatic language detection using franc library

- **Data Management**
  - Stores articles in PostgreSQL database
  - Prevents duplicate articles using Bloom Filter
  - Filters for recent articles (last 3 days)
  - Maintains article relationships and metadata
  - Language detection and tagging (ISO 639-1 codes)
  - Keyword extraction and tagging
  - Efficient caching with TTL

- **Error Handling**
  - Comprehensive error handling for feed processing
  - Graceful handling of invalid URLs
  - Detailed logging of processing status
  - Error recovery mechanisms
  - YouTube-specific error handling
  - Automatic retries for transient failures

## Project Structure

```
rss_feed_fetcher/
├── src/
│   ├── services/
│   │   ├── feedProcessor.js    # RSS feed processing service
│   │   ├── databaseService.js  # Database operations
│   │   ├── youtubeService.js   # YouTube-specific processing
│   │   └── feedCacheService.js # Feed caching with TTL
│   ├── utils/
│   │   ├── htmlCleaner.js      # HTML cleaning utility
│   │   ├── markdownCleaner.js  # Markdown cleaning utility
│   │   ├── requestQueue.js     # Request queue management
│   │   ├── bloomFilter.js      # Duplicate detection
│   │   └── parallelProcessor.js # Parallel processing control
│   └── app.js                  # Main application entry point
├── data/
│   ├── rss_feeds.json          # RSS feed configuration
│   └── feed_cache.json         # Feed processing cache
├── package.json                # Project dependencies and scripts
├── .env                        # Environment configuration
└── README.md                   # Project documentation
```

## Prerequisites

- Node.js (v14 or higher)
- PostgreSQL database
- npm or yarn package manager

## Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd rss_feed_fetcher
```

2. Install dependencies:
```bash
npm install
```

3. Create a `.env` file in the root directory with the following configuration:
```env
# Database Configuration
DB_USER=your_db_user
DB_HOST=your_db_host
DB_DATABASE=your_db_name
DB_PASSWORD=your_db_password
DB_PORT=5432

# Logging Configuration
LOG_LEVEL=debug

# Application Configuration
NODE_ENV=development
```

4. Set up the database:
```sql
CREATE TABLE content (
    id SERIAL PRIMARY KEY,
    type VARCHAR(50) NOT NULL DEFAULT 'default',
    title VARCHAR(255),
    description TEXT,
    keywords VARCHAR[],
    date_created TIMESTAMP DEFAULT NOW(),
    upvotes INTEGER DEFAULT 0,
    downvotes INTEGER DEFAULT 0,
    metadata JSONB,
    content_body TEXT,
    location_data GEOGRAPHY(POINT, 4326),
    country VARCHAR(100),
    price NUMERIC(10, 2),
    inventory_count INTEGER,
    author VARCHAR(255),
    url VARCHAR(2083),
    status VARCHAR(50) DEFAULT 'active',
    language VARCHAR(10),
    tags VARCHAR[],
    date_modified TIMESTAMP DEFAULT NOW(),
    modified_by VARCHAR(255),
    embedding VECTOR,
    count INTEGER DEFAULT 1,
    external_id VARCHAR(250),
    image_url VARCHAR(500),
    search_vector TSVECTOR,
    time BIGINT
);
```

## Usage

1. Configure your RSS feeds in `data/rss_feeds.json`:
```json
[
    "https://www.bbc.com/news/rss.xml",
    "https://www.cnn.com/rss/edition.rss",
    "https://www.youtube.com/feeds/videos.xml?channel_id=YOUR_CHANNEL_ID"
]
```

2. Run the application:
```bash
npm start
```

The application will:
- Read the configured RSS feeds
- Process feeds in parallel with controlled concurrency
- Extract and clean article content
- Handle YouTube content specially (transcripts, thumbnails)
- Detect language and extract keywords
- Store recent articles in the database
- Skip duplicate articles
- Cache feed processing results
- Log processing status and errors

## Output Format

Articles are stored in the database with the following structure:
```javascript
{
    title: string,          // Article title
    url: string,           // Original article URL
    published: Date,       // Publication date
    description: string,   // Article description/summary
    content_body: string,  // Full article content in Markdown
    author: string,        // Article author
    siteName: string,      // Source website name
    feedUrl: string,       // RSS feed URL
    feedTitle: string,     // RSS feed title
    type: 'article'|'youtube', // Content type
    status: 'active',      // Article status
    extracted_at: Date,    // When the article was processed
    image_url: string,     // Featured image URL
    language: string,      // ISO 639-1 language code
    tags: string[]         // Extracted keywords
}
```

## Error Handling

The application implements comprehensive error handling:
- Invalid URLs are logged and skipped
- Failed article extractions are logged with details
- Database connection errors are handled gracefully
- Processing continues even if individual articles fail
- YouTube-specific error handling (no captions, private videos, etc.)
- Detailed error logging for debugging

## Dependencies

- @extractus/article-extractor: Article content extraction
- cheerio: HTML parsing and manipulation
- dotenv: Environment variable management
- franc: Language detection
- node-fetch: HTTP requests
- pg: PostgreSQL client
- rss-parser: RSS feed parsing
- turndown: HTML to Markdown conversion
- youtube-transcript: YouTube transcript extraction

## Development

### Running Tests
```bash
npm test
```

### Code Style
The project uses ESLint for code style enforcement. Run the linter:
```bash
npm run lint
```

### Adding New Features
1. Create a new branch for your feature
2. Implement the changes
3. Add tests if applicable
4. Update documentation
5. Submit a pull request

## Contributing

1. Fork the repository
2. Create your feature branch
3. Commit your changes
4. Push to the branch
5. Create a new Pull Request

## License

ISC

## Support

For support, please open an issue in the GitHub repository or contact the maintainers.

## Language Detection

The application uses the `franc` library for automatic language detection:
- Detects language from both title and content
- Uses ISO 639-1 two-letter language codes (e.g., 'en', 'es', 'fr')
- Falls back to English ('en') if language cannot be determined
- Requires minimum text length for accurate detection
- Supports multiple languages including:
  - English (en)
  - Spanish (es)
  - French (fr)
  - German (de)
  - Italian (it)
  - And many more... 