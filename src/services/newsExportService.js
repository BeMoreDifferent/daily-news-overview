import { promises as fs } from 'fs';
import path from 'path';
import { summarizeTopics } from './newsSummaryService.js';

const NEWS_DIR = path.join('news');
const ARTICLES_PER_TOPIC = 5;
const MAX_TOPICS = 15;
const MIN_TOPICS = 5;
const SCORE_FLOOR_RATIO = 0.4;
const DESCRIPTION_CHARS = 300;
const TOPIC_ARTICLE_POOL = 200;

// Topics arrive sorted by finalScore. Keep the best topic per theme (sub-stories of one theme
// would otherwise crowd the page), drop anything under the score floor, but always show MIN_TOPICS.
function selectTopics(allTopics) {
  if (!allTopics.length) return [];

  const floor = (allTopics[0].finalScore ?? 0) * SCORE_FLOOR_RATIO;
  const seenThemes = new Set();
  const selected = [];
  for (const topic of allTopics) {
    if (selected.length >= MAX_TOPICS) break;
    if ((topic.finalScore ?? 0) < floor && selected.length >= MIN_TOPICS) break;
    if (topic.themeId && seenThemes.has(topic.themeId)) continue;
    if (topic.themeId) seenThemes.add(topic.themeId);
    selected.push(topic);
  }
  return selected;
}

// Most central articles first (sampleHeadlines is stored in centrality order), one per outlet,
// no repeated headlines.
function pickArticles(topic, rows) {
  const rank = new Map((topic.sampleHeadlines || []).map((title, index) => [title, index]));
  const ordered = [...rows].sort((a, b) => (rank.get(a.title) ?? Infinity) - (rank.get(b.title) ?? Infinity));
  const seenTitles = new Set();
  const seenSources = new Set();
  const picked = [];
  for (const row of ordered) {
    const titleKey = String(row.title || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    const sourceKey = row.feed_title || row.feed_url || row.url;
    if (!titleKey || seenTitles.has(titleKey) || seenSources.has(sourceKey)) continue;
    seenTitles.add(titleKey);
    seenSources.add(sourceKey);
    picked.push(row);
    if (picked.length >= ARTICLES_PER_TOPIC) break;
  }
  return picked;
}

// Google News appends " - Publisher" to every title; drop it (the source is shown separately).
function cleanTitle(row) {
  const title = String(row.title || '');
  return /google news/i.test(row.feed_title || '') ? title.replace(/\s[-–|]\s[^-–|]{2,60}$/, '') : title;
}

function buildArticleObj(row) {
  const obj = { title: cleanTitle(row), url: row.url };
  if (row.feed_title) obj.source = row.feed_title;
  if (row.published_at) {
    obj.published_at = row.published_at instanceof Date
      ? row.published_at.toISOString()
      : new Date(row.published_at).toISOString();
  }
  if (row.image_url) obj.image = row.image_url;
  const description = cleanDescription(row.summary, row.title);
  if (description) obj.description = description;
  return obj;
}

function cleanDescription(summary, title) {
  const text = String(summary || '').replace(/\s+/g, ' ').trim();
  if (!text || text === String(title || '').trim()) return null;
  return text.length > DESCRIPTION_CHARS ? `${text.slice(0, DESCRIPTION_CHARS - 1).trimEnd()}…` : text;
}

function buildTopicObj(topic, articles) {
  const headline = topic.sampleHeadlines?.[0] || null;
  const obj = {
    id: topic.id,
    title: headline,
    headline,
    label: (topic.labelKeywords || []).slice(0, 6),
    category: topic.status || 'new',
  };
  if (topic.themeId) obj.theme = topic.themeId;
  const entities = (topic.entities || []).slice(0, 5);
  if (entities.length) obj.entities = entities;
  obj.article_count = topic.articleCount || 0;
  obj.source_count = topic.uniqueSourceCount || 0;

  if (articles.length) {
    obj.articles = articles.map(buildArticleObj);
  } else if (topic.sampleHeadlines?.length) {
    obj.articles = topic.sampleHeadlines.slice(0, ARTICLES_PER_TOPIC).map(h => ({ title: h }));
  } else {
    obj.articles = [];
  }

  return obj;
}

// Apply model titles/summaries; fold clusters the model flags as the same story into the earlier one.
function applySummaries(topicObjects, summaries) {
  if (!summaries) return topicObjects;
  const byId = new Map(topicObjects.map(topic => [topic.id, topic]));
  const kept = [];
  for (const topic of topicObjects) {
    const result = summaries.get(topic.id);
    const target = result?.duplicateOf ? byId.get(result.duplicateOf) : null;
    if (target && target !== topic && kept.includes(target)) {
      const titles = new Set(target.articles.map(a => a.title));
      for (const article of topic.articles) {
        if (target.articles.length >= ARTICLES_PER_TOPIC) break;
        if (!titles.has(article.title)) target.articles.push(article);
      }
      continue;
    }
    if (result) {
      topic.title = result.title;
      if (result.summary) topic.summary = result.summary;
    }
    kept.push(topic);
  }
  return kept;
}

/**
 * Export top topics for `date` to news/<date>.json.
 * `db` must implement getTopicsBetweenDates(start, end) and getArticlesForTopic(topicId, limit).
 * Returns number of articles written, or null if file already existed and force=false.
 */
export async function exportNewsForDate(db, date, { force = false, summarize = true, summaryOptions = {} } = {}) {
  await fs.mkdir(NEWS_DIR, { recursive: true });

  const outPath = path.join(NEWS_DIR, `${date}.json`);
  const tmpPath = path.join(NEWS_DIR, `.${date}.json.tmp`);

  if (!force) {
    try { await fs.access(outPath); return null; } catch { /* proceed */ }
  }

  const allTopics = await db.getTopicsBetweenDates(date, date);
  if (!allTopics.length) return 0;

  let topicObjects = [];
  for (const topic of selectTopics(allTopics)) {
    const rows = await db.getArticlesForTopic(topic.id, TOPIC_ARTICLE_POOL);
    topicObjects.push(buildTopicObj(topic, pickArticles(topic, rows)));
  }

  if (summarize) {
    topicObjects = applySummaries(topicObjects, await summarizeTopics(topicObjects, summaryOptions));
  }

  const output = {
    date,
    generated_at: new Date().toISOString(),
    topics: topicObjects,
  };

  await fs.writeFile(tmpPath, JSON.stringify(output, null, 2), 'utf8');
  await fs.rename(tmpPath, outPath);
  return topicObjects.reduce((sum, topic) => sum + topic.articles.length, 0);
}
