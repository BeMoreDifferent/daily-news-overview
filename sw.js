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
 * reloads on controllerchange (index.html). Installed apps also re-check on resume and hourly.
 */

const CACHE_VERSION = 'v14';
const ASSET_VERSION = '14';
const SHELL_CACHE   = `shell-${CACHE_VERSION}`;
const NEWS_CACHE    = `news-${CACHE_VERSION}`;

const SHELL_ASSETS = [
  './',
  './index.html',
  `./assets/style.css?v=${ASSET_VERSION}`,
  `./assets/app.js?v=${ASSET_VERSION}`,
  `./assets/analytics.js?v=${ASSET_VERSION}`,
  './manifest.json',
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
