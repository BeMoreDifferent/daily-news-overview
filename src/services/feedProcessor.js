import http from 'node:http';
import https from 'node:https';
import Parser from 'rss-parser';
import { DEFAULT_FEED_TIMEOUT_MS, DEFAULT_FEED_DEADLINE_MS } from '../config.js';
import { hash64 } from '../utils/hash.js';
import { normalizeUrl } from '../utils/urlNormalizer.js';

const httpAgent  = new http.Agent({ maxSockets: 10, keepAlive: false });
const httpsAgent = new https.Agent({ maxSockets: 10, keepAlive: false });

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

// Retry once on transient network errors before failing a feed.
async function fetchXml(url, redirectCount = 0) {
  try {
    return await fetchXmlOnce(url, redirectCount);
  } catch (err) {
    if (['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ECONNABORTED'].includes(err.code)) {
      await new Promise(r => setTimeout(r, 200 + Math.random() * 100));
      return fetchXmlOnce(url, redirectCount);
    }
    throw err;
  }
}

function fetchXmlOnce(url, redirectCount) {
  if (redirectCount > 5) {
    return Promise.reject(Object.assign(new Error('Too many redirects'), { code: 'EREDIRECT' }));
  }
  const isHttps = url.startsWith('https:');
  const lib = isHttps ? https : http;
  const agent = isHttps ? httpsAgent : httpAgent;

  return new Promise((resolve, reject) => {
    let settled = false;

    const settle = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      if (err) {
        if (req && !req.destroyed) req.destroy();
        reject(err);
      } else {
        resolve(value);
      }
    };

    const deadlineTimer = setTimeout(() => {
      settle(Object.assign(new Error('Request timed out'), { code: 'ETIMEDOUT' }));
    }, DEFAULT_FEED_TIMEOUT_MS);

    const req = lib.get(url, { agent, headers: { 'User-Agent': 'rss-feed-fetcher/2.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        // Mark settled before recursing so this socket's close/error cannot interfere.
        settled = true;
        clearTimeout(deadlineTimer);
        const redirectUrl = new URL(res.headers.location, url).href;
        fetchXml(redirectUrl, redirectCount + 1).then(resolve, reject);
        return;
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        settle(Object.assign(new Error(`HTTP ${res.statusCode}`), { code: `HTTP_${res.statusCode}` }));
        return;
      }
      const rawChunks = [];
      let received = 0;
      const MAX_BYTES = 5 * 1024 * 1024;
      res.on('data', chunk => {
        received += chunk.length;
        if (received > MAX_BYTES) {
          settle(Object.assign(new Error('Response too large'), { code: 'EFBIG' }));
          return;
        }
        rawChunks.push(chunk);
      });
      res.on('end', () => {
        const raw = Buffer.concat(rawChunks);
        // Detect encoding: prefer XML declaration, fall back to Content-Type header.
        // Sniff first 400 bytes as ASCII to read the <?xml ...?> prolog.
        const prolog = raw.slice(0, 400).toString('ascii');
        const xmlEncMatch = prolog.match(/encoding=["']([^"']+)["']/i);
        let charset = 'utf-8';
        if (xmlEncMatch) {
          charset = xmlEncMatch[1].toLowerCase();
        } else {
          const ct = res.headers['content-type'] || '';
          const ctMatch = ct.match(/charset=([^\s;]+)/i);
          if (ctMatch) charset = ctMatch[1].toLowerCase();
        }
        // Normalise latin-1 alias — browsers/servers often declare iso-8859-1
        // but serve windows-1252 (a superset). TextDecoder accepts both names.
        let text;
        try {
          text = new TextDecoder(charset, { fatal: true }).decode(raw);
        } catch {
          // Fallback: re-decode as windows-1252 (covers latin-1 and most 8-bit feeds)
          try {
            text = new TextDecoder('windows-1252', { fatal: false }).decode(raw);
          } catch {
            text = raw.toString('utf8');
          }
        }
        settle(null, text);
      });
      res.on('error', err => settle(err));
    });
    req.on('error', err => settle(err));
  });
}

export async function processFeed(feed) {
  const startedAt = Date.now();
  const now = new Date();
  const fetchStartedAt = Date.now();
  let deadlineTimer;
  const deadline = new Promise((_, reject) => {
    deadlineTimer = setTimeout(
      () => reject(Object.assign(new Error('Feed deadline exceeded'), { code: 'ETIMEDOUT' })),
      DEFAULT_FEED_DEADLINE_MS
    );
  });
  let xml, feedData;
  try {
    xml = await Promise.race([fetchXml(feed.url), deadline]);
    feedData = await Promise.race([parser.parseString(xml), deadline]);
  } finally {
    clearTimeout(deadlineTimer);
  }
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
  const rawSummary = item.contentSnippet
    || item.description
    || item.mediaDescription
    || item.mediaGroup?.['media:description']?.[0]
    || item.content;
  const summary = rawSummary
    ? cleanText(String(rawSummary).slice(0, 2000))?.slice(0, 500) ?? null
    : null;
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
    tags
  };
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
  const quick = item.mediaContent?.$?.url
    || item.mediaContent?.url
    || item.mediaThumbnail?.$?.url
    || item.mediaThumbnail?.url
    || item.mediaGroup?.['media:thumbnail']?.[0]?.$?.url
    || item.mediaGroup?.['media:thumbnail']?.[0]?.url
    || item.mediaGroup?.['media:content']?.[0]?.$?.url
    || item.mediaGroup?.['media:content']?.[0]?.url
    || item.enclosure?.$?.url
    || item.enclosure?.url
    || item.image?.$?.url
    || item.image?.url
    || item.ogImage?.$?.url
    || item.ogImage?.url;
  if (quick && isValidUrl(quick)) return quick;
  return extractImageFromHtml(item.content) || extractImageFromHtml(item.description) || null;
}

function extractImageFromHtml(html) {
  if (!html) return null;
  const match = String(html).match(/<img[^>]+src=["']?([^"'\s>]+)/i)
    || String(html).match(/<meta[^>]+property=["']og:image["'][^>]+content=["']?([^"'\s>]+)/i);
  return match?.[1] || null;
}

const ENTITY_RE = /&(?:nbsp|amp|quot|#39);|\s+/g;
const ENTITY_MAP = { '&nbsp;': ' ', '&amp;': '&', '&quot;': '"', '&#39;': '\'' };

function cleanText(value) {
  if (!value) return null;
  const s = String(value)
    .replace(/<(?:script|style)[\s\S]*?<\/(?:script|style)>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(ENTITY_RE, m => ENTITY_MAP[m] ?? ' ')
    .trim();
  return s || null;
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
