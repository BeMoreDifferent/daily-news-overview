import { promises as fs } from 'fs';
import path from 'path';

const NEWS_DIR = path.join('news');
const ARTICLES_PER_TOPIC = 5;
const MAX_TOPICS = 20;
const MIN_TOPICS = 5;
const SCORE_FLOOR_RATIO = 0.5;

// Adaptive topic selection: top 10 → drop below score floor → merge by themeId → floor 5
function selectTopics(allTopics) {
  if (!allTopics.length) return [];

  const candidates = allTopics.slice(0, MAX_TOPICS);
  const topScore = candidates[0].finalScore ?? 0;
  const floor = topScore * SCORE_FLOOR_RATIO;

  const themeMap = new Map();
  const unthemed = [];

  for (const t of candidates) {
    if (!t.finalScore || t.finalScore < floor) continue;
    if (t.themeId) {
      if (!themeMap.has(t.themeId)) {
        themeMap.set(t.themeId, { ...t });
      } else {
        const existing = themeMap.get(t.themeId);
        existing.articleCount = (existing.articleCount || 0) + (t.articleCount || 0);
        existing.uniqueSourceCount = Math.max(existing.uniqueSourceCount || 0, t.uniqueSourceCount || 0);
      }
    } else {
      unthemed.push(t);
    }
  }

  const merged = [...themeMap.values(), ...unthemed]
    .sort((a, b) => (b.finalScore ?? 0) - (a.finalScore ?? 0))
    .slice(0, MAX_TOPICS);

  if (merged.length < MIN_TOPICS) {
    const seen = new Set(merged.map(t => t.id));
    for (const t of allTopics) {
      if (merged.length >= MIN_TOPICS) break;
      if (!seen.has(t.id)) { merged.push(t); seen.add(t.id); }
    }
  }

  return merged;
}

function buildArticleObj(row) {
  const obj = { title: row.title, url: row.url };
  if (row.feed_title) obj.source = row.feed_title;
  if (row.published_at) {
    obj.published_at = row.published_at instanceof Date
      ? row.published_at.toISOString()
      : new Date(row.published_at).toISOString();
  }
  if (row.image_url) obj.image = row.image_url;
  if (row.summary) obj.description = row.summary;
  return obj;
}

function buildTopicObj(topic, articles) {
  const obj = {
    id: topic.id,
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

/**
 * Export top topics for `date` to news/<date>.json.
 * `db` must implement getTopicsBetweenDates(start, end) and getArticlesForTopic(topicId, limit).
 * Returns number of articles written, or null if file already existed and force=false.
 */
export async function exportNewsForDate(db, date, { force = false } = {}) {
  await fs.mkdir(NEWS_DIR, { recursive: true });

  const outPath = path.join(NEWS_DIR, `${date}.json`);
  const tmpPath = path.join(NEWS_DIR, `.${date}.json.tmp`);

  if (!force) {
    try { await fs.access(outPath); return null; } catch { /* proceed */ }
  }

  const allTopics = await db.getTopicsBetweenDates(date, date);
  if (!allTopics.length) return 0;

  const selected = selectTopics(allTopics);
  const topicObjects = [];
  let totalArticles = 0;

  for (const topic of selected) {
    const articles = await db.getArticlesForTopic(topic.id, ARTICLES_PER_TOPIC);
    topicObjects.push(buildTopicObj(topic, articles));
    totalArticles += articles.length || Math.min(topic.sampleHeadlines?.length ?? 0, ARTICLES_PER_TOPIC);
  }

  const output = {
    date,
    generated_at: new Date().toISOString(),
    topics: topicObjects,
  };

  await fs.writeFile(tmpPath, JSON.stringify(output, null, 2), 'utf8');
  await fs.rename(tmpPath, outPath);
  return totalArticles;
}
