import { hash64 } from '../utils/hash.js';

const STOPWORDS = new Set([
  'a', 'about', 'above', 'after', 'again', 'against', 'all', 'am', 'an', 'and',
  'any', 'are', 'as', 'at', 'be', 'because', 'been', 'before', 'being',
  'below', 'between', 'both', 'but', 'by', 'can', 'could', 'did', 'do', 'does',
  'doing', 'down', 'during', 'each', 'few', 'for', 'from', 'further', 'had',
  'has', 'have', 'having', 'he', 'her', 'here', 'hers', 'herself', 'him',
  'himself', 'his', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its',
  'itself', 'just', 'me', 'more', 'most', 'my', 'myself', 'new', 'news', 'no',
  'nor', 'not', 'now', 'of', 'off', 'on', 'once', 'only', 'or', 'other',
  'our', 'ours', 'ourselves', 'out', 'over', 'own', 's', 'same', 'she',
  'should', 'so', 'some', 'such', 't', 'than', 'that', 'the', 'their',
  'theirs', 'them', 'themselves', 'then', 'there', 'these', 'they', 'this',
  'those', 'through', 'to', 'too', 'under', 'until', 'up', 'very', 'was',
  'we', 'were', 'what', 'when', 'where', 'which', 'while', 'who', 'whom',
  'why', 'will', 'with', 'you', 'your', 'yours', 'yourself', 'yourselves'
]);

const DEFAULT_OPTIONS = {
  historyDays: 14,
  minTopicSize: 3,
  minSources: 2,
  headlineSimilarityThreshold: 0.28,
  historicalSimilarityThreshold: 0.65,
  labelKeywordCount: 8,
  themeThreshold: 0.10
};

export async function detectTopicsForDate(duckDBService, date, options = {}) {
  const config = { maxArticles: 4000, ...DEFAULT_OPTIONS, ...options };

  const articles = await duckDBService.getArticlesForDate(date, config.maxArticles);
  const historyStartDate = shiftDate(date, -config.historyDays);
  const historicalTopics = await duckDBService.getTopicsBetweenDates(historyStartDate, shiftDate(date, -1));

  const currentTopics = detectTopicsFromArticles(articles, config);
  const scoredTopics = scoreTopics(currentTopics, historicalTopics, config)
    .sort(compareTopics)
    .map((topic, index) => ({ ...topic, rank: index + 1 }));

  await duckDBService.replaceTopicsForDate(date, scoredTopics);

  return scoredTopics;
}

export function detectTopicsFromArticles(articles, options = {}) {
  const config = { ...DEFAULT_OPTIONS, ...options };
  const documents = articles
    .map(article => createHeadlineDocument(article))
    .filter(document => document.terms.length);

  if (!documents.length) return [];

  const vectors = buildTfidfVectors(documents.map(document => document.terms));
  const vectorized = documents.map((document, index) => ({
    ...document,
    vector: vectors[index]
  }));
  const clusters = clusterHeadlines(vectorized, config.headlineSimilarityThreshold);
  const topics = clusters
    .map(cluster => createTopic(cluster, config))
    .filter(topic => topic.articleCount >= config.minTopicSize)
    .filter(topic => topic.uniqueSourceCount >= config.minSources);

  const themeGroups = clusterHeadlines(topics.map(t => ({ t, vector: t.centroidVector })), config.themeThreshold);
  for (const group of themeGroups) {
    const themeVector = averageVectors(group.map(g => g.vector));
    const themeLabel = [...themeVector.entries()].filter(([k]) => !k.includes(' ')).sort((a, b) => b[1] - a[1]).map(([k]) => k).slice(0, 4);
    const themeId = `theme_${hash64(group.map(g => g.t.id).sort().join('|')).toString(16)}`;
    for (const { t } of group) { t.themeId = themeId; t.themeLabel = themeLabel; }
  }
  return topics;
}

export function normalizeHeadline(headline) {
  return String(headline || '')
    .toLowerCase()
    .replace(/['']s\b/g, '')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/-/g, ' ')
    .split(/\s+/)
    .map(token => token.trim())
    .filter(Boolean)
    .filter(token => !STOPWORDS.has(token))
    .map(stemToken)
    .filter(token => token.length > 1 && !STOPWORDS.has(token));
}

export function extractHeadlineTerms(headline) {
  const tokens = normalizeHeadline(headline);
  return [...tokens, ...extractNgrams(tokens, 2)];
}

export function buildTfidfVectors(termLists) {
  const documentCount = termLists.length;
  const documentFrequency = new Map();
  for (const terms of termLists) {
    for (const term of new Set(terms)) {
      documentFrequency.set(term, (documentFrequency.get(term) || 0) + 1);
    }
  }

  return termLists.map(terms => {
    const vector = new Map();
    const counts = new Map();
    for (const term of terms) {
      counts.set(term, (counts.get(term) || 0) + 1);
    }

    for (const [term, count] of counts.entries()) {
      const idf = Math.log((1 + documentCount) / (1 + documentFrequency.get(term))) + 1;
      vector.set(term, (count / terms.length) * idf);
    }
    return vector;
  });
}

export function cosineSimilarity(vectorA, vectorB) {
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (const value of vectorA.values()) {
    normA += value * value;
  }
  for (const value of vectorB.values()) {
    normB += value * value;
  }
  if (!normA || !normB) return 0;

  const [smaller, larger] = vectorA.size < vectorB.size
    ? [vectorA, vectorB]
    : [vectorB, vectorA];
  for (const [term, value] of smaller.entries()) {
    dot += value * (larger.get(term) || 0);
  }

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function clusterHeadlines(documents, threshold = DEFAULT_OPTIONS.headlineSimilarityThreshold) {
  const n = documents.length;
  const parent = documents.map((_, index) => index);

  // Inverted index → only compare pairs that share ≥1 term (cosine of non-overlapping vectors = 0)
  const termIndex = new Map();
  for (let i = 0; i < n; i++) {
    for (const term of documents[i].vector.keys()) {
      if (!termIndex.has(term)) termIndex.set(term, []);
      termIndex.get(term).push(i);
    }
  }

  const checked = new Set();
  for (const docList of termIndex.values()) {
    for (let a = 0; a < docList.length; a++) {
      for (let b = a + 1; b < docList.length; b++) {
        const i = docList[a], j = docList[b];
        const key = i * n + j;
        if (checked.has(key)) continue;
        checked.add(key);
        if (cosineSimilarity(documents[i].vector, documents[j].vector) >= threshold) {
          union(parent, i, j);
        }
      }
    }
  }

  const groups = new Map();
  for (let index = 0; index < n; index++) {
    const root = find(parent, index);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(documents[index]);
  }

  return [...groups.values()];
}

export function scoreTopics(topics, historicalTopics = [], options = {}) {
  const config = { ...DEFAULT_OPTIONS, ...options };

  // Parse historical centroid vectors once, not once per (current × historical) pair
  const parsedHistorical = historicalTopics.map(h => ({
    ...h,
    _vector: vectorFromObject(h.centroidVector)
  }));

  return topics.map(topic => {
    const matches = parsedHistorical
      .map(history => ({
        ...history,
        similarity: cosineSimilarity(topic.centroidVector, history._vector)
      }))
      .filter(history => history.similarity >= config.historicalSimilarityThreshold)
      .sort((a, b) => b.similarity - a.similarity);

    const maxSimilarity = matches[0]?.similarity || 0;
    const noveltyScore = clamp(1 - maxSimilarity);
    const baselineCounts = matches.map(match => Number(match.articleCount || 0));
    const burst = calculateBurst(topic.articleCount, baselineCounts);
    const sourceDiversity = topic.articleCount ? topic.uniqueSourceCount / topic.articleCount : 0;
    const persistenceScore = topic.activeWindows.length / 4;
    const entityImportance = clamp(topic.entities.length / 4);
    const finalScore = clamp(
      0.35 * noveltyScore
      + 0.30 * burst.normalized
      + 0.20 * sourceDiversity
      + 0.10 * persistenceScore
      + 0.05 * entityImportance
    );

    return {
      ...topic,
      noveltyScore,
      burstScore: burst.normalized,
      burstZScore: burst.zScore,
      sourceDiversity,
      persistenceScore,
      entityImportance,
      maxHistoricalSimilarity: maxSimilarity,
      matchedHistoricalTopicIds: matches.slice(0, 5).map(match => match.id),
      finalScore,
      status: classifyTopic({
        noveltyScore,
        burstZScore: burst.zScore,
        burstScore: burst.normalized,
        maxHistoricalSimilarity: maxSimilarity,
        persistenceScore,
        articleCount: topic.articleCount,
        minTopicSize: config.minTopicSize
      })
    };
  });
}

export function classifyTopic(topic) {
  if (topic.maxHistoricalSimilarity >= DEFAULT_OPTIONS.historicalSimilarityThreshold) {
    if (topic.burstZScore >= 2 || topic.burstScore >= 0.8) return 'trending';
    return 'ongoing';
  }
  if (topic.noveltyScore >= 0.70) return 'new';
  if (topic.burstZScore >= 2 || topic.burstScore >= 0.8) return 'trending';
  return 'monitor';
}

function createHeadlineDocument(article) {
  const text = article.title || article.summary || '';
  return {
    article,
    terms: extractHeadlineTerms(text)
  };
}

function createTopic(cluster, config) {
  const centroidVector = averageVectors(cluster.map(document => document.vector));
  const labelKeywords = [...centroidVector.entries()]
    .filter(([term]) => !term.includes(' ') || term.length <= 40)
    .sort((a, b) => b[1] - a[1])
    .map(([term]) => term)
    .slice(0, config.labelKeywordCount);
  const articles = cluster.map(document => document.article);
  const entities = unique(articles.flatMap(a => extractEntities(a.title || a.summary || ''))).slice(0, 12);
  const articleHashes = articles.map(article => String(article.url_hash));
  const activeWindows = getActiveWindows(articles);

  return {
    id: createTopicId(articles, labelKeywords),
    date: null,
    articleHashes,
    articleCount: articles.length,
    uniqueSourceCount: unique(articles.map(article => article.feed_url || article.feed_title || 'unknown')).length,
    labelKeywords,
    entities,
    centroidVector,
    activeWindows,
    sampleHeadlines: articles
      .map(article => article.title || article.summary)
      .filter(Boolean)
      .slice(0, 5),
    topSources: unique(articles.map(article => article.feed_title || article.feed_url || 'unknown')).slice(0, 5)
  };
}

function calculateBurst(todayCount, baselineCounts) {
  if (!baselineCounts.length) {
    return {
      zScore: todayCount >= 2 ? 3 : 0,
      normalized: todayCount >= 2 ? 1 : 0
    };
  }

  const mean = baselineCounts.reduce((sum, count) => sum + count, 0) / baselineCounts.length;
  const variance = baselineCounts.reduce((sum, count) => sum + (count - mean) ** 2, 0) / baselineCounts.length;
  const std = Math.sqrt(variance);
  const zScore = std > 0 ? (todayCount - mean) / std : todayCount > mean ? 3 : 0;
  return {
    zScore,
    normalized: clamp(zScore / 3)
  };
}

function averageVectors(vectors) {
  const averaged = new Map();
  for (const vector of vectors) {
    for (const [term, value] of vector.entries()) {
      averaged.set(term, (averaged.get(term) || 0) + value / vectors.length);
    }
  }
  return averaged;
}

function extractNgrams(tokens, size) {
  const ngrams = [];
  for (let index = 0; index <= tokens.length - size; index += 1) {
    ngrams.push(tokens.slice(index, index + size).join(' '));
  }
  return ngrams;
}

function extractEntities(headline) {
  const matches = String(headline || '').match(/\b(?:[A-Z][a-zA-Z0-9]+|[A-Z]{2,})(?:\s+(?:[A-Z][a-zA-Z0-9]+|[A-Z]{2,})){0,3}\b/g) || [];
  return unique(matches
    .map(entity => entity.trim())
    .filter(entity => entity.length > 1)
    .filter(entity => !STOPWORDS.has(entity.toLowerCase())))
    .slice(0, 12);
}

function stemToken(token) {
  if (token.length <= 3) return token;
  if (token.endsWith('ies') && token.length > 4) return `${token.slice(0, -3)}y`;
  if (token.endsWith('ing') && token.length > 5) return token.slice(0, -3);
  if (token.endsWith('ed') && token.length > 4) return token.slice(0, -2);
  if (token.endsWith('es') && token.length > 4) return token.slice(0, -2);
  if (token.endsWith('s') && token.length > 4) return token.slice(0, -1);
  return token;
}

function getActiveWindows(articles) {
  const windows = new Set();
  for (const article of articles) {
    const date = new Date(article.published_at || article.fetched_at);
    if (Number.isNaN(date.getTime())) continue;
    const hour = date.getUTCHours();
    if (hour < 6) windows.add('night');
    else if (hour < 12) windows.add('morning');
    else if (hour < 18) windows.add('afternoon');
    else windows.add('evening');
  }
  return [...windows].sort();
}

function createTopicId(articles, labelKeywords) {
  const articlePart = articles
    .map(article => String(article.url_hash))
    .sort()
    .join('|');
  return `topic_${hash64(`${labelKeywords.join('|')}|${articlePart}`).toString(16)}`;
}

function vectorFromObject(value) {
  if (value instanceof Map) return value;
  const parsed = typeof value === 'string' ? JSON.parse(value || '{}') : value || {};
  return new Map(Object.entries(parsed).map(([term, weight]) => [term, Number(weight)]));
}

export function vectorToObject(vector) {
  return Object.fromEntries([...vector.entries()].sort((a, b) => a[0].localeCompare(b[0])));
}

function compareTopics(a, b) {
  return b.finalScore - a.finalScore
    || b.articleCount - a.articleCount
    || b.uniqueSourceCount - a.uniqueSourceCount
    || a.labelKeywords.join(' ').localeCompare(b.labelKeywords.join(' '));
}

function find(parent, index) {
  if (parent[index] !== index) parent[index] = find(parent, parent[index]);
  return parent[index];
}

function union(parent, a, b) {
  const rootA = find(parent, a);
  const rootB = find(parent, b);
  if (rootA !== rootB) parent[rootB] = rootA;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function clamp(value) {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function shiftDate(date, days) {
  const shifted = new Date(`${date}T00:00:00Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}
