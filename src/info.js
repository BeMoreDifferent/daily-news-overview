import dotenv from 'dotenv';
import { loadFeedConfigs, DEFAULT_DB_PATH } from './config.js';
import { feedCache } from './services/feedCacheService.js';
import { duckDBService } from './services/duckdbService.js';

dotenv.config();

async function main() {
  await feedCache.load();
  await duckDBService.open();

  const feeds = await loadFeedConfigs();
  const stats = await duckDBService.getStats();
  const cacheStatus = feedCache.getStatus();
  const enabledCount = feeds.filter(feed => feed.enabled).length;

  console.log('RSS Feed Fetcher');
  console.log('================');
  console.log(`DuckDB: ${DEFAULT_DB_PATH}`);
  console.log(`Articles: ${stats.total}`);
  console.log(`Fetched last day: ${stats.fetchedLastDay}`);
  console.log(`Published last 7 days: ${stats.publishedLast7Days}`);
  console.log(`Stored feeds: ${stats.feeds}`);
  console.log(`Configured feeds: ${feeds.length}`);
  console.log(`Enabled feeds fetched each run: ${enabledCount}`);
  console.log(`Cached feeds: ${Object.keys(cacheStatus).length}`);

  if (stats.latest.length) {
    console.log('\nLatest articles');
    for (const article of stats.latest) {
      console.log(`- [${article.source_type}] ${article.title || '(untitled)'}`);
      console.log(`  ${article.url}`);
    }
  }

  await duckDBService.close();
}

main().catch(async error => {
  console.error(`Info failed: ${error.message}`);
  await duckDBService.close().catch(() => {});
  process.exit(1);
});
