import dotenv from 'dotenv';
import { duckDBService } from './services/duckdbService.js';
import { detectTopicsForDate } from './services/topicDetectionService.js';

dotenv.config();

const DEFAULT_LIMIT = 20;

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const date = options.date || new Date().toISOString().slice(0, 10);
  validateDate(date);

  await duckDBService.open();
  const topics = await detectTopicsForDate(duckDBService, date, {
    historyDays: positiveInteger(options.historyDays, 14),
    minTopicSize: positiveInteger(options.minTopicSize, 3),
    minSources: positiveInteger(options.minSources, 2)
  });
  const limit = positiveInteger(options.limit, DEFAULT_LIMIT);
  printTopics(date, topics.slice(0, limit), topics.length);
  await duckDBService.close();
}

function printTopics(date, topics, total) {
  console.log(`Topics for ${date}`);
  console.log('===============');
  console.log(`Stored topics: ${total}`);

  if (!topics.length) {
    console.log('No topics matched the configured thresholds.');
    return;
  }

  for (const topic of topics) {
    console.log('');
    console.log(`#${topic.rank} [${topic.status}] score=${formatScore(topic.finalScore)} articles=${topic.articleCount} sources=${topic.uniqueSourceCount}`);
    console.log(`keywords: ${topic.labelKeywords.join(', ')}`);
    if (topic.themeId) console.log(`theme: [${topic.themeId.slice(-8)}] ${(topic.themeLabel || []).join(', ')}`);
    console.log([
      `novelty=${formatScore(topic.noveltyScore)}`,
      `burst=${formatScore(topic.burstScore)}`,
      `z=${formatScore(topic.burstZScore)}`,
      `diversity=${formatScore(topic.sourceDiversity)}`,
      `persistence=${formatScore(topic.persistenceScore)}`,
      `history_sim=${formatScore(topic.maxHistoricalSimilarity)}`
    ].join(' '));
    if (topic.entities.length) {
      console.log(`entities: ${topic.entities.join(', ')}`);
    }
    if (topic.topSources.length) {
      console.log(`sources: ${topic.topSources.join(', ')}`);
    }
    for (const headline of topic.sampleHeadlines) {
      console.log(`- ${headline}`);
    }
  }
}

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const next = args[index + 1];
    if (!next || next.startsWith('--')) {
      options[key] = true;
    } else {
      options[key] = next;
      index += 1;
    }
  }
  return options;
}

function validateDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`Invalid --date value: ${date}. Expected YYYY-MM-DD.`);
  }
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function formatScore(value) {
  return Number(value || 0).toFixed(2);
}

main().catch(async error => {
  console.error(`Topic detection failed: ${error.message}`);
  await duckDBService.close().catch(() => {});
  process.exit(1);
});
