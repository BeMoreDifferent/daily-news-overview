import http from 'node:http';
import https from 'node:https';
import Parser from 'rss-parser';
import { DEFAULT_FEED_TIMEOUT_MS } from '../config.js';
import { hash64 } from '../utils/hash.js';
import { normalizeUrl } from '../utils/urlNormalizer.js';

const httpAgent  = new http.Agent({ maxSockets: 10 });
const httpsAgent = new https.Agent({ maxSockets: 10 });

export function destroyAgents() {
  httpAgent.destroy();
  httpsAgent.destroy();
}

const parser = new Parser({
  customFields: {
    item: [
      ['content:encoded', 'content'],
      ['description', 'description'],
      ['dc:creator', 'author'],
      ['media:group', 'mediaGroup'],
      ['media:content', 'mediaContent'],
      ['media:description', 'mediaDescription'],
      ['media:thumbnail', 'mediaThumbnail'],
      ['media:title', 'mediaTitle'],
      ['enclosure', 'enclosure'],
      ['image', 'image'],
      ['og:image', 'ogImage'],
      ['category', 'category'],
      ['arxiv:primary_category', 'primaryCategory'],
      ['arxiv:categories', 'categories']
    ]
  }
});

function fetchXml(url, redirectCount = 0) {
  if (redirectCount > 5) {
    return Promise.reject(Object.assign(new Error('Too many redirects'), { code: 'EREDIRECT' }));
  }
  const isHttps = url.startsWith('https:');
  const lib = isHttps ? https : http;
  const agent = isHttps ? httpsAgent : httpAgent;

  return new Promise((resolve, reject) => {
    const req = lib.get(url, { agent, headers: { 'User-Agent': 'rss-feed-fetcher/2.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const redirectUrl = new URL(res.headers.location, url).href;
        fetchXml(redirectUrl, redirectCount + 1).then(resolve, reject);
        return;
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { code: `HTTP_${res.statusCode}` }));
        return;
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks).toString()));
      res.on('error', reject);
    });
    req.setTimeout(DEFAULT_FEED_TIMEOUT_MS, () => {
      req.destroy(Object.assign(new Error('Request timed out'), { code: 'ETIMEDOUT' }));
    });
    req.on('error', reject);
  });
}

export async function processFeed(feed, options = {}) {
  const startedAt = Date.now();
  const now = options.now || new Date();
  const fetchStartedAt = Date.now();
  const xml = await fetchXml(feed.url);
  const feedData = await parser.parseString(xml);
  const fetchParseMs = Date.now() - fetchStartedAt;
  const mapStartedAt = Date.now();
  const items = feedData.items.slice(0, feed.maxItems);
  const rows = items
    .map(item => mapFeedItemToArticleRow(item, feed, feedData, now))
    .filter(Boolean);
  const mapMs = Date.now() - mapStartedAt;

  return {
    feedUrl: feed.url,
    feedTitle: feedData.title || null,
    itemCount: feedData.items.length,
    candidateCount: rows.length,
    rows,
    durationMs: Date.now() - startedAt,
    timing: {
      fetchParseMs,
      mapMs,
      totalMs: Date.now() - startedAt
    }
  };
}

export function mapFeedItemToArticleRow(item, feed, feedData = {}, now = new Date()) {
  const rawUrl = item.link || item.guid || item.id;
  if (!rawUrl || !isValidUrl(rawUrl)) return null;

  const url = normalizeUrl(rawUrl);
  const title = cleanText(item.title);
  const summary = cleanText(
    item.contentSnippet
    || item.description
    || item.mediaDescription
    || item.mediaGroup?.['media:description']?.[0]
    || item.content
  );
  const publishedAt = parseDate(item.isoDate || item.pubDate || item.published || item.publishedAt);
  const tags = extractTags(item);

  return {
    url_hash: hash64(url),
    url,
    feed_url: feed.url,
    feed_title: cleanText(feedData.title),
    title,
    summary,
    image_url: extractImageUrl(item),
    author: cleanText(item.creator || item.author),
    published_at: publishedAt,
    fetched_at: now,
    source_type: feed.sourceType,
    tags,
    raw_fingerprint: hash64(`${title}|${summary}|${publishedAt?.toISOString() || ''}`)
  };
}

export function isRecentItem(item, now = new Date(), recentDays = 3) {
  const publishedAt = parseDate(item.isoDate || item.pubDate || item.published || item.publishedAt);
  if (!publishedAt) return true;
  const cutoff = new Date(now.getTime() - recentDays * 24 * 60 * 60 * 1000);
  return publishedAt >= cutoff;
}

function extractTags(item) {
  const values = [
    item.category,
    item.categories,
    item.primaryCategory
  ].flat(Infinity).filter(Boolean);

  return [...new Set(values
    .map(value => cleanText(extractTagValue(value))?.toLowerCase())
    .filter(Boolean))]
    .slice(0, 10);
}

function extractTagValue(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (!value || typeof value !== 'object') return null;
  return value._ || value.$?.term || value.$?.label || value.term || value.label || null;
}

function extractImageUrl(item) {
  const candidates = [
    item.mediaContent?.$?.url,
    item.mediaContent?.url,
    item.mediaThumbnail?.$?.url,
    item.mediaThumbnail?.url,
    item.mediaGroup?.['media:thumbnail']?.[0]?.$?.url,
    item.mediaGroup?.['media:thumbnail']?.[0]?.url,
    item.mediaGroup?.['media:content']?.[0]?.$?.url,
    item.mediaGroup?.['media:content']?.[0]?.url,
    item.enclosure?.$?.url,
    item.enclosure?.url,
    item.image?.$?.url,
    item.image?.url,
    item.ogImage?.$?.url,
    item.ogImage?.url,
    extractImageFromHtml(item.content),
    extractImageFromHtml(item.description)
  ];

  return candidates.find(candidate => candidate && isValidUrl(candidate)) || null;
}

function extractImageFromHtml(html) {
  if (!html) return null;
  const match = String(html).match(/<img[^>]+src=["']?([^"'\s>]+)/i)
    || String(html).match(/<meta[^>]+property=["']og:image["'][^>]+content=["']?([^"'\s>]+)/i);
  return match?.[1] || null;
}

function cleanText(value) {
  if (!value) return null;
  return String(value)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, '\'')
    .replace(/\s+/g, ' ')
    .trim() || null;
}

function parseDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isValidUrl(url) {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}
