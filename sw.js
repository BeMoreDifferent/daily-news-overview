/**
 * Service Worker — Daily News PWA
 *
 * Strategy:
 *  - App shell (HTML, CSS, JS, icons, manifest): Cache-first, update in background
 *  - News JSON files (news/*.json): Network-first with cache fallback
 *  - Everything else: Network-first
 */

const CACHE_VERSION = 'v2';
const SHELL_CACHE   = `shell-${CACHE_VERSION}`;
const NEWS_CACHE    = `news-${CACHE_VERSION}`;

const SHELL_ASSETS = [
  './',
  './index.html',
  './assets/style.css',
  './assets/app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

// ── Install: pre-cache the app shell ─────────────────────────────────────────

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(cache => cache.addAll(SHELL_ASSETS))
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

  if (path.includes('/news/') && path.endsWith('.json')) {
    // News JSON — network first, cache fallback
    event.respondWith(networkFirstWithCache(request, NEWS_CACHE));
  } else {
    // App shell — cache first, revalidate in background
    event.respondWith(cacheFirstWithRevalidate(request, SHELL_CACHE));
  }
});

// ── Strategies ────────────────────────────────────────────────────────────────

async function networkFirstWithCache(request, cacheName) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
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
