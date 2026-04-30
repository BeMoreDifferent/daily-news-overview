#!/usr/bin/env node
/**
 * One-shot script to bulk-expand data/rss_feeds.json from curated OPML directories.
 * Migrates entries to object form {url, category, language, source, name?},
 * validates liveness, dedupes, and atomically rewrites the file with a backup.
 *
 * Usage: node scripts/expandFeeds.js [--dry-run] [--keep-existing] [--source <name>] ...
 * Run with --help for full options.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const FEEDS_PATH = path.join(ROOT, 'data', 'rss_feeds.json');
const BACKUPS_DIR = path.join(ROOT, 'data', 'backups');

// === ARGS ===

function parseArgs(argv) {
  const args = {
    dryRun: false,
    keepExisting: false,
    onlyValidate: false,
    maxFeeds: Infinity,
    sources: [],
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--keep-existing' || arg === '--no-validate-existing') args.keepExisting = true;
    else if (arg === '--only-validate') args.onlyValidate = true;
    else if (arg === '--max-feeds') args.maxFeeds = parseInt(argv[++i], 10);
    else if (arg === '--source') args.sources.push(argv[++i]);
    else if (arg === '--help') args.help = true;
  }
  return args;
}

// === CONCURRENT MAPPER (same pattern as src/dryRun.js) ===

async function mapConcurrent(items, concurrency, mapper) {
  const results = new Array(items.length);
  let index = 0;
  async function worker() {
    while (index < items.length) {
      const i = index++;
      results[i] = await mapper(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

// === FETCH UTILITIES ===

const FETCH_HEADERS = {
  'User-Agent': 'rss-feed-fetcher/1.0',
  'Accept': 'application/rss+xml,application/atom+xml,application/xml;q=0.9,text/xml;q=0.8,*/*;q=0.5',
};

/** Fetch full text (for OPML/markdown downloads). */
async function fetchText(url, { timeoutMs = 15000 } = {}) {
  try {
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
      headers: FETCH_HEADERS,
    });
    const body = await resp.text();
    return { ok: resp.ok, status: resp.status, contentType: resp.headers.get('content-type') || '', body };
  } catch (err) {
    return { ok: false, error: err.name === 'TimeoutError' ? 'timeout' : `network: ${err.message}` };
  }
}

/** Fetch first maxBytes of body (for RSS liveness probing). */
async function fetchHead(url, { timeoutMs = 8000, maxBytes = 4096 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: FETCH_HEADERS,
    });
    const contentType = resp.headers.get('content-type') || '';
    if (!resp.ok) {
      clearTimeout(timer);
      resp.body?.cancel().catch(() => {});
      return { ok: false, status: resp.status, contentType, body: '' };
    }
    const reader = resp.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (total < maxBytes) {
        const { done, value } = await reader.read();
        if (done || !value) break;
        chunks.push(value);
        total += value.length;
      }
    } finally {
      reader.cancel().catch(() => {});
    }
    clearTimeout(timer);
    const buf = new Uint8Array(Math.min(total, maxBytes));
    let off = 0;
    for (const chunk of chunks) {
      const n = Math.min(chunk.length, maxBytes - off);
      buf.set(chunk.subarray(0, n), off);
      off += n;
      if (off >= maxBytes) break;
    }
    const body = new TextDecoder('utf-8', { fatal: false }).decode(buf);
    return { ok: true, status: resp.status, contentType, body };
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, error: err.name === 'AbortError' ? 'timeout' : `network: ${err.message}` };
  }
}

// === GITHUB API ===

async function listGithubDir(repoSlug, dirPath) {
  const url = `https://api.github.com/repos/${repoSlug}/contents/${dirPath}`;
  const headers = {
    'User-Agent': 'rss-feed-fetcher/1.0',
    'Accept': 'application/vnd.github.v3+json',
  };
  if (process.env.GITHUB_TOKEN) headers['Authorization'] = `Bearer ${process.env.GITHUB_TOKEN}`;
  try {
    const resp = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
    if (!resp.ok) {
      const remaining = resp.headers.get('X-RateLimit-Remaining');
      if (remaining === '0') {
        console.warn(`  [github] Rate limit hit. Set GITHUB_TOKEN env var for 5000 req/hr.`);
      } else {
        console.warn(`  [github] ${resp.status} for ${url}`);
      }
      return [];
    }
    const data = await resp.json();
    return Array.isArray(data)
      ? data.filter(f => f.type === 'file' && f.name.endsWith('.opml')).map(f => ({ name: f.name, download_url: f.download_url }))
      : [];
  } catch (err) {
    console.warn(`  [github] Failed ${url}: ${err.message}`);
    return [];
  }
}

// === PARSERS ===

function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x([0-9a-fA-F]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)));
}

/**
 * Extract feed entries from OPML XML.
 * Uses a simple linear regex scan; tracks the last seen category-folder outline
 * as a fallback category for subsequent feed outlines.
 */
function extractOpmlFeeds(xml, { category: defaultCategory, language, source }) {
  const results = [];
  const outlineRx = /<outline\b([^>]*?)(?:\/?>)/gi;
  const attrRx = /(\w+)=(["'])([^"']*)\2/g;
  let currentCategory = defaultCategory;

  let m;
  while ((m = outlineRx.exec(xml)) !== null) {
    const attrs = {};
    attrRx.lastIndex = 0;
    let am;
    while ((am = attrRx.exec(m[1])) !== null) {
      attrs[am[1].toLowerCase()] = decodeHtmlEntities(am[3]);
    }
    const xmlUrl = attrs.xmlurl;
    const label = attrs.text || attrs.title || '';

    if (xmlUrl) {
      results.push({
        url: xmlUrl,
        name: label || undefined,
        category: currentCategory,
        language,
        source,
      });
    } else if (label && !attrs.type?.startsWith('rss')) {
      // Folder/category outline — update context for subsequent feeds
      currentCategory = label.toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9-]/g, '')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
    }
  }
  return results;
}

/** Extract likely RSS/Atom URLs from Markdown text. */
function extractMarkdownFeedUrls(md, { category, language, source }) {
  const urlRx = /https?:\/\/[^\s)<>"'`\]\\]+/g;
  const feedRx = /\/(feed|rss|atom)(\/|\.xml|\.atom|\.rss)?$|\/(?:feed|atom|rss)\.xml$|\.rss$|\.atom$/i;
  const results = [];
  const seen = new Set();
  let m;
  while ((m = urlRx.exec(md)) !== null) {
    const url = m[0].replace(/[.,;!?]+$/, '');
    if (feedRx.test(url) && !seen.has(url)) {
      seen.add(url);
      results.push({ url, category, language, source });
    }
  }
  return results;
}

/** Recursively walk a JSON structure looking for feedUrl / feed_url keys. */
function extractJsonFeedUrls(jsonStr, { category, language, source }) {
  const results = [];
  let data;
  try { data = JSON.parse(jsonStr); } catch { return results; }
  function walk(obj) {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) { obj.forEach(walk); return; }
    for (const [k, v] of Object.entries(obj)) {
      if (/^(feed_?url|rss_?url)$/i.test(k) && typeof v === 'string' && v.startsWith('http')) {
        results.push({ url: v, category, language, source });
      } else {
        walk(v);
      }
    }
  }
  walk(data);
  return results;
}

// === CATEGORY INFERENCE (for existing entries) ===

const CATEGORY_RULES = [
  [/youtube\.com\/feeds\/videos\.xml/, 'youtube', 'en'],
  [/arxiv\.org\/rss/, 'research', 'en'],
  [/trends\.google\.com/, 'social-trends', 'en'],
  // Country-specific
  [/(spiegel|newsfeed\.zeit|tagesschau|\.faz\.|\.n-tv\.|freitag\.de|morgenpost|sueddeutsche|welt\.de|tagesspiegel|handelsblatt)/, 'germany', 'de'],
  [/(lemonde|lefigaro|liberation|france24\.com|rfi\.fr|mediapart|nouvelobs|francetvinfo|huffingtonpost\.fr|ladepeche|sudouest|ouest-france|20minutes\.fr|parisstaronline)/, 'france', 'fr'],
  [/(elpais|elmundo|elconfidencial|eldiario|e00-expansion|elperiodico\.com|euroweeklynews)/, 'spain', 'es'],
  [/(corriere|repubblica|ansa\.it|ilfattoquotidiano|lastampa)/, 'italy', 'it'],
  [/(asahi|mainichi|nhk\.or|japantimes)\.(jp|co\.jp|com)/, 'japan', 'ja'],
  [/(globo\.com|folha\.uol|estadao\.com|brasilwire|riotimesonline|jornaldebrasilia|uol\.com\.br)/, 'brazil', 'pt'],
  [/(thedailystar\.net|bd24live|jagonews24|prothomalo)/, 'bangladesh', 'bn'],
  [/(hongkongfp|hongkongnews\.net)/, 'hong-kong', 'en'],
  [/(thejournal\.ie|breakingnews\.ie|irishmirror\.ie|feedburner.*irish|the42\.ie|irishcentral)/, 'ireland', 'en'],
  [/(smh\.com\.au|abc\.net\.au|theage\.com\.au|perthnow|canberratimes|brisbanetimes|michaelwest\.com\.au|businessnews\.com\.au|independentaustralia)/, 'australia', 'en'],
  [/(globalnews\.ca|nationalpost|ottawacitizen|theprovince|lapresse\.ca|torontosun|financialpost|business\.financialpost)/, 'canada', 'en'],
  [/(republika\.co\.id)/, 'indonesia', 'id'],
  [/(scmp\.com)/, 'asia', 'en'],
  // Topics
  [/(bbc\.co\.uk|bbci\.co\.uk|theguardian\.com|skynews|independent\.co\.uk|telegraph\.co\.uk|\.ft\.com|thetimes|dailymail|thesun\.co\.uk)/, 'world-news', 'en'],
  [/(cnn\.com|nytimes\.com|nypost\.com|nbcnews|foxnews|abcnews\.go|cbsnews|npr\.org|washingtonpost|wsj\.com|usatoday|apnews|aljazeera|reuters\.com)/, 'world-news', 'en'],
  [/(politico\.com|axios\.com|bloomberg\.com|huffpost\.com|vox\.com|time\.com|rawstory|seattletimes|247newsaroundtheworld|worldnewsera|newsblaze)/, 'world-news', 'en'],
  [/(dw\.com|euronews|euractiv|euobserver|politico\.eu|ecfr\.eu|opendemocracy|eurozine|europeelects|thelocal\.)/, 'europe', 'en'],
  [/(techcrunch|theverge|wired\.|arstechnica|engadget|hackaday|theregister|techworld|macworld|pcworld|howtogeek|lifehacker|makeuseof|readwrite|venturebeat|technologyreview|smashingmagazine)/, 'tech', 'en'],
  [/(openai\.com|anthropic\.com|deepmind|huggingface\.co|artificialintelligence-news|thegradient\.pub)/, 'ai', 'en'],
  [/(krebsonsecurity|schneier\.com|bleepingcomputer|threatpost|darkreading|thecipherbrief)/, 'cybersecurity', 'en'],
  [/(espn\.com|skysports|bbcsport|cbssports|sportingnews|talksport|operationsports)/, 'sports', 'en'],
  [/(nature\.com|science\.org|newscientist|scientificamerican|sciencedaily|statnews|carbonbrief)/, 'science', 'en'],
  [/(economist\.com|forbes\.com|cnbc\.com|marketwatch|businessinsider|fortune\.com|entrepreneur\.com|sbnonline|homebusinessmag|thenonprofittimes)/, 'business', 'en'],
  [/(gamespot|nintendolife|indiegames|polygon\.com|gameinformer|news\.xbox|vg247|mynintendonews|rockpapershotgun|pcgamesn|kotaku|pushsquare|videogamer|toucharcade|gameinformer)/, 'gaming', 'en'],
  [/(rollingstone|variety\.com|artnews|artnet|lithub|newyorker\.com|salon\.com|vice\.com)/, 'culture', 'en'],
  [/(space\.com|esa\.int)/, 'space', 'en'],
  [/(propublica|theintercept|bellingcat|warontherocks|rand\.org|foreignpolicy|globalissues|e-ir\.info|justworldnews|defence-blog|wan-ifra)/, 'analysis', 'en'],
  [/(coindesk|decrypt\.co|cointelegraph)/, 'crypto', 'en'],
  [/(seriouseats|bonappetit|eater\.com)/, 'food', 'en'],
  [/(insidehighered|adventurouskate|adventure-journal)/, 'lifestyle', 'en'],
  [/(thenation|dailysignal|msnbc|washingtonexaminer|politico\.com)/, 'politics', 'en'],
  [/(kulturlotse|ooh\.directory|eurozine|stratechery|beehiiv)/, 'culture', 'en'],
];

function inferCategoryAndLanguage(url, fallback = {}) {
  const lower = url.toLowerCase();
  for (const [rx, category, language] of CATEGORY_RULES) {
    if (rx.test(lower)) return { category, language };
  }
  return { category: fallback.category || 'general', language: fallback.language || 'en' };
}

// === URL CANONICALIZATION ===

function canonicalizeUrl(urlStr) {
  let u;
  try { u = new URL(String(urlStr).trim()); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!u.hostname) return null;
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
  u.hash = '';
  const drop = new Set(['fbclid', 'gclid', 'mc_cid', 'mc_eid', 'ref', 'ref_src']);
  for (const key of [...u.searchParams.keys()]) {
    if (/^utm_/i.test(key) || drop.has(key)) u.searchParams.delete(key);
  }
  u.searchParams.sort();
  if (u.pathname !== '/' && u.pathname.endsWith('/')) u.pathname = u.pathname.slice(0, -1);
  return u.toString();
}

// === DEDUPLICATION ===

function dedupe(entries) {
  const map = new Map();
  for (const entry of entries) {
    const key = canonicalizeUrl(entry.url);
    if (!key) continue;
    if (map.has(key)) {
      const ex = map.get(key);
      if (!ex.name && entry.name) ex.name = entry.name;
    } else {
      map.set(key, { ...entry });
    }
  }
  return [...map.values()];
}

// === LIVENESS VALIDATION ===

const RSS_CT_RX = /application\/(rss|atom|rdf)\+xml|application\/xml|text\/xml/i;
const RSS_BODY_RX = /<(rss|feed|rdf:rdf|channel)[\s>]/i;

async function validateAlive(url) {
  const result = await fetchHead(url, { timeoutMs: 8000, maxBytes: 4096 });
  if (!result.ok) {
    const reason = result.error || `http-${result.status}`;
    return { alive: false, reason };
  }
  if (RSS_CT_RX.test(result.contentType) || RSS_BODY_RX.test(result.body)) {
    return { alive: true };
  }
  return { alive: false, reason: 'not-feed-like' };
}

// === DISCOVERERS ===

const PLENARY_LANGUAGE_MAP = {
  'arabic-world': 'ar', bangladesh: 'bn', brazil: 'pt', chile: 'es',
  china: 'zh', denmark: 'da', finland: 'fi', france: 'fr',
  germany: 'de', greece: 'el', hungary: 'hu', indonesia: 'id',
  israel: 'he', italy: 'it', japan: 'ja', mexico: 'es',
  netherlands: 'nl', norway: 'no', pakistan: 'ur', poland: 'pl',
  portugal: 'pt', russia: 'ru', 'south-korea': 'ko', spain: 'es',
  sweden: 'sv', turkey: 'tr', ukraine: 'uk', vietnam: 'vi',
};

async function discoverStarter() {
  return [
    { url: 'https://feeds.bbci.co.uk/news/world/rss.xml', category: 'world-news', language: 'en', source: 'starter', name: 'BBC World' },
    { url: 'https://apnews.com/hub/apf-topnews?format=rss', category: 'world-news', language: 'en', source: 'starter', name: 'AP Top News' },
    { url: 'https://apnews.com/hub/world-news?format=rss', category: 'world-news', language: 'en', source: 'starter', name: 'AP World News' },
    { url: 'https://www.theguardian.com/world/rss', category: 'world-news', language: 'en', source: 'starter', name: 'The Guardian World' },
    { url: 'https://www.aljazeera.com/xml/rss/all.xml', category: 'world-news', language: 'en', source: 'starter', name: 'Al Jazeera English' },
    { url: 'https://rss.dw.com/rdf/rss-en-all', category: 'world-news', language: 'en', source: 'starter', name: 'Deutsche Welle English' },
    { url: 'https://www.france24.com/en/rss', category: 'world-news', language: 'en', source: 'starter', name: 'France 24 English' },
    { url: 'http://feeds.skynews.com/feeds/rss/world.xml', category: 'world-news', language: 'en', source: 'starter', name: 'Sky News World' },
    { url: 'https://feeds.npr.org/1004/rss.xml', category: 'world-news', language: 'en', source: 'starter', name: 'NPR World' },
    { url: 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml', category: 'world-news', language: 'en', source: 'starter', name: 'New York Times World' },
    { url: 'https://www.lemonde.fr/en/international/rss_full.xml', category: 'france', language: 'en', source: 'starter', name: 'Le Monde International (EN)' },
  ];
}

async function discoverPlenary() {
  const results = [];

  const catFiles = await listGithubDir('plenaryapp/awesome-rss-feeds', 'recommended/with_category');
  console.log(`    fetching ${catFiles.length} category OPMLs`);
  const catResults = await mapConcurrent(catFiles, 8, async file => {
    const cat = file.name.replace('.opml', '').toLowerCase().replace(/\s+/g, '-');
    const r = await fetchText(file.download_url);
    return r.ok ? extractOpmlFeeds(r.body, { category: cat, language: 'en', source: `plenary:${cat}` }) : [];
  });
  results.push(...catResults.flat());

  // Country OPMLs live in countries/with_category/ and countries/without_category/
  for (const subdir of ['countries/with_category', 'countries/without_category']) {
    const countryFiles = await listGithubDir('plenaryapp/awesome-rss-feeds', subdir);
    console.log(`    fetching ${countryFiles.length} country OPMLs from ${subdir}`);
    const countryResults = await mapConcurrent(countryFiles, 8, async file => {
      const country = file.name.replace('.opml', '').toLowerCase().replace(/\s+/g, '-');
      const lang = PLENARY_LANGUAGE_MAP[country] || 'en';
      const r = await fetchText(file.download_url);
      return r.ok ? extractOpmlFeeds(r.body, { category: country, language: lang, source: `plenary:countries/${country}` }) : [];
    });
    results.push(...countryResults.flat());
  }

  return results;
}

async function discoverMartinviv() {
  const results = [];
  // Martinviv organizes OPMLs in recommended/ and countries/ subdirectories
  for (const subdir of ['recommended', 'countries']) {
    const files = await listGithubDir('Martinviv/rss-sources', subdir);
    const feedLists = await mapConcurrent(files, 6, async file => {
      const cat = file.name.replace('.opml', '').toLowerCase().replace(/\s+/g, '-');
      const r = await fetchText(file.download_url);
      return r.ok ? extractOpmlFeeds(r.body, { category: cat, language: 'en', source: `martinviv:${cat}` }) : [];
    });
    results.push(...feedLists.flat());
  }
  return results;
}

async function discoverScripting() {
  const url = 'https://raw.githubusercontent.com/scripting/feedsForJournalists/master/list.opml';
  const r = await fetchText(url);
  return r.ok ? extractOpmlFeeds(r.body, { category: 'journalism', language: 'en', source: 'scripting' }) : [];
}

async function discoverCyberSecurityRSS() {
  const url = 'https://raw.githubusercontent.com/zer0yu/CyberSecurityRSS/master/CyberSecurityRSS.opml';
  const r = await fetchText(url);
  return r.ok ? extractOpmlFeeds(r.body, { category: 'cybersecurity', language: 'en', source: 'cybersecurity-rss' }) : [];
}

async function discoverRansomfeed() {
  // Look for any OPML in the ransomfeed/cyber-news repo root
  const files = await listGithubDir('ransomfeed/cyber-news', '');
  if (!files.length) {
    // Fallback: known OPML path
    const r = await fetchText('https://raw.githubusercontent.com/ransomfeed/cyber-news/main/feeds.opml');
    return r.ok ? extractOpmlFeeds(r.body, { category: 'cybersecurity', language: 'en', source: 'ransomfeed' }) : [];
  }
  const feedLists = await mapConcurrent(files, 5, async file => {
    const r = await fetchText(file.download_url);
    return r.ok ? extractOpmlFeeds(r.body, { category: 'cybersecurity', language: 'en', source: 'ransomfeed' }) : [];
  });
  return feedLists.flat();
}

async function discoverAllInfosec() {
  // Repo has an OPML file, not sources.json
  const url = 'https://raw.githubusercontent.com/foorilla/allinfosecnews_sources/main/allinfosecnews_sources.opml';
  const r = await fetchText(url);
  return r.ok ? extractOpmlFeeds(r.body, { category: 'cybersecurity', language: 'en', source: 'allinfosecnews' }) : [];
}

async function discoverAwesomeTechRss() {
  const url = 'https://raw.githubusercontent.com/tuan3w/awesome-tech-rss/master/README.md';
  const r = await fetchText(url);
  return r.ok ? extractMarkdownFeedUrls(r.body, { category: 'tech', language: 'en', source: 'awesome-tech-rss' }) : [];
}

const DISCOVERERS = {
  starter: discoverStarter,
  plenary: discoverPlenary,
  martinviv: discoverMartinviv,
  scripting: discoverScripting,
  cybersecurity: discoverCyberSecurityRSS,
  ransomfeed: discoverRansomfeed,
  allinfosec: discoverAllInfosec,
  'awesome-tech-rss': discoverAwesomeTechRss,
};

// === ATOMIC WRITE ===

async function writeAtomic(filePath, content) {
  const tmp = filePath + '.tmp';
  await fs.writeFile(tmp, content, 'utf8');
  await fs.rename(tmp, filePath);
}

// === MAIN ===

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(`Usage: node scripts/expandFeeds.js [options]

Options:
  --dry-run             Compute but don't write files
  --keep-existing       Skip re-validating existing entries (just migrate + append new)
  --only-validate       Re-validate existing entries only, drop dead, write back
  --max-feeds N         Cap total final entry count
  --source <name>       Only run named discoverer (repeatable)
                        Sources: ${Object.keys(DISCOVERERS).join(', ')}
  --help                Show this help

Environment:
  GITHUB_TOKEN          GitHub PAT for 5000 req/hr (vs 60 unauthenticated)`);
    return;
  }

  // ── Load existing feeds ──────────────────────────────────────────────────────
  const existingRaw = JSON.parse(await fs.readFile(FEEDS_PATH, 'utf8'));
  const existingEntries = existingRaw.map(entry => {
    if (typeof entry === 'string') {
      const { category, language } = inferCategoryAndLanguage(entry);
      return { url: entry, category, language, source: 'manual' };
    }
    const inferred = inferCategoryAndLanguage(entry.url, { category: entry.category, language: entry.language });
    return {
      ...entry,
      category: entry.category || inferred.category,
      language: entry.language || inferred.language,
      source: entry.source || 'manual',
    };
  });
  console.log(`Existing entries: ${existingEntries.length}`);

  // ── Discovery ────────────────────────────────────────────────────────────────
  let discovered = [];
  if (!args.onlyValidate) {
    const sourcesToRun = args.sources.length > 0
      ? args.sources.filter(s => s in DISCOVERERS)
      : Object.keys(DISCOVERERS);

    console.log(`\nRunning ${sourcesToRun.length} discoverer(s): ${sourcesToRun.join(', ')}`);
    for (const name of sourcesToRun) {
      console.log(`  [${name}]`);
      try {
        const feeds = await DISCOVERERS[name]();
        console.log(`    → ${feeds.length} feeds`);
        discovered.push(...feeds);
      } catch (err) {
        console.warn(`    ERROR: ${err.message}`);
      }
    }
    console.log(`\nDiscovered (raw): ${discovered.length}`);
  }

  // ── Canonicalize & dedupe ────────────────────────────────────────────────────
  const canonExisting = dedupe(existingEntries);
  const existingKeys = new Set(canonExisting.map(e => canonicalizeUrl(e.url)).filter(Boolean));

  const canonDiscovered = dedupe(discovered);
  console.log(`After canonicalize+dedupe discovered: ${canonDiscovered.length}`);

  const brandNew = canonDiscovered.filter(e => {
    const k = canonicalizeUrl(e.url);
    return k && !existingKeys.has(k);
  });
  console.log(`Genuinely new (not in existing):      ${brandNew.length}`);

  // ── Validate existing ────────────────────────────────────────────────────────
  let keptExisting = [];
  let droppedExisting = [];

  if (args.keepExisting) {
    keptExisting = canonExisting;
    console.log(`\nSkipping existing validation (--keep-existing): ${keptExisting.length} kept`);
  } else {
    console.log(`\nValidating ${canonExisting.length} existing feeds (concurrency=25)...`);
    const existingResults = await mapConcurrent(canonExisting, 25, async (entry, i) => {
      if ((i + 1) % 50 === 0) process.stdout.write(`  ${i + 1}/${canonExisting.length}...\n`);
      const { alive, reason } = await validateAlive(entry.url);
      return { entry, alive, reason };
    });
    keptExisting = existingResults.filter(r => r.alive).map(r => r.entry);
    droppedExisting = existingResults.filter(r => !r.alive);
    console.log(`  Kept: ${keptExisting.length}, Dropped: ${droppedExisting.length}`);
  }

  // ── Validate new ─────────────────────────────────────────────────────────────
  let newToValidate = brandNew;
  if (Number.isFinite(args.maxFeeds)) {
    const cap = Math.max(0, args.maxFeeds - keptExisting.length);
    if (newToValidate.length > cap) {
      newToValidate = brandNew.slice(0, cap);
      console.log(`Capped new candidates to ${newToValidate.length} (--max-feeds ${args.maxFeeds})`);
    }
  }

  let keptNew = [];
  let droppedNew = [];

  if (!args.onlyValidate && newToValidate.length > 0) {
    console.log(`\nValidating ${newToValidate.length} new feeds (concurrency=25)...`);
    const newResults = await mapConcurrent(newToValidate, 25, async (entry, i) => {
      if ((i + 1) % 100 === 0) process.stdout.write(`  ${i + 1}/${newToValidate.length}...\n`);
      const { alive, reason } = await validateAlive(entry.url);
      return { entry, alive, reason };
    });
    keptNew = newResults.filter(r => r.alive).map(r => r.entry);
    droppedNew = newResults.filter(r => !r.alive);
    const timeouts = droppedNew.filter(r => r.reason === 'timeout').length;
    console.log(`  Alive: ${keptNew.length}, Dead: ${droppedNew.length - timeouts} + ${timeouts} timeouts`);
  }

  // ── Merge & sort ─────────────────────────────────────────────────────────────
  const allFinal = [...keptExisting, ...keptNew];
  allFinal.sort((a, b) => {
    const c = (a.category || '').localeCompare(b.category || '');
    return c !== 0 ? c : a.url.localeCompare(b.url);
  });

  // ── Summary ──────────────────────────────────────────────────────────────────
  console.log('\n=== Feed Expansion Summary ===');
  console.log(`Sources scanned:         ${Object.keys(DISCOVERERS).length}`);
  console.log(`Discovered (raw):        ${discovered.length}`);
  console.log(`After dedupe discovered: ${canonDiscovered.length}`);
  console.log(`Genuinely new:           ${brandNew.length}`);
  console.log(`Existing kept:           ${keptExisting.length}   (${droppedExisting.length} dropped dead)`);
  console.log(`New validated alive:     ${keptNew.length}   (${droppedNew.length} dropped)`);
  console.log(`Total final:             ${allFinal.length}`);

  const byCat = {};
  for (const e of allFinal) byCat[e.category] = (byCat[e.category] || 0) + 1;
  const topCats = Object.entries(byCat).sort((a, b) => b[1] - a[1]).slice(0, 12);
  console.log('\nBy category (top 12):');
  for (const [cat, n] of topCats) console.log(`  ${cat.padEnd(22)} ${n}`);

  if (droppedExisting.length > 0) {
    console.log(`\nDropped existing (first 20):`);
    for (const r of droppedExisting.slice(0, 20)) {
      console.log(`  [${r.reason}] ${r.entry.url}`);
    }
  }

  if (args.dryRun) {
    console.log('\nDRY RUN — no files written');
    return;
  }

  // ── Write backup & output ─────────────────────────────────────────────────────
  await fs.mkdir(BACKUPS_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(BACKUPS_DIR, `rss_feeds.${ts}.json`);
  await fs.copyFile(FEEDS_PATH, backupPath);
  console.log(`\nBackup:  ${backupPath}`);

  const json = JSON.stringify(allFinal, null, 2) + '\n';
  await writeAtomic(FEEDS_PATH, json);
  const sizeMB = (Buffer.byteLength(json) / 1024 / 1024).toFixed(2);
  console.log(`Output:  ${FEEDS_PATH} (${sizeMB} MB, ${allFinal.length} entries)`);
}

main().catch(err => {
  console.error('expandFeeds failed:', err.message);
  process.exit(1);
});
