// Story sections for the daily export. The model assigns them when summaries are enabled; this
// module is the always-available fallback: a vote of the topic's specialist feeds (feed
// `category` in data/rss_feeds.json). General outlets are neutral, so a story only leaves "world"
// when specialist outlets make up a real share of its sources.

import { promises as fs } from 'fs';
import path from 'path';

export const SECTIONS = ['world', 'politics', 'business', 'technology', 'science-health', 'sports', 'culture'];

const CATEGORY_SECTIONS = {
  technology: [
    'ai', 'tech', 'cybersecurity', 'websecurity', 'pwn', 'redteam', 'reverse', 'mobilesecurity',
    'iotsecurity', 'wirelesssecurity', 'programming', 'dev', 'web-development', 'android',
    'android-development', 'ios-development', 'apple', 'machinelearning', 'ui-ux', 'tech-video'
  ],
  business: [
    'business', 'business-and-economy', 'business-economy', 'crypto', 'personal-finance', 'startups',
    'business-video', 'masters-of-scale-with-reid-hoffman', 'how-i-built-this-with-guy-raz'
  ],
  'science-health': ['science', 'space', 'research'],
  sports: ['sports', 'football', 'tennis', 'cricket', 'cricket-unfiltered', 'the-analyst-inside-cricket'],
  culture: [
    'movies', 'music', 'television', 'books', 'gaming', 'culture', 'fashion', 'beauty', 'food',
    'gastropod', 'travel', 'photography', 'architecture', 'interior-design', 'lifestyle', 'funny', 'diy'
  ],
  politics: ['politics']
};

const SECTION_BY_CATEGORY = new Map(Object.entries(CATEGORY_SECTIONS)
  .flatMap(([section, categories]) => categories.map(category => [category, section])));

const MIN_SPECIALIST_SHARE = 0.3;

export function isSection(value) {
  return SECTIONS.includes(value);
}

export function sectionForCategory(category) {
  return SECTION_BY_CATEGORY.get(String(category || '').toLowerCase()) || null;
}

let cache = null;

// Map<feed url, section> for every feed with a specialist category.
export async function loadFeedSections(filePath = path.join('data', 'rss_feeds.json')) {
  try {
    const { mtimeMs } = await fs.stat(filePath);
    if (cache?.filePath === filePath && cache.mtimeMs === mtimeMs) return cache.sections;
    const entries = JSON.parse(await fs.readFile(filePath, 'utf8'));
    const sections = new Map();
    for (const entry of Array.isArray(entries) ? entries : []) {
      const section = typeof entry === 'object' ? sectionForCategory(entry.category) : null;
      if (section && entry.url) sections.set(entry.url.trim(), section);
    }
    cache = { filePath, mtimeMs, sections };
    return sections;
  } catch {
    return new Map();
  }
}

// rows: the topic's articles ({ feed_url }). Each distinct feed votes once.
export function sectionFromSources(rows, feedSections) {
  const feeds = [...new Set(rows.map(row => row.feed_url).filter(Boolean))];
  if (!feeds.length) return 'world';
  const votes = new Map();
  for (const feed of feeds) {
    const section = feedSections.get(feed);
    if (section) votes.set(section, (votes.get(section) || 0) + 1);
  }
  const [best] = [...votes.entries()].sort((a, b) => b[1] - a[1] || SECTIONS.indexOf(a[0]) - SECTIONS.indexOf(b[0]));
  return best && best[1] / feeds.length >= MIN_SPECIALIST_SHARE ? best[0] : 'world';
}
