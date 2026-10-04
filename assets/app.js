import { setupAnalytics, trackEvent, trackPageView, trackReading } from './analytics.js?v=19';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CACHE_KEY = 'latest-date';
const MAX_PROBE = 60;
// Show the loading skeleton only when a day takes this long; faster loads swap in place.
const SKELETON_DELAY_MS = 200;
// A horizontal swipe of at least this many px (on touch screens) moves one day.
const SWIPE_MIN_PX = 70;
// Feed "images" that are video files, icons or logos would render as broken or meaningless boxes.
const NON_PHOTO_RE = /\.(mp4|webm|mov|m3u8|gif|svg)$|(^|[/_-])(icon|logo|avatar|favicon|sprite|pixel)s?([/_.-]|$)/i;

const $ = id => document.getElementById(id);
const tablet = window.matchMedia('(min-width: 640px)');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

let current = { date: null, data: null };
// Analytics parameters per rendered story element, for reading time and clicks.
let storyParams = new WeakMap();

// ── Dates ────────────────────────────────────────────────────────────────────

// The pattern alone lets through days like 2026-13-45, which no briefing or date input accepts.
function isDate(str) {
  if (!DATE_RE.test(str)) return false;
  const d = new Date(str + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === str;
}

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

function shiftDate(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Briefing dates are UTC days; format them in UTC so the label never drifts a day.
function formatDate(dateStr, style = 'long') {
  const options = style === 'long'
    ? { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }
    : { weekday: 'short', day: 'numeric', month: 'short' };
  return new Date(dateStr + 'T00:00:00Z').toLocaleDateString('en-GB', { ...options, timeZone: 'UTC' });
}

// Article and export times are shown in the reader's own time zone.
function formatTime(iso) {
  const d = iso ? new Date(iso) : null;
  return d && !isNaN(d) ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null;
}

function formatUpdated(iso) {
  const d = iso ? new Date(iso) : null;
  if (!d || isNaN(d)) return null;
  return d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

// ── Data ─────────────────────────────────────────────────────────────────────
// Requests are only made for files that exist: every failed load (a 404, or the service worker's
// 503 for a day not saved offline) is logged as an error in the page console.

// Offline, the saved copy is read directly from the service worker's cache; a missing one fails
// as 'offline' without a request.
async function fetchNews(path) {
  if (!navigator.onLine && 'caches' in window) {
    const cached = await caches.match(new URL(path, location.href).href).catch(() => null);
    if (cached) return cached;
    throw new Error('offline');
  }
  return fetch(path).catch(() => { throw new Error('offline'); });
}

async function fileExists(date) {
  try {
    return (await fetchNews(`news/${date}.json`)).ok;
  } catch {
    return false;
  }
}

// news/index.json lists every exported date; null when missing (older deployments), in which
// case the viewer falls back to probing files day by day.
let indexPromise = null;
function loadIndex() {
  if (!indexPromise) {
    indexPromise = fetchNews('news/index.json')
      .then(res => (res.ok ? res.json() : null))
      .then(data => (Array.isArray(data?.dates) ? data.dates.filter(d => DATE_RE.test(d)).sort() : null))
      .catch(() => null);
  }
  return indexPromise;
}

async function findLatestDate() {
  const dates = await loadIndex();
  if (dates?.length) return dates[dates.length - 1];

  const cached = sessionStorage.getItem(CACHE_KEY);
  if (cached) return cached;

  let date = todayUTC();
  for (let i = 0; i < MAX_PROBE; i++) {
    if (await fileExists(date)) {
      sessionStorage.setItem(CACHE_KEY, date);
      return date;
    }
    date = shiftDate(date, -1);
  }
  return null;
}

// One request per day and session. Neighbouring days are prefetched here, so stepping between
// days swaps content without a network wait. Failed loads are forgotten, so Retry refetches.
// Days missing from the index are not requested at all.
const dayCache = new Map();
function getDay(date) {
  if (!dayCache.has(date)) {
    const promise = loadIndex().then(dates => {
      if (dates && !dates.includes(date)) throw new Error('not_found');
      return fetchNews(`news/${date}.json`);
    }).then(res => {
      if (res.status === 503) throw new Error('offline');
      if (!res.ok) throw new Error('not_found');
      return res.json();
    });
    promise.catch(() => dayCache.delete(date));
    dayCache.set(date, promise);
  }
  return dayCache.get(date);
}

function prefetchDays(...dates) {
  const idle = window.requestIdleCallback || (fn => setTimeout(fn, 300));
  idle(() => dates.filter(Boolean).forEach(date => getDay(date).catch(() => {})));
}

async function neighbours(date) {
  const dates = await loadIndex();
  if (dates) {
    return { prev: dates.filter(d => d < date).pop() || null, next: dates.find(d => d > date) || null };
  }
  const [prev, next] = [shiftDate(date, -1), shiftDate(date, 1)];
  const [prevExists, nextExists] = await Promise.all([fileExists(prev), fileExists(next)]);
  return { prev: prevExists ? prev : null, next: nextExists ? next : null };
}

function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

function safeImage(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol) || NON_PHOTO_RE.test(u.pathname)) return null;
  u.protocol = 'https:'; // http images are blocked as mixed content on the https site
  return u.href;
}

// ── DOM helpers ──────────────────────────────────────────────────────────────

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  node.append(...children.filter(child => child != null && child !== false));
  return node;
}

// Page position decides a story's weight: the lead, two secondary stories beside it, four
// picture features, then text briefs. The CSS grid places each tier.
function tierOf(rank) {
  if (rank === 1) return 'lead';
  if (rank <= 3) return 'secondary';
  if (rank <= 7) return 'feature';
  return 'brief';
}

// Coverage rows shown before "Show more": 3 on phones; in the multi-column layouts the lead
// shows all and the narrower columns 2.
function coverageLimit(tier) {
  if (!tablet.matches) return 3;
  return tier === 'lead' ? Infinity : 2;
}

function readPref(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writePref(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch { /* storage unavailable (private mode) */ }
}

const SHARE_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 3v12M7 8l5-5 5 5M5 13v6a2 2 0 002 2h10a2 2 0 002-2v-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function storyHash(date, rank) {
  return `#${date}/${rank}`;
}

let toastTimer = null;
function toast(message) {
  const node = $('toast');
  node.textContent = message;
  node.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('is-visible'), 2400);
}

// ── Rendering ────────────────────────────────────────────────────────────────

function setNavLink(link, date) {
  if (date) {
    link.href = '#' + date;
    link.removeAttribute('aria-disabled');
  } else {
    link.removeAttribute('href');
    link.setAttribute('aria-disabled', 'true');
  }
}

// Where a day sits in the archive: its neighbours and the full date range.
async function navContext(date) {
  const [{ prev, next }, dates] = await Promise.all([neighbours(date), loadIndex()]);
  return { prev, next, first: dates?.[0] || null, latest: dates?.[dates.length - 1] || null };
}

// Header motion for a day change. The header is shown live during the page's view transition
// (see the CSS), so these run inside it as well as without one. The label slides within the
// pill, which clips it; the pill and the Latest chip resize in layout, so the arrows follow.
const NAV_MOTION = { duration: 280, easing: 'cubic-bezier(0.2, 0, 0, 1)' };
const canAnimate = () => typeof Element.prototype.animate === 'function' && !reducedMotion.matches;

function setDateLabel(date) {
  const button = $('date-button');
  const previous = button.dataset.date;
  if (previous === date) return;
  button.dataset.date = date;
  const label = el('span', { class: 'date-label' }, formatDate(date, 'short'));
  const old = button.querySelector('.date-label:not(.is-leaving)');

  if (!previous || !old || !canAnimate()) {
    button.getAnimations({ subtree: true }).forEach(a => a.cancel());
    button.replaceChildren(label);
    return;
  }

  // Measure mid-flight, so a quick second swipe continues from where the pill is now.
  const from = button.getBoundingClientRect().width;
  button.getAnimations({ subtree: true }).forEach(a => a.cancel());
  button.querySelectorAll('.is-leaving').forEach(node => node.remove());
  old.classList.add('is-leaving');
  button.append(label);
  const to = button.getBoundingClientRect().width;

  const dir = date > previous ? 1 : -1;
  button.animate({ width: [`${from}px`, `${to}px`] }, NAV_MOTION);
  old.animate(
    [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: `translateX(${-dir * 1.2}em)` }],
    { duration: 140, easing: 'ease-in', fill: 'forwards' },
  ).finished.then(() => old.remove(), () => {});
  label.animate(
    [{ opacity: 0, transform: `translateX(${dir * 1.2}em)` }, { opacity: 1, transform: 'none' }],
    { ...NAV_MOTION, delay: 90, fill: 'backwards' },
  );
}

function setLatestChip(show) {
  const chip = $('nav-latest');
  const animate = Boolean($('date-button').dataset.date) && canAnimate();
  const shown = !chip.hidden;
  if (shown === show) return;
  chip.getAnimations().forEach(a => a.cancel());
  chip.classList.remove('is-resizing');
  chip.hidden = !show;
  if (!animate) return;

  // Collapsing width, padding and margin to zero lets the date controls glide over.
  chip.classList.add('is-resizing');
  const style = getComputedStyle(chip);
  const open = {
    minWidth: '0px',
    width: `${chip.getBoundingClientRect().width}px`,
    paddingLeft: style.paddingLeft,
    paddingRight: style.paddingRight,
    marginLeft: style.marginLeft,
    borderLeftWidth: style.borderLeftWidth,
    borderRightWidth: style.borderRightWidth,
    opacity: 1,
  };
  const closed = {
    minWidth: '0px', width: '0px', paddingLeft: '0px', paddingRight: '0px', marginLeft: '0px',
    borderLeftWidth: '0px', borderRightWidth: '0px', opacity: 0,
  };
  const anim = chip.animate(show ? [closed, open] : [open, closed], NAV_MOTION);
  anim.finished.then(() => chip.classList.remove('is-resizing'), () => {});
}

// Synchronous, so the header changes inside the same view transition as the page.
function renderNav(date, { prev, next, first, latest }) {
  const button = $('date-button');
  setDateLabel(date);
  button.setAttribute('aria-label', `Choose a date. Showing ${formatDate(date)}`);
  $('date-input').value = date;

  setNavLink($('nav-prev'), prev);
  setNavLink($('nav-next'), next);
  $('nav-prev').setAttribute('aria-label', prev ? `Previous day, ${formatDate(prev)}` : 'Previous day');
  $('nav-next').setAttribute('aria-label', next ? `Next day, ${formatDate(next)}` : 'Next day');
  // There is nothing after the newest briefing, so its forward arrow is not shown at all.
  $('nav-next').classList.toggle('is-end', !next);

  setLatestChip(Boolean(latest) && latest !== date);
  if (first) {
    $('date-input').min = first;
    $('date-input').max = latest;
  }

  renderPager(prev, next);
  prefetchDays(prev, next);
}

// End-of-page links to the neighbouring days, with each day's top story once it has loaded.
function renderPager(prev, next) {
  const fill = (link, date) => {
    link.hidden = !date;
    if (!date) return link.removeAttribute('href');
    link.href = '#' + date;
    link.querySelector('.pager-date').textContent = formatDate(date);
    const lead = link.querySelector('.pager-lead');
    lead.textContent = '';
    getDay(date).then(data => {
      const top = (data.topics || []).find(t => t.articles?.length);
      if (top && link.getAttribute('href') === '#' + date) lead.textContent = storyTitle(top);
    }).catch(() => {});
  };
  fill($('pager-prev'), prev);
  fill($('pager-next'), next);
  $('day-pager').hidden = !prev && !next;
}

function renderIntro(date, data) {
  $('briefing-date').textContent = formatDate(date);
  const updated = formatUpdated(data?.generated_at);
  $('footer-meta').textContent = updated ? `Briefing generated ${updated}` : '';
}

// The AI "day in brief": 3-5 points, each linking to the stories it draws on.
function renderOverview(date, data, stories) {
  const box = $('overview');
  const rankOf = new Map(stories.map((topic, i) => [topic, i + 1]));
  const points = (Array.isArray(data?.overview?.points) ? data.overview.points : [])
    .filter(point => typeof point?.text === 'string' && point.text.trim())
    .map(point => ({
      text: point.text.trim(),
      ranks: (point.stories || []).map(n => rankOf.get(data.topics?.[n - 1])).filter(Boolean),
    }));

  box.hidden = points.length === 0;
  $('intro').classList.toggle('has-overview', points.length > 0);
  $('overview-list').replaceChildren(...points.map(point => el('li', {},
    point.text,
    point.ranks.length > 0 && el('span', { class: 'overview-refs' },
      ...point.ranks.map(rank => el('a', {
        class: 'ref',
        href: storyHash(date, rank),
        'data-rank': rank,
        'aria-label': `Story ${rank}: ${storyTitle(stories[rank - 1])}`,
      }, String(rank).padStart(2, '0'))),
    ),
  )));
}

function renderToc(date, stories) {
  const build = () => stories.map((topic, i) => el('li', {},
    el('a', { href: storyHash(date, i + 1), 'data-rank': i + 1 },
      el('span', { class: 'toc-rank', 'aria-hidden': 'true' }, String(i + 1)),
      el('span', { class: 'toc-title' }, storyTitle(topic)),
    ),
  ));
  $('toc-list').replaceChildren(...build());
  $('toc-count').textContent = `(${stories.length})`;
  const inline = $('toc-inline');
  inline.hidden = stories.length === 0;
  inline.open = false;
}

function storyTitle(topic) {
  const label = topic.label?.[0];
  return topic.title || topic.headline || (label ? label.charAt(0).toUpperCase() + label.slice(1) : 'Untitled story');
}

function renderMedia(topic, isLead) {
  // Candidates in centrality order; a broken hotlink falls through to the next one.
  const candidates = topic.articles
    .map(a => ({ src: safeImage(a.image), credit: domainOf(a.url) }))
    .filter(c => c.src);
  if (!candidates.length) return null;

  let index = 0;
  const caption = el('figcaption', {}, `Image: ${candidates[0].credit || 'publisher'}`);
  // `src` is set last: browsers may start the request as soon as it is set, before the lazy
  // loading, CORS and referrer attributes below would apply.
  const img = el('img', {
    alt: '',
    // The lead is the largest thing on first paint; every other picture waits until it is near
    // the viewport. Hidden images (briefs on wide screens) are never fetched.
    loading: isLead ? 'eager' : 'lazy',
    fetchpriority: isLead ? 'high' : null,
    decoding: 'async',
    // Privacy: no referrer, and an anonymous (CORS) request, so no cookies are sent to or set by
    // the publisher. Servers that do not allow anonymous loading fail like a broken image and the
    // next outlet's picture is tried; there is deliberately no fallback to a credentialed request.
    referrerpolicy: 'no-referrer',
    crossorigin: 'anonymous',
  });
  waitForPicture(img);
  // Offline, a picture request can only fail (and log an error); it waits for the connection.
  if (navigator.onLine) img.src = candidates[0].src;
  else img.dataset.src = candidates[0].src;
  const figure = el('figure', { class: 'story-media' }, el('span', { class: 'story-media-frame' }, img), caption);
  img.addEventListener('error', () => {
    index += 1;
    if (index < candidates.length) {
      waitForPicture(img);
      img.src = candidates[index].src;
      caption.textContent = `Image: ${candidates[index].credit || 'publisher'}`;
    } else {
      figure.closest('.story')?.classList.remove('has-media');
      figure.remove();
    }
  });
  return figure;
}

// Pictures that arrive late fade in (CSS .is-loading); ones that load straight away, from the
// cache or when revisiting a day, appear without a fade so nothing blinks. `complete` cannot tell
// the two apart: lazy images report false until they are fetched, cached or not. The frame
// behind the picture keeps the placeholder tint, so the fade never dips through to the page.
const LATE_PICTURE_MS = 120;
function waitForPicture(img) {
  if (img.complete && img.naturalWidth) return;
  const start = performance.now();
  img.style.transition = '';
  img.classList.add('is-loading');
  img.addEventListener('load', () => {
    if (performance.now() - start < LATE_PICTURE_MS) img.style.transition = 'none';
    img.classList.remove('is-loading');
  }, { once: true });
}

function renderCoverage(topic, story) {
  const items = topic.articles.map(article => {
    const time = formatTime(article.published_at);
    const inner = [
      el('span', { class: 'coverage-meta' },
        el('span', { class: 'coverage-source' }, domainOf(article.url) || article.source || 'Unknown source'),
        time && el('time', { datetime: article.published_at }, time),
      ),
      el('span', { class: 'coverage-title' }, article.title || 'Untitled'),
    ];
    const row = article.url
      ? el('a', { class: 'coverage-link', href: article.url, target: '_blank', rel: 'noopener noreferrer' },
        ...inner, el('span', { class: 'visually-hidden' }, ' (opens in new tab)'))
      : el('div', { class: 'coverage-link' }, ...inner);
    return el('li', {}, row);
  });

  const list = el('ul', { class: 'coverage', role: 'list', 'aria-label': 'Coverage' }, ...items);
  const more = el('button', {
    class: 'coverage-more',
    type: 'button',
    'aria-expanded': 'false',
    onclick: () => {
      const revealed = [...list.querySelectorAll('li[hidden]')];
      story.classList.toggle('is-expanded');
      applyCoverageLimit(story);
      if (revealed[0]) revealed[0].querySelector('a, div')?.focus();
      if (story.classList.contains('is-expanded') && canAnimate()) {
        revealed.forEach((item, i) => item.animate(
          [{ opacity: 0, transform: 'translateY(-4px)' }, { opacity: 1, transform: 'none' }],
          { duration: 200, delay: Math.min(i, 4) * 30, easing: 'ease-out', fill: 'backwards' },
        ));
      }
    },
  });
  return [list, more];
}

function applyCoverageLimit(story) {
  const items = story.querySelectorAll('.coverage > li');
  const more = story.querySelector('.coverage-more');
  if (!more) return;
  const limit = coverageLimit(story.dataset.tier);
  const expanded = story.classList.contains('is-expanded');
  items.forEach((item, i) => { item.hidden = !expanded && i >= limit; });
  const extra = items.length - limit;
  more.hidden = extra <= 0;
  more.setAttribute('aria-expanded', String(expanded));
  more.textContent = expanded ? 'Show fewer' : `Show ${extra} more ${extra === 1 ? 'outlet' : 'outlets'}`;
}

function renderStory(date, topic, rank) {
  const title = storyTitle(topic);
  const tier = tierOf(rank);
  const isLead = tier === 'lead';
  const story = el('article', {
    class: `story story--${tier}`,
    'data-tier': tier,
    id: `story-${rank}`,
    tabindex: '-1',
    'aria-labelledby': `story-${rank}-title`,
  });

  const kickerParts = [
    el('span', { class: 'story-rank' }, el('span', { class: 'visually-hidden' }, 'Story '), String(rank).padStart(2, '0')),
    el('span', {}, `${topic.source_count} ${topic.source_count === 1 ? 'outlet' : 'outlets'}`),
  ];
  if (topic.category === 'trending' || topic.category === 'ongoing') {
    kickerParts.push(el('span', { class: `badge badge--${topic.category}` }, topic.category === 'trending' ? 'Trending' : 'Developing'));
  }

  const share = el('button', {
    class: 'share-btn',
    type: 'button',
    'aria-label': `Share story: ${title}`,
    onclick: () => shareStory(date, rank, title),
  });
  share.innerHTML = SHARE_ICON; // static markup, no data

  const media = renderMedia(topic, isLead);
  if (media) story.classList.add('has-media');

  story.append(
    el('div', { class: 'story-kicker' }, el('p', { class: 'story-kicker-text' }, ...kickerParts), share),
    el('h2', { class: 'story-title', id: `story-${rank}-title` }, title),
    media,
    topic.summary && el('p', { class: 'story-summary' }, topic.summary),
    ...renderCoverage(topic, story),
  );
  applyCoverageLimit(story);
  return el('li', { class: `slot slot--${tier}` }, story);
}

function renderSkeleton() {
  const block = cls => el('span', { class: `skeleton ${cls}` });
  const card = (_, i) => el('li', { class: `slot slot--${tierOf(i + 1)}`, 'aria-hidden': 'true' },
    el('div', { class: 'story story--skeleton' },
      block('sk-kicker'), block('sk-title'), block('sk-title sk-short'),
      block('sk-line'), block('sk-line'), block('sk-line sk-short'),
    ),
  );
  $('stories').replaceChildren(...Array.from({ length: tablet.matches ? 7 : 3 }, card));
  $('stories').setAttribute('aria-busy', 'true');
}

async function renderMissing(date, reason) {
  trackReading([]);
  const stories = $('stories');
  stories.setAttribute('aria-busy', 'false');
  renderIntro(date, null);
  renderToc(date, []);
  renderOverview(date, null, []);

  if (reason === 'not_found') {
    const { prev, next } = await neighbours(date);
    const links = [
      prev && el('a', { class: 'btn', href: '#' + prev }, `← ${formatDate(prev, 'short')}`),
      next && el('a', { class: 'btn', href: '#' + next }, `${formatDate(next, 'short')} →`),
      el('a', { class: 'btn btn--primary', href: '#' }, 'Latest briefing'),
    ];
    stories.replaceChildren(el('li', { class: 'empty' },
      el('h2', {}, 'No briefing for this day'),
      el('p', {}, `There is no briefing for ${formatDate(date)}. Try a nearby day:`),
      el('p', { class: 'empty-actions' }, ...links),
    ));
  } else {
    const offline = reason === 'offline' || !navigator.onLine;
    stories.replaceChildren(el('li', { class: 'empty' },
      el('h2', {}, offline ? 'You’re offline' : 'Couldn’t load this briefing'),
      el('p', {}, offline
        ? 'This day hasn’t been saved on this device yet. Reconnect to read it.'
        : 'Something went wrong while loading. Check your connection and try again.'),
      el('p', { class: 'empty-actions' },
        el('button', { class: 'btn btn--primary', type: 'button', onclick: () => { current.date = null; route(); } }, 'Try again')),
    ));
  }
}

function renderStories(date, data) {
  const stories = (data.topics || []).filter(t => t.articles?.length);
  renderIntro(date, data);
  renderToc(date, stories);
  renderOverview(date, data, stories);

  const list = $('stories');
  list.setAttribute('aria-busy', 'false');
  trackReading([]);
  if (!stories.length) {
    list.replaceChildren(el('li', { class: 'empty' }, el('h2', {}, 'No stories'), el('p', {}, 'This day’s briefing has no stories.')));
    return;
  }
  list.replaceChildren(...stories.map((topic, i) => renderStory(date, topic, i + 1)));
  document.title = `${storyTitle(stories[0])} — Daily News, ${formatDate(date, 'short')}`;

  storyParams = new WeakMap();
  trackReading(stories.map((topic, i) => {
    const story = $(`story-${i + 1}`);
    const params = analyticsParams(date, topic, i + 1);
    storyParams.set(story, params);
    return { el: story, params, onRead: topic.id ? () => toWorker({ type: 'story-read', date, id: topic.id }) : null };
  }));
}

// GA4 event parameters describing a story (register them as custom dimensions in GA).
// Keywords are the topic's top TF-IDF terms, the closest thing to a subject per story.
function analyticsParams(date, topic, rank) {
  return {
    story_date: date,
    story_rank: rank,
    story_title: storyTitle(topic).slice(0, 100),
    story_category: topic.category || 'none',
    story_keywords: (topic.label || []).slice(0, 4).join(' ').slice(0, 100),
    story_outlets: topic.source_count,
  };
}

// ── Interaction ──────────────────────────────────────────────────────────────

async function shareStory(date, rank, title) {
  const url = location.href.split('#')[0] + storyHash(date, rank);
  trackEvent('share', { ...storyParams.get($(`story-${rank}`)), content_type: 'story', item_id: `${date}/${rank}` });
  if (navigator.share) {
    try {
      await navigator.share({ title, url });
    } catch { /* dismissed */ }
    return;
  }
  try {
    await navigator.clipboard.writeText(url);
    toast('Link copied');
  } catch {
    history.replaceState(null, '', storyHash(date, rank));
    toast('Link is in the address bar');
  }
}

function focusStory(rank, { instant = false } = {}) {
  const story = $(`story-${rank}`);
  if (!story) return;
  story.scrollIntoView({ behavior: instant || reducedMotion.matches ? 'instant' : 'smooth', block: 'start' });
  story.focus({ preventScroll: true });
}

function setupDatePicker() {
  const button = $('date-button');
  const input = $('date-input');
  // Without showPicker the transparent input sits on top of the button and takes the tap itself.
  if (typeof input.showPicker !== 'function') document.documentElement.classList.add('no-showpicker');

  button.addEventListener('click', () => {
    try {
      input.showPicker();
    } catch {
      input.focus();
    }
  });

  input.addEventListener('change', async () => {
    const picked = input.value;
    if (!isDate(picked) || picked === current.date) return;
    const dates = await loadIndex();
    // Snap to the closest earlier briefing (or the first one) when the picked day has none.
    const target = dates ? (dates.filter(d => d <= picked).pop() || dates[0]) : picked;
    if (dates && target !== picked) toast(`No briefing on ${formatDate(picked, 'short')} — showing ${formatDate(target, 'short')}`);
    location.hash = target;
  });
}

// Following the same story link twice (contents, overview) fires no navigation; scroll anyway.
// Interest signals: which publisher links are opened, which stories are jumped to from the day in
// brief or the contents, and where readers want more coverage.
function setupClickTracking() {
  document.addEventListener('click', event => {
    const target = event.target.closest('a, button');
    const story = target?.closest('.story');
    if (!target) return;
    if (story && target.matches('a.coverage-link')) {
      trackEvent('article_click', { ...storyParams.get(story), outlet: domainOf(target.href) });
    } else if (story && target.matches('.coverage-more') && story.classList.contains('is-expanded')) {
      trackEvent('coverage_expand', storyParams.get(story));
    } else if (target.matches('a[data-rank]')) {
      const params = storyParams.get($(`story-${target.dataset.rank}`));
      trackEvent('story_jump', { ...params, jump_source: target.closest('.overview') ? 'brief' : 'contents' });
    }
  });
}

function setupRankLinks() {
  document.addEventListener('click', event => {
    const link = event.target.closest('a[data-rank]');
    if (link && link.getAttribute('href') === location.hash) {
      event.preventDefault();
      focusStory(link.dataset.rank);
    }
  });
}

function setupOverviewToggle() {
  const box = $('overview');
  const summary = box.querySelector('summary');
  // Tablet and desktop: open by default, and the reader's own choice is remembered. Phones always
  // show it (as a row of swipeable cards), so there the summary is only a label.
  const pref = readPref('overview-open');
  box.open = pref ? pref === '1' : tablet.matches;
  box.addEventListener('toggle', () => { if (tablet.matches) writePref('overview-open', box.open ? '1' : '0'); });
  summary.addEventListener('click', event => { if (!tablet.matches) event.preventDefault(); });
  const pin = () => {
    if (tablet.matches) {
      summary.removeAttribute('tabindex');
      box.open = readPref('overview-open') !== '0';
    } else {
      summary.tabIndex = -1;
      box.open = true;
    }
  };
  pin();
  tablet.addEventListener('change', pin);
}

// "All stories" is a dropdown on phones: it closes after a pick, on a tap outside, or on Escape.
function setupContentsDropdown() {
  const box = $('toc-inline');
  const close = () => { box.open = false; };
  box.addEventListener('click', event => { if (event.target.closest('a')) close(); });
  document.addEventListener('pointerdown', event => { if (box.open && !box.contains(event.target)) close(); });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && box.open) {
      close();
      box.querySelector('summary').focus();
    }
  });
}

// Touch screens: swipe right for the previous day, left for the next. Swipes starting at the
// screen edges belong to the browser's own back/forward gestures.
function setupSwipe() {
  let start = null;
  addEventListener('touchstart', event => {
    const touch = event.touches[0];
    const edge = 24;
    start = event.touches.length === 1 && touch.clientX > edge && touch.clientX < innerWidth - edge
      && !event.target.closest('input, .date-picker, .overview-list')
      ? { x: touch.clientX, y: touch.clientY, time: event.timeStamp }
      : null;
  }, { passive: true });
  addEventListener('touchcancel', () => { start = null; }, { passive: true });
  addEventListener('touchend', event => {
    if (!start) return;
    const touch = event.changedTouches[0];
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    const quick = event.timeStamp - start.time < 700;
    start = null;
    if (!quick || Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dx) < 2 * Math.abs(dy)) return;
    if (!document.getSelection()?.isCollapsed) return;
    const target = $(dx > 0 ? 'nav-prev' : 'nav-next').getAttribute('href');
    if (target) location.hash = target.slice(1);
  }, { passive: true });
}

// During a slide Chrome hit-tests the transition overlay (it reports the root as the target), so
// a quick second tap on the arrows would be lost. The header never moves, so hand the tap to the
// header control under the pointer.
function setupTapsDuringSlide() {
  const root = document.documentElement;
  root.addEventListener('click', event => {
    if (event.target !== root || !root.classList.contains('is-sliding')) return;
    const control = ['nav-prev', 'nav-next', 'nav-latest', 'date-button'].map($).find(node => {
      const box = node.getBoundingClientRect();
      return !node.hidden && box.width > 0 && event.clientX >= box.left && event.clientX <= box.right
        && event.clientY >= box.top && event.clientY <= box.bottom;
    });
    control?.click();
  });
}

// ── Unread badge (installed app) ─────────────────────────────────────────────
// The service worker keeps the read stories and sets the app icon badge (see sw.js). The page
// reports reads and asks for a refresh when it opens, returns to the foreground and hourly.

const UNREAD_REFRESH_MS = 60 * 60 * 1000;
const standalone = window.matchMedia('(display-mode: standalone)');

// `ready` resolves to the active worker even when it does not control this page (hard reload).
function toWorker(message) {
  navigator.serviceWorker?.ready.then(reg => reg.active?.postMessage(message)).catch(() => {});
}

async function setupUnreadBadge() {
  if (!('serviceWorker' in navigator)) return;
  const refresh = () => toWorker({ type: 'refresh-unread' });
  refresh();
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });
  setInterval(refresh, UNREAD_REFRESH_MS);

  // Background refresh while the app is closed. Chromium grants it to installed apps only; the
  // browser decides the actual interval from how often the app is used.
  try {
    const reg = await navigator.serviceWorker.ready;
    if (reg.periodicSync) await reg.periodicSync.register('refresh-unread', { minInterval: UNREAD_REFRESH_MS });
  } catch { /* not installed or not permitted */ }

  // Safari and macOS only show a badge with notification permission, which must be asked from a
  // tap. Offer it in the installed app until the reader has decided.
  const button = $('badge-settings');
  const update = () => {
    button.hidden = !(standalone.matches && 'setAppBadge' in navigator
      && 'Notification' in window && Notification.permission === 'default');
  };
  button.addEventListener('click', async () => {
    try {
      await Notification.requestPermission();
    } catch { /* dismissed */ }
    update();
    refresh();
  });
  standalone.addEventListener('change', update);
  update();
}

function updateNotice() {
  const notice = $('notice');
  notice.hidden = navigator.onLine;
  notice.textContent = navigator.onLine ? '' : 'You’re offline — showing a saved copy.';
}

// ── Routing: #YYYY-MM-DD or #YYYY-MM-DD/<rank> ───────────────────────────────

// Hashes the router owns: none (latest), a date, or a date and story. Anything else is an
// in-page anchor such as the skip link.
function isRoute(hash) {
  return hash === '' || hash === '#' || DATE_RE.test(hash.slice(1).split('/')[0]);
}

function parseHash() {
  const [date, rank] = location.hash.slice(1).split('/');
  return { date: isDate(date) ? date : null, rank: /^\d{1,2}$/.test(rank || '') ? +rank : null };
}

// Day changes slide in the direction of travel (View Transitions API with transition types);
// the sticky header stays live on top and animates its own date (setDateLabel). Browsers without
// support, and readers who prefer reduced motion, get an instant swap.
let activeSlide = null;
function swapDay(direction, update) {
  if (!document.startViewTransition || reducedMotion.matches || document.visibilityState !== 'visible') {
    update();
    return Promise.resolve();
  }
  // Snapshot names (header, date) are set only for the transition; see .is-sliding in the CSS.
  const root = document.documentElement;
  root.classList.add('is-sliding');
  let transition;
  activeSlide?.skipTransition();
  try {
    transition = document.startViewTransition({ update, types: [direction] });
  } catch {
    transition = document.startViewTransition(update); // no transition types: plain cross-fade
  }
  activeSlide = transition;
  // A skipped slide settles after the next one has started; only the latest clears the class,
  // or the header would lose its own snapshot and slide away with the page.
  transition.finished.finally(() => {
    if (activeSlide !== transition) return;
    activeSlide = null;
    root.classList.remove('is-sliding');
  });
  return transition.updateCallbackDone.catch(() => {});
}

async function loadDate(date, { restoreScroll } = {}) {
  const previous = current.date;
  current = { date, data: null };
  document.title = `Daily News — ${formatDate(date, 'short')}`;

  // First visit: skeleton right away. Later day changes keep the old day on screen and only
  // fall back to the skeleton if the new one is slow (it is usually prefetched).
  const nav = navContext(date);
  let skeleton = false;
  const showSkeleton = () => {
    skeleton = true;
    renderSkeleton();
    window.scrollTo({ top: 0, behavior: 'instant' });
    nav.then(context => current.date === date && renderNav(date, context));
  };
  const timer = previous ? setTimeout(showSkeleton, SKELETON_DELAY_MS) : (showSkeleton(), null);

  let data = null;
  let error = null;
  try {
    data = await getDay(date);
  } catch (err) {
    error = err.message;
  }
  const context = await nav;
  clearTimeout(timer);
  if (current.date !== date) return false;
  current.data = data;

  const update = () => {
    renderNav(date, context);
    if (data) renderStories(date, data);
    else renderMissing(date, error);
    if (restoreScroll) restoreScroll();
    // 'instant': html has scroll-behavior: smooth, which would scroll the whole new day past
    // the reader while it slides in.
    else if (previous) window.scrollTo({ top: 0, behavior: 'instant' });
  };
  if (previous && !skeleton) await swapDay(date > previous ? 'forward' : 'backward', update);
  else update();
  return Boolean(data);
}

async function route({ restoreScroll } = {}) {
  if (!isRoute(location.hash)) return;
  let { date, rank } = parseHash();
  const toLatest = !date;
  if (!date) {
    date = await findLatestDate();
    if (!date) {
      $('stories').setAttribute('aria-busy', 'false');
      $('stories').replaceChildren(el('li', { class: 'empty' }, el('h2', {}, 'No briefings yet'), el('p', {}, 'Check back tomorrow.')));
      return;
    }
    history.replaceState(history.state, '', '#' + date);
  }

  if (date !== current.date) {
    const loaded = await loadDate(date, { restoreScroll: rank ? null : restoreScroll });
    if (current.date === date) trackPageView();
    if (loaded && rank) focusStory(rank, { instant: true });
    return;
  }
  if (rank) focusStory(rank);
  else if (restoreScroll) restoreScroll();
  else if (toLatest) window.scrollTo({ top: 0, behavior: reducedMotion.matches ? 'auto' : 'smooth' });
}

// Navigation API where available: one listener for links, the date picker, swipes and the
// back/forward buttons, with the browser's own loading indicator and scroll restoration when
// going back. Older browsers use hashchange.
function setupRouting() {
  if ('navigation' in window) {
    navigation.addEventListener('navigate', event => {
      if (!event.hashChange || !event.canIntercept || !isRoute(new URL(event.destination.url).hash)) return;
      const traverse = event.navigationType === 'traverse';
      event.intercept({
        scroll: 'manual',
        handler: () => route({ restoreScroll: traverse ? () => event.scroll() : null }),
      });
    });
  } else {
    window.addEventListener('hashchange', () => route());
  }
}

setupAnalytics();
setupClickTracking();
setupDatePicker();
setupRankLinks();
setupOverviewToggle();
setupContentsDropdown();
setupSwipe();
setupTapsDuringSlide();
setupRouting();
setupUnreadBadge();
updateNotice();
window.addEventListener('online', () => {
  updateNotice();
  document.querySelectorAll('.story-media img[data-src]').forEach(img => {
    img.src = img.dataset.src;
    delete img.dataset.src;
  });
});
window.addEventListener('offline', updateNotice);
tablet.addEventListener('change', () => document.querySelectorAll('.story[data-tier]').forEach(applyCoverageLimit));
route();
