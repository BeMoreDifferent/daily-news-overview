/**
 * Service Worker — Daily News PWA
 *
 * Strategy:
 *  - Page navigations (HTML): Network-first, so a deploy shows up on the next load
 *  - News JSON files (news/*.json): Network-first with cache fallback
 *  - Static assets (CSS, JS, icons): Cache-first, update in background. index.html
 *    references CSS/JS with a ?v= query, so a new page never pairs with old assets.
 *
 * When changing assets/style.css, assets/app.js or assets/analytics.js, bump ASSET_VERSION here,
 * the ?v= queries in index.html, imprint.html and privacy.html, and the analytics import in app.js.
 *
 * Updates: a changed sw.js installs, activates at once (skipWaiting + claim) and the page
 * reloads on controllerchange (index.html). Installed apps also re-check on resume and hourly. *
 * Unread badge (installed app): the page reports stories read (READ_THRESHOLD_MS in analytics.js)
 * as `story-read` messages; the worker keeps them in IndexedDB and sets the app icon badge to the
 * number of unread stories in the latest briefing. The latest briefing is re-fetched on
 * `periodicsync` (Chromium, installed apps; the browser picks the interval), when the app opens or
 * returns to the foreground, and hourly while it stays open (`refresh-unread` messages).
 */

const CACHE_VERSION = 'v19';
const ASSET_VERSION = '19';
const SHELL_CACHE   = `shell-${CACHE_VERSION}`;
const NEWS_CACHE    = `news-${CACHE_VERSION}`;

const SHELL_ASSETS = [
  './',
  './index.html',
  `./assets/style.css?v=${ASSET_VERSION}`,
  `./assets/app.js?v=${ASSET_VERSION}`,
  `./assets/analytics.js?v=${ASSET_VERSION}`,
  './manifest.json',
  './icons/favicon-32.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

// ── Install: pre-cache the app shell ─────────────────────────────────────────

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      // cache: 'reload' bypasses the HTTP cache (GitHub Pages: max-age=600), which could
      // otherwise hand the new service worker the previous deploy's files.
      .then(cache => cache.addAll(SHELL_ASSETS.map(url => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

// ── Activate: remove old caches ───────────────────────────────────────────────

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== SHELL_CACHE && k !== NEWS_CACHE)
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
      .then(() => refreshUnread({ network: false }))
  );
});

// ── Fetch ─────────────────────────────────────────────────────────────────────

self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle same-origin GET requests
  if (request.method !== 'GET' || url.origin !== location.origin) return;

  const path = url.pathname;

  if (request.mode === 'navigate') {
    // HTML — network first, cached shell when offline
    event.respondWith(networkFirstWithCache(request, SHELL_CACHE, './'));
  } else if (path.includes('/news/') && path.endsWith('.json')) {
    // News JSON — network first, cache fallback
    event.respondWith(networkFirstWithCache(request, NEWS_CACHE));
  } else {
    // Static assets — cache first, revalidate in background
    event.respondWith(cacheFirstWithRevalidate(request, SHELL_CACHE));
  }
});

// ── Strategies ────────────────────────────────────────────────────────────────

async function networkFirstWithCache(request, cacheName, fallbackUrl) {
  try {
    // Pages are revalidated with the server instead of read from the HTTP cache (GitHub Pages:
    // max-age=600), so a deploy is live on the next load rather than up to 10 minutes later.
    const response = await fetch(request, request.mode === 'navigate' ? { cache: 'no-cache' } : undefined);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request) || (fallbackUrl && await caches.match(fallbackUrl));
    if (cached) return cached;
    return new Response(JSON.stringify({ error: 'offline' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

async function cacheFirstWithRevalidate(request, cacheName) {
  const cached = await caches.match(request);

  // Kick off background revalidation regardless
  const fetchPromise = fetch(request).then(response => {
    if (response.ok) {
      caches.open(cacheName).then(cache => cache.put(request, response.clone()));
    }
    return response;
  }).catch(() => null);

  return cached || await fetchPromise || new Response('Offline', { status: 503 });
}

// ── Unread badge ─────────────────────────────────────────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DB_NAME = 'daily-news';
const STORE = 'state';
// Read marks are kept this long per briefing date, then pruned.
const READ_KEEP_DAYS = 14;

self.addEventListener('message', event => {
  const msg = event.data || {};
  if (msg.type === 'story-read' && DATE_RE.test(msg.date) && typeof msg.id === 'string') {
    event.waitUntil(markRead(msg.date, msg.id));
  } else if (msg.type === 'refresh-unread') {
    event.waitUntil(refreshUnread({ network: true }));
  }
});

self.addEventListener('periodicsync', event => {
  if (event.tag === 'refresh-unread') event.waitUntil(refreshUnread({ network: true }));
});

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// One transaction over the store; `fn` queues requests and its result is returned on commit.
async function withStore(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      let result;
      Promise.resolve(fn(tx.objectStore(STORE))).then(value => { result = value; }, reject);
      tx.oncomplete = () => resolve(result);
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

const request = req => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

async function markRead(date, id) {
  await withStore('readwrite', async store => {
    const key = `read:${date}`;
    const ids = new Set(await request(store.get(key)) || []);
    if (ids.has(id)) return;
    ids.add(id);
    store.put([...ids], key);
  });
  await updateBadge();
}

// Fetch (or, offline and on activation, read from cache) the latest briefing and remember its
// story ids, so marking a story read never needs the network.
async function refreshUnread({ network }) {
  try {
    const index = await getJson('news/index.json', network);
    const dates = (index?.dates || []).filter(d => DATE_RE.test(d)).sort();
    const latest = dates[dates.length - 1];
    if (latest) {
      const day = await getJson(`news/${latest}.json`, network);
      if (day) {
        const ids = (day.topics || []).filter(t => t.articles?.length && t.id).map(t => t.id);
        await withStore('readwrite', async store => {
          store.put({ date: latest, ids }, 'latest');
          const cutoff = new Date(Date.now() - READ_KEEP_DAYS * 864e5).toISOString().slice(0, 10);
          const keys = await request(store.getAllKeys());
          keys.filter(k => k.startsWith('read:') && k.slice(5) < cutoff).forEach(k => store.delete(k));
        });
      }
    }
  } catch { /* offline or storage unavailable: keep the last known count */ }
  await updateBadge();
}

// Network first (bypassing the HTTP cache, max-age=600 on GitHub Pages), cache fallback. Fresh
// briefings are stored in the news cache, so a day fetched in the background also opens offline.
async function getJson(path, network) {
  const url = new URL(path, self.registration.scope).href;
  if (network) {
    try {
      const response = await fetch(url, { cache: 'no-cache' });
      if (response.ok) {
        const cache = await caches.open(NEWS_CACHE);
        await cache.put(url, response.clone());
        return await response.json();
      }
    } catch { /* fall back to the cache */ }
  }
  const cached = await caches.match(url);
  return cached ? cached.json() : null;
}

async function updateBadge() {
  if (!('setAppBadge' in self.navigator)) return;
  try {
    const { latest, read } = await withStore('readonly', async store => {
      const latest = await request(store.get('latest'));
      const read = latest ? await request(store.get(`read:${latest.date}`)) : null;
      return { latest, read };
    });
    const readIds = new Set(read || []);
    const unread = (latest?.ids || []).filter(id => !readIds.has(id)).length;
    if (unread > 0) await self.navigator.setAppBadge(unread);
    else await self.navigator.clearAppBadge();
  } catch { /* not installed, or badges not permitted */ }
}
