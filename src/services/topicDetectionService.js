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
  'why', 'will', 'with', 'you', 'your', 'yours', 'yourself', 'yourselves',
  // News boilerplate that links unrelated headlines
  'say', 'says', 'said', 'live', 'video', 'watch', 'breaking', 'latest', 'update',
  'updates', 'exclusive', 'opinion', 'analysis', 'photos', 'podcast', 'amp',
  // German
  'der', 'das', 'und', 'ist', 'im', 'mit', 'von', 'zu', 'den', 'dem', 'des', 'ein',
  'eine', 'einer', 'eines', 'auf', 'fur', 'nicht', 'sich', 'bei', 'nach', 'aus',
  'als', 'auch', 'es', 'wie', 'wird', 'werden', 'hat', 'sind', 'vom', 'zum', 'zur',
  'um', 'uber', 'noch', 'jetzt',
  // French
  'le', 'la', 'les', 'un', 'une', 'du', 'de', 'et', 'en', 'au', 'aux', 'pour', 'par',
  'sur', 'dans', 'est', 'qui', 'que', 'pas', 'avec', 'ce', 'cette', 'se', 'ses',
  'il', 'elle', 'ils', 'apres', 'sont', 'selon',
  // Spanish / Portuguese / Italian
  'el', 'los', 'las', 'del', 'al', 'por', 'con', 'para', 'una', 'uno', 'su', 'sus',
  'como', 'mas', 'lo', 'tras', 'os', 'um', 'uma', 'do', 'da', 'dos', 'das', 'no',
  'na', 'nos', 'nas', 'em', 'ao', 'il', 'gli', 'della', 'delle', 'dei', 'di', 'per',
  'che', 'nel', 'nella', 'sobre', 'entre'
]);

const DEFAULT_OPTIONS = {
  historyDays: 14,
  minTopicSize: 3,
  minSources: 3,
  headlineSimilarityThreshold: 0.30,
  clusterMergeThreshold: 0.50,
  maxCandidateDfRatio: 0.01,
  historicalSimilarityThreshold: 0.40,
  labelKeywordCount: 8,
  sampleHeadlineCount: 10,
  centroidTermCount: 60,
  maxStoredTopics: 200,
  themeThreshold: 0.30,
  videoSimilarityThreshold: 0.30,
  minVideoSharedWords: 2,
  maxVideosPerTopic: 3,
  followUpDays: 2,
  followUpRankLimit: 20,
  followUpHeadlineShare: 0.6,
  followUpMaxDfRatio: 0.005,
  followUpMinLift: 5,
  followUpMaxPerFeed: 3,
  followUpBaselineDays: 7
};

export async function detectTopicsForDate(duckDBService, date, options = {}) {
  const config = { maxArticles: 40000, ...DEFAULT_OPTIONS, ...options };

  const articles = await duckDBService.getArticlesForDate(date, config.maxArticles);
  const videos = await duckDBService.getVideosForDate(date);
  const historyStartDate = shiftDate(date, -config.historyDays);
  const historicalTopics = await duckDBService.getTopicsBetweenDates(historyStartDate, shiftDate(date, -1));

  const followUpTopics = topRankedPerDay(historicalTopics.filter(topic => topic.date >= shiftDate(date, -config.followUpDays)), config.followUpRankLimit);
  // A week-old day tells story words ("php") apart from everyday ones ("west", "firm").
  const followUpBaseline = followUpTopics.length && config.followUpRankLimit
    ? (await duckDBService.getArticlesForDate(shiftDate(date, -config.followUpBaselineDays), config.maxArticles)).map(article => article.title)
    : [];
  const currentTopics = detectTopicsFromArticles(articles, { ...config, videos, followUpTopics, followUpBaseline });
  // Only the top of the ranking is ever exported or useful as history; storing the long tail of
  // small clusters just bloats the topics tables.
  const scoredTopics = scoreTopics(currentTopics, historicalTopics, config)
    .sort(compareTopics)
    .slice(0, config.maxStoredTopics)
    .map((topic, index) => ({ ...topic, rank: index + 1 }));

  await duckDBService.replaceTopicsForDate(date, scoredTopics);

  return scoredTopics;
}

// `options.videos` (source_type 2 rows) are matched to the finished topics afterwards; they never
// shape the clusters, counts or ranking.
export function detectTopicsFromArticles(articles, options = {}) {
  const config = { ...DEFAULT_OPTIONS, ...options };
  const documents = dedupeSyndicated(articles);
  if (!documents.length) return [];

  const vectorize = createTfidfVectorizer(documents.map(document => document.terms));
  documents.forEach(document => { document.vector = vectorize(document.terms); });
  const clusters = groupFollowUps(clusterHeadlines(documents, config.headlineSimilarityThreshold, config), documents, config.followUpTopics || [], config);
  const topics = clusters
    .map(cluster => createTopic(cluster, config))
    .filter(topic => topic.articleCount >= config.minTopicSize)
    .filter(topic => topic.uniqueSourceCount >= config.minSources);

  const themeGroups = clusterHeadlines(topics.map(t => ({ t, vector: t.centroidVector })), config.themeThreshold, config);
  for (const group of themeGroups) {
    const themeVector = averageVectors(group.map(g => g.vector));
    const themeLabel = [...themeVector.entries()].filter(([k]) => !k.includes(' ')).sort((a, b) => b[1] - a[1]).map(([k]) => k).slice(0, 4);
    const themeId = `theme_${hash64(group.map(g => g.t.id).sort().join('|')).toString(16)}`;
    for (const { t } of group) { t.themeId = themeId; t.themeLabel = themeLabel; }
  }
  attachVideos(topics, config.videos || [], vectorize, config);
  return topics;
}

// Each video joins the topic whose centroid it is most similar to (in the news corpus' TF-IDF
// space), if that clears the threshold and shares at least two words with it; a topic keeps its best few, one per channel. The match uses
// the better of the bare title and title + start of the description, since long descriptions dilute.
export function attachVideos(topics, videos, vectorize, options = {}) {
  const config = { ...DEFAULT_OPTIONS, ...options };
  for (const topic of topics) topic.videoHashes = [];
  if (!topics.length || !videos.length) return topics;

  const matches = new Map(topics.map(topic => [topic, []]));
  for (const video of videos) {
    const title = stripChannelSuffix(video.title);
    if (!title) continue;
    const texts = [title, `${title} ${String(video.summary || '').slice(0, 200)}`];
    const vectors = texts.map(text => vectorize(extractHeadlineTerms(text))).filter(vector => vector.size);
    let best = null;
    let bestSimilarity = 0;
    for (const topic of topics) {
      for (const vector of vectors) {
        if (sharedWords(vector, topic.centroidVector) < config.minVideoSharedWords) continue;
        const similarity = cosineSimilarity(vector, topic.centroidVector);
        if (similarity > bestSimilarity) {
          best = topic;
          bestSimilarity = similarity;
        }
      }
    }
    if (best && bestSimilarity >= config.videoSimilarityThreshold) {
      matches.get(best).push({ video, similarity: bestSimilarity });
    }
  }

  for (const [topic, candidates] of matches) {
    const channels = new Set();
    for (const { video } of candidates.sort((a, b) => b.similarity - a.similarity)) {
      const channel = video.feed_url || video.feed_title;
      if (channels.has(channel)) continue;
      channels.add(channel);
      topic.videoHashes.push(String(video.url_hash));
      if (topic.videoHashes.length >= config.maxVideosPerTopic) break;
    }
  }
  return topics;
}

// Day-2/3 coverage of a big story takes new angles ("Japan to simulate cyberattacks as PHP flaws
// roil internet", "IT workers on frontline of PHP scramble") that share too little wording to
// cluster, so the story falls apart into fragments. Each recent top story contributes one anchor:
// one of its top label keywords that is in most of its headlines, still rare today, and at least
// `followUpMinLift` times more frequent than in `baselineTitles` (headlines from a week before),
// so everyday words never qualify. A headline counts for the story only if it also shares another
// word with the story's centroid ("Macron" alone would join unrelated Macron news). Clusters mostly
// made of such headlines are merged into one follow-up cluster; others stay untouched.
export function followUpAnchors(followUpTopics, documents, baselineTitles = [], options = {}) {
  const config = { ...DEFAULT_OPTIONS, ...options };
  if (!baselineTitles.length) return [];
  const documentFrequency = new Map();
  for (const document of documents) {
    for (const stem of documentStems(document)) documentFrequency.set(stem, (documentFrequency.get(stem) || 0) + 1);
  }
  const baselineFrequency = new Map();
  for (const title of baselineTitles) {
    for (const stem of new Set(normalizeHeadline(title))) baselineFrequency.set(stem, (baselineFrequency.get(stem) || 0) + 1);
  }
  const maxDf = Math.max(1, Math.floor(documents.length * config.followUpMaxDfRatio));
  const lift = stem => (documentFrequency.get(stem) / documents.length)
    / (((baselineFrequency.get(stem) || 0) + 1) / baselineTitles.length);

  const anchors = [];
  for (const topic of followUpTopics) {
    const headlines = parseList(topic.sampleHeadlines).map(headline => new Set(normalizeHeadline(headline)));
    if (!headlines.length) continue;
    const candidates = unique(parseList(topic.labelKeywords).slice(0, 3).map(keyword => normalizeHeadline(keyword)[0]))
      .map(stem => ({
        stem,
        share: headlines.filter(stems => stems.has(stem)).length / headlines.length,
        df: documentFrequency.get(stem) || 0
      }))
      .filter(candidate => candidate.share >= config.followUpHeadlineShare && candidate.df > 0 && candidate.df <= maxDf)
      .filter(candidate => lift(candidate.stem) >= config.followUpMinLift)
      .sort((a, b) => b.share - a.share);
    if (!candidates.length || anchors.some(anchor => anchor.stem === candidates[0].stem)) continue;
    const stem = candidates[0].stem;
    // Context words must be specific: not common today ("france" on a riot day) and not the other
    // half of the anchor's name ("emmanuel" for "macron"), which every headline about them has.
    const nameParts = new Set(parseList(topic.entities)
      .map(entity => normalizeHeadline(entity))
      .filter(stems => stems.length === 2 && stems.includes(stem))
      .flat());
    const context = new Set([...vectorFromObject(topic.centroidVector).keys()]
      .filter(term => !term.includes(' ') && term !== stem && !nameParts.has(term))
      .filter(term => (documentFrequency.get(term) || 0) <= maxDf));
    anchors.push({ stem, context });
  }
  return anchors;
}

function groupFollowUps(clusters, documents, followUpTopics, config) {
  if (!followUpTopics.length || !config.followUpRankLimit) return clusters;
  const anchors = followUpAnchors(followUpTopics, documents, config.followUpBaseline || [], config);
  if (!anchors.length) return clusters;

  // Feeds that emit many headlines with the anchor in one day are templated firehoses ("WordPress
  // … theme - PHP Object Injection"); their headlines never join a follow-up.
  const anchorArticlesPerFeed = new Map();
  for (const document of documents) {
    const stems = documentStems(document);
    for (const { stem } of anchors) {
      if (!stems.has(stem)) continue;
      for (const article of document.articles) {
        const key = `${stem}|${articleFeed(article)}`;
        anchorArticlesPerFeed.set(key, (anchorArticlesPerFeed.get(key) || 0) + 1);
      }
    }
  }
  const counts = (document, { stem, context }) => {
    const stems = documentStems(document);
    return stems.has(stem)
      && [...stems].some(other => context.has(other))
      && document.articles.some(article => (anchorArticlesPerFeed.get(`${stem}|${articleFeed(article)}`) || 0) <= config.followUpMaxPerFeed);
  };

  const groups = new Map(anchors.map(anchor => [anchor, []]));
  const rest = [];
  for (const cluster of clusters) {
    const anchor = anchors.find(candidate => cluster.filter(document => counts(document, candidate)).length * 2 >= cluster.length);
    if (anchor) groups.get(anchor).push(...cluster);
    else rest.push(cluster);
  }
  return [...rest, ...[...groups.values()].filter(group => group.length)];
}

function articleFeed(article) {
  return article.feed_url || article.feed_title || 'unknown';
}

function documentStems(document) {
  return document.stems || (document.stems = new Set(document.terms.filter(term => !term.includes(' '))));
}

function topRankedPerDay(topics, limit) {
  const byDate = new Map();
  for (const topic of topics) {
    if (!byDate.has(topic.date)) byDate.set(topic.date, []);
    byDate.get(topic.date).push(topic);
  }
  return [...byDate.values()].flatMap(dayTopics => [...dayTopics]
    .sort((a, b) => Number(b.finalScore || 0) - Number(a.finalScore || 0))
    .slice(0, limit));
}

function parseList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return []; }
  }
  return [];
}

// Short video titles ("I Google Myself") can score high on a single word; require real overlap.
function sharedWords(vector, centroid) {
  let count = 0;
  for (const term of vector.keys()) {
    if (!term.includes(' ') && centroid.has(term)) count += 1;
  }
  return count;
}

// "Fire at Eagle's Nest | DW News" -> the channel name is noise for matching.
function stripChannelSuffix(title) {
  return String(title || '').replace(/\s+[|•]\s+[^|•]{2,40}$/, '').replace(/#\S+/g, '').trim();
}

// Collapse syndicated copies (same normalized headline) into one document so wire stories
// don't dominate TF-IDF or appear repeatedly; every copy still counts as an article/source.
// Documents are returned oldest-first, which is the order the leader clustering expects.
function dedupeSyndicated(articles) {
  const byKey = new Map();
  for (const article of articles) {
    const analyzed = analyzeHeadline(article.title || article.summary || '');
    if (!analyzed.stems.length) continue;
    const key = analyzed.stems.join(' ');
    const existing = byKey.get(key);
    if (existing) {
      existing.articles.push(article);
    } else {
      byKey.set(key, { article, articles: [article], terms: analyzed.terms, surfaces: analyzed.surfaces });
    }
  }
  return [...byKey.values()].sort((a, b) => articleTime(a.article) - articleTime(b.article));
}

function articleTime(article) {
  const time = new Date(article.published_at || article.fetched_at).getTime();
  return Number.isNaN(time) ? 0 : time;
}

// Tokens keep their accented surface form for labels; matching uses an accent-free stem.
function tokenizeHeadline(headline) {
  return String(headline || '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/['’]s\b/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map(surface => ({ surface, key: surface.normalize('NFKD').replace(/\p{M}+/gu, '') }))
    .filter(({ key }) => key.length > 1 && !STOPWORDS.has(key) && !/^\d+$/.test(key))
    .map(({ surface, key }) => ({ surface, stem: stemToken(key) }))
    .filter(({ stem }) => stem.length > 1 && !STOPWORDS.has(stem));
}

export function normalizeHeadline(headline) {
  return tokenizeHeadline(headline).map(token => token.stem);
}

export function extractHeadlineTerms(headline) {
  return analyzeHeadline(headline).terms;
}

function analyzeHeadline(headline) {
  const tokens = tokenizeHeadline(headline);
  const stems = tokens.map(token => token.stem);
  const surfaces = new Map(tokens.map(token => [token.stem, token.surface]));
  for (let index = 0; index < tokens.length - 1; index += 1) {
    surfaces.set(`${stems[index]} ${stems[index + 1]}`, `${tokens[index].surface} ${tokens[index + 1].surface}`);
  }
  return { stems, surfaces, terms: [...stems, ...extractNgrams(stems, 2)] };
}

export function buildTfidfVectors(termLists) {
  return termLists.map(createTfidfVectorizer(termLists));
}

// Document frequencies come from `termLists`; the returned function vectorizes any term list in
// that space (terms the corpus never saw get the highest IDF).
export function createTfidfVectorizer(termLists) {
  const documentCount = termLists.length;
  const documentFrequency = new Map();
  for (const terms of termLists) {
    for (const term of new Set(terms)) {
      documentFrequency.set(term, (documentFrequency.get(term) || 0) + 1);
    }
  }

  return terms => {
    const vector = new Map();
    const counts = new Map();
    for (const term of terms) {
      counts.set(term, (counts.get(term) || 0) + 1);
    }

    for (const [term, count] of counts.entries()) {
      const idf = Math.log((1 + documentCount) / (1 + (documentFrequency.get(term) || 0))) + 1;
      vector.set(term, (count / terms.length) * idf);
    }
    return vector;
  };
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

// Centroid-guarded leader clustering. Each document joins the most similar existing cluster
// (cosine to the cluster's summed vector ≥ threshold) or starts a new one; a second pass merges
// clusters whose centroids are close. Unlike single-link union-find this cannot chain unrelated
// stories through one shared bigram. Candidate clusters come from an inverted index that skips
// very common terms, keeping the work near-linear for a full day (~25k headlines).
export function clusterHeadlines(documents, threshold = DEFAULT_OPTIONS.headlineSimilarityThreshold, options = {}) {
  const mergeThreshold = options.clusterMergeThreshold ?? DEFAULT_OPTIONS.clusterMergeThreshold;
  const maxDfRatio = options.maxCandidateDfRatio ?? DEFAULT_OPTIONS.maxCandidateDfRatio;
  const n = documents.length;
  if (!n) return [];

  const documentFrequency = new Map();
  for (const document of documents) {
    for (const term of document.vector.keys()) {
      documentFrequency.set(term, (documentFrequency.get(term) || 0) + 1);
    }
  }
  const maxDf = Math.max(50, Math.ceil(n * maxDfRatio));
  const isIndexable = term => documentFrequency.get(term) <= maxDf;

  const clusters = [];
  const termIndex = new Map();
  const indexTerm = (term, clusterId) => {
    if (!isIndexable(term)) return;
    let ids = termIndex.get(term);
    if (!ids) termIndex.set(term, ids = new Set());
    ids.add(clusterId);
  };

  for (const document of documents) {
    const normDoc = vectorNorm(document.vector);
    if (!normDoc) continue;
    const candidates = new Set();
    for (const term of document.vector.keys()) {
      const ids = termIndex.get(term);
      if (ids) for (const id of ids) candidates.add(id);
    }

    let best = null;
    let bestSimilarity = threshold;
    for (const id of candidates) {
      const cluster = clusters[id];
      const similarity = dotProduct(document.vector, cluster.sum) / (normDoc * Math.sqrt(cluster.normSq));
      if (similarity >= bestSimilarity) { best = cluster; bestSimilarity = similarity; }
    }

    if (!best) {
      best = { id: clusters.length, members: [], sum: new Map(), normSq: 0 };
      clusters.push(best);
    }
    best.members.push(document);
    addToSum(best, document.vector);
    for (const term of document.vector.keys()) indexTerm(term, best.id);
  }

  // Merge pass over multi-member clusters only (singletons were already offered every cluster).
  const parent = clusters.map((_, index) => index);
  const checked = new Set();
  for (const cluster of clusters) {
    if (cluster.members.length < 2) continue;
    for (const term of cluster.sum.keys()) {
      for (const otherId of termIndex.get(term) || []) {
        const other = clusters[otherId];
        if (otherId <= cluster.id || other.members.length < 2) continue;
        const key = `${cluster.id}:${otherId}`;
        if (checked.has(key)) continue;
        checked.add(key);
        const similarity = dotProduct(cluster.sum, other.sum) / Math.sqrt(cluster.normSq * other.normSq);
        if (similarity >= mergeThreshold) union(parent, cluster.id, otherId);
      }
    }
  }

  const groups = new Map();
  for (const cluster of clusters) {
    const root = find(parent, cluster.id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(...cluster.members);
  }
  return [...groups.values()];
}

function addToSum(cluster, vector) {
  for (const [term, value] of vector.entries()) {
    const previous = cluster.sum.get(term) || 0;
    const next = previous + value;
    cluster.sum.set(term, next);
    cluster.normSq += next * next - previous * previous;
  }
}

function dotProduct(vectorA, vectorB) {
  const [smaller, larger] = vectorA.size < vectorB.size ? [vectorA, vectorB] : [vectorB, vectorA];
  let dot = 0;
  for (const [term, value] of smaller.entries()) dot += value * (larger.get(term) || 0);
  return dot;
}

function vectorNorm(vector) {
  let sum = 0;
  for (const value of vector.values()) sum += value * value;
  return Math.sqrt(sum);
}

export function scoreTopics(topics, historicalTopics = [], options = {}) {
  const config = { ...DEFAULT_OPTIONS, ...options };

  // Parse historical centroid vectors once, not once per (current × historical) pair
  const parsedHistorical = historicalTopics.map(h => ({
    ...h,
    _vector: vectorFromObject(h.centroidVector)
  }));

  const maxSources = Math.max(1, ...topics.map(topic => topic.uniqueSourceCount || 0));

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
    // Significance first: how many independent outlets cover the story (log-scaled against the
    // day's biggest story), then burst vs. its own history, then novelty.
    const significance = maxSources > 1
      ? Math.log1p(topic.uniqueSourceCount || 0) / Math.log1p(maxSources)
      : sourceDiversity;
    const finalScore = clamp(
      0.45 * significance
      + 0.25 * burst.normalized
      + 0.20 * noveltyScore
      + 0.10 * persistenceScore
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
        minTopicSize: config.minTopicSize,
        historicalSimilarityThreshold: config.historicalSimilarityThreshold
      })
    };
  });
}

export function classifyTopic(topic) {
  const historicalThreshold = topic.historicalSimilarityThreshold ?? DEFAULT_OPTIONS.historicalSimilarityThreshold;
  if (topic.maxHistoricalSimilarity >= historicalThreshold) {
    if (topic.burstZScore >= 2 || topic.burstScore >= 0.8) return 'trending';
    return 'ongoing';
  }
  if (topic.noveltyScore >= 0.70) return 'new';
  if (topic.burstZScore >= 2 || topic.burstScore >= 0.8) return 'trending';
  return 'monitor';
}

function createTopic(cluster, config) {
  const fullCentroid = averageVectors(cluster.map(document => document.vector));
  // Stored centroids keep only their strongest terms; the tail barely moves cosine similarity.
  const centroidVector = new Map([...fullCentroid.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, config.centroidTermCount));
  const ranked = cluster
    .map(document => ({ document, similarity: cosineSimilarity(document.vector, centroidVector) }))
    .sort((a, b) => b.similarity - a.similarity || b.document.articles.length - a.document.articles.length)
    .map(({ document }) => document);
  const articles = ranked.flatMap(document => document.articles);
  const labelKeywords = readableLabel(centroidVector, cluster, config.labelKeywordCount);
  const entities = unique(ranked.flatMap(document => extractEntities(document.article.title || ''))).slice(0, 12);
  // Centrality order, except that sampleHeadlines[0] (the topic's representative headline) is the
  // most central title that reads as a sentence; bare names like "Light Flip" score high on
  // centrality but say little.
  const titles = unique(ranked.map(document => document.article.title));
  const headlineIndex = Math.max(0, titles.findIndex(title => title.split(/\s+/).length >= 5));
  const sampleHeadlines = [titles[headlineIndex], ...titles.filter((_, index) => index !== headlineIndex)]
    .filter(Boolean)
    .slice(0, config.sampleHeadlineCount);

  return {
    id: createTopicId(articles, labelKeywords),
    date: null,
    headline: sampleHeadlines[0] || null,
    articleHashes: articles.map(article => String(article.url_hash)),
    articleCount: articles.length,
    uniqueSourceCount: unique(articles.map(article => article.feed_url || article.feed_title || 'unknown')).length,
    labelKeywords,
    entities,
    centroidVector,
    activeWindows: getActiveWindows(articles),
    sampleHeadlines,
    topSources: unique(articles.map(article => article.feed_title || article.feed_url || 'unknown')).slice(0, 5)
  };
}

// Top centroid unigrams rendered with their most common surface form ("gates", not "gat").
// The human-readable story name is `headline`; the label is just the keyword list.
function readableLabel(centroidVector, cluster, count) {
  const surfaceCounts = new Map();
  for (const document of cluster) {
    for (const [term, surface] of document.surfaces) {
      const counts = surfaceCounts.get(term) || new Map();
      counts.set(surface, (counts.get(surface) || 0) + document.articles.length);
      surfaceCounts.set(term, counts);
    }
  }
  return unique([...centroidVector.entries()]
    .filter(([term]) => !term.includes(' '))
    .sort((a, b) => b[1] - a[1])
    .slice(0, count)
    .map(([term]) => {
      const counts = surfaceCounts.get(term);
      return counts ? [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0] : term;
    }));
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
