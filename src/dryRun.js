import dotenv from 'dotenv';
import { loadFeedConfigs, DEFAULT_FEED_CONCURRENCY } from './config.js';
import { processFeed } from './services/feedProcessor.js';

dotenv.config();

async function main() {
  const feeds = (await loadFeedConfigs()).filter(feed => feed.enabled);
  const results = await mapConcurrent(feeds, DEFAULT_FEED_CONCURRENCY, async feed => {
    try {
      const result = await processFeed(feed);
      return { success: true, feed, ...result };
    } catch (error) {
      return { success: false, feed, error };
    }
  });

  const candidates = results.reduce((sum, result) => sum + (result.candidateCount || 0), 0);
  const failures = results.filter(result => !result.success);

  console.log(`Dry run complete. feeds=${feeds.length} candidates=${candidates} failed=${failures.length}`);

  for (const result of results.filter(result => result.success).slice(0, 10)) {
    console.log(`${result.feed.url}: items=${result.itemCount} candidates=${result.candidateCount}`);
  }

  for (const failure of failures.slice(0, 10)) {
    console.warn(`Failed: ${failure.feed.url} - ${failure.error.message}`);
  }
}

async function mapConcurrent(items, concurrency, mapper) {
  const results = new Array(items.length);
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const currentIndex = index++;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

main().catch(error => {
  console.error(`Dry run failed: ${error.message}`);
  process.exit(1);
});
