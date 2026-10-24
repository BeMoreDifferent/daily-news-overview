import { setupAnalytics, trackEvent, trackPageView, trackReading } from './analytics.js?v=26';
import { noteStoryRead, setupInstall } from './install.js?v=26';

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
// Section filter (null = all). Kept while moving between days, dropped on reload.
let sectionFilter = null;

const SECTION_LABELS = {
  world: 'World',
  politics: 'Politics',
  business: 'Business',
  technology: 'Tech',
  'science-health': 'Science & Health',
  sports: 'Sports',
  culture: 'Culture',
};
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
// shows all and the narrower columns (and filtered rows, which list coverage two across) 2.
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
const EASE_OUT = 'cubic-bezier(0.2, 0, 0, 1)'; // decelerate: things arriving or resizing
const EASE_IN = 'cubic-bezier(0.3, 0, 1, 1)'; // accelerate: things leaving
// Shared motion tokens (mirrored by --ease-* and --dur-* in the CSS). Exits are shorter than
// entrances, so a change starts at once and settles softly.
const MOTION = {
  enter: { duration: 240, easing: EASE_OUT },
  exit: { duration: 140, easing: EASE_IN },
  resize: { duration: 280, easing: EASE_OUT },
};
const NAV_MOTION = MOTION.resize;
const canAnimate = () => typeof Element.prototype.animate === 'function' && !reducedMotion.matches;
// Resolves when an exit animation ends, or shortly after its duration: `finished` can stall
// (hidden tab, throttled timeline) and must never leave the control stuck.
const settled = (animation, ms) => Promise.race([
  animation.finished.catch(() => {}),
  new Promise(resolve => setTimeout(resolve, ms + 80)),
]);

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
    { ...MOTION.exit, fill: 'forwards' },
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
      if (!top || link.getAttribute('href') !== '#' + date) return;
      lead.textContent = storyTitle(top);
      if (canAnimate()) lead.animate([{ opacity: 0 }, { opacity: 1 }], MOTION.enter);
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
      // Off screen the layout change is invisible; on screen the picture fades and closes first.
      const story = figure.closest('.story');
      collapseAway(figure, { close: false }).then(() => story?.classList.remove('has-media'));
    }
  });
  return figure;
}

// Removes a node that is on screen by fading it out and (for list rows) closing the gap it
// leaves; one that cannot be seen, or with reduced motion, goes at once.
async function collapseAway(node, { close = true } = {}) {
  const box = node.isConnected ? node.getBoundingClientRect() : null;
  if (canAnimate() && box?.height && box.bottom > 0 && box.top < innerHeight) {
    await settled(node.animate([{ opacity: 1 }, { opacity: 0 }], { ...MOTION.exit, fill: 'forwards' }), MOTION.exit.duration);
    if (close) {
      const style = getComputedStyle(node);
      const closing = {
        height: [`${box.height}px`, '0px'],
        paddingTop: [style.paddingTop, '0px'],
        paddingBottom: [style.paddingBottom, '0px'],
        borderTopWidth: [style.borderTopWidth, '0px'],
        opacity: [0, 0],
        overflow: ['clip', 'clip'],
      };
      await settled(node.animate(closing, { ...MOTION.resize, duration: 200, fill: 'forwards' }), 200);
    }
  }
  node.remove();
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
  // The best video takes the second row, so it is visible without crowding out the lead article;
  // others wait behind "Show more". Every story keeps the same visible row count, video or not,
  // which keeps neighbouring cards level.
  const videos = (topic.videos || [])
    .filter(video => video.url && safeImage(video.thumbnail))
    .map(video => renderVideoItem(video, story));
  if (videos.length) items.splice(Math.min(1, items.length), 0, videos[0]);
  items.push(...videos.slice(1));

  const list = el('ul', { class: 'coverage', role: 'list', 'aria-label': 'Coverage' }, ...items);
  const more = el('button', {
    class: 'coverage-more',
    type: 'button',
    'aria-expanded': 'false',
    onclick: () => toggleCoverage(story, list, more),
  });
  return [list, more];
}

// "Show more" / "Show fewer": the list grows or shrinks to its new height while the rows fade, so
// the card and everything below it glide instead of jumping. A collapse that starts with the list
// already scrolled under the header happens at once, keeping the button under the reader's finger.
async function toggleCoverage(story, list, more) {
  if (more.dataset.busy) return;
  const expanding = !story.classList.contains('is-expanded');
  const header = document.querySelector('.site-header')?.getBoundingClientRect().bottom || 0;

  if (expanding) {
    const from = list.offsetHeight;
    const revealed = [...list.querySelectorAll('li[hidden]')];
    story.classList.add('is-expanded');
    applyCoverageLimit(story);
    if (revealed[0]) revealed[0].querySelector('a, div')?.focus({ preventScroll: true });
    if (!canAnimate()) return;
    resizeTo(list, from, list.offsetHeight);
    revealed.forEach((item, i) => item.animate(
      [{ opacity: 0, transform: 'translateY(-4px)' }, { opacity: 1, transform: 'none' }],
      { ...MOTION.enter, delay: 40 + Math.min(i, 4) * 30, fill: 'backwards' },
    ));
    return;
  }

  const collapse = () => {
    story.classList.remove('is-expanded');
    applyCoverageLimit(story);
  };
  if (!canAnimate() || list.getBoundingClientRect().top < header) {
    const before = more.getBoundingClientRect().top;
    collapse();
    const shift = more.getBoundingClientRect().top - before;
    if (shift < 0) window.scrollBy({ top: shift, behavior: 'instant' });
    return;
  }

  const leaving = [...list.children].slice(coverageLimit(story.dataset.tier)).filter(item => !item.hidden);
  const from = list.offsetHeight;
  // Measure the collapsed height without painting it.
  leaving.forEach(item => { item.hidden = true; });
  const to = list.offsetHeight;
  leaving.forEach(item => { item.hidden = false; });

  more.dataset.busy = '1';
  leaving.forEach(item => item.animate([{ opacity: 1 }, { opacity: 0 }], { ...MOTION.exit, fill: 'forwards' }));
  await settled(resizeTo(list, from, to), MOTION.resize.duration);
  collapse();
  leaving.forEach(item => item.getAnimations().forEach(animation => animation.cancel()));
  delete more.dataset.busy;
}

// Animates an element between two heights (px), clipped while it moves; it returns to its own
// height afterwards. Neighbouring cards in the same grid row follow along.
function resizeTo(node, from, to) {
  node.getAnimations().forEach(animation => { if (animation.id === 'resize') animation.cancel(); });
  const animation = node.animate(
    { height: [`${from}px`, `${to}px`], overflow: ['clip', 'clip'] },
    { ...MOTION.resize, id: 'resize' },
  );
  return animation;
}

// A matching news video is one more coverage row: thumbnail left, channel, time and title beside
// it. Nothing is embedded, so YouTube only sees the anonymous, referrer-less thumbnail request
// (i.ytimg.com), like any other picture. A thumbnail that fails takes its row with it.
function renderVideoItem(video, story) {
  const time = formatTime(video.published_at);
  const img = el('img', {
    alt: '',
    loading: 'lazy',
    decoding: 'async',
    referrerpolicy: 'no-referrer',
    crossorigin: 'anonymous',
  });
  const item = el('li', { class: 'coverage-video' },
    el('a', { class: 'coverage-link video-link', href: video.url, target: '_blank', rel: 'noopener noreferrer' },
      el('span', { class: 'video-thumb' }, img, el('span', { class: 'video-play', 'aria-hidden': 'true' })),
      el('span', { class: 'video-text' },
        el('span', { class: 'coverage-meta' },
          el('span', { class: 'coverage-source' }, video.channel || 'YouTube'),
          time && el('time', { datetime: video.published_at }, time),
          el('span', { class: 'coverage-kind' }, 'Video'),
        ),
        el('span', { class: 'coverage-title' }, video.title || 'Untitled video'),
        el('span', { class: 'visually-hidden' }, ' (video on YouTube, opens in new tab)'),
      ),
    ),
  );
  img.addEventListener('error', async () => {
    await collapseAway(item);
    const hidden = [...story.querySelectorAll('.coverage > li[hidden]')];
    applyCoverageLimit(story);
    // The row that moves up into the visible ones fades in rather than popping.
    if (canAnimate()) hidden.filter(row => !row.hidden).forEach(row => row.animate([{ opacity: 0 }, { opacity: 1 }], MOTION.enter));
  }, { once: true });
  waitForPicture(img);
  img.src = safeImage(video.thumbnail);
  return item;
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

// `tier` defaults to the front-page position; a filtered view lays every story out as a row.
function renderStory(date, topic, rank, tier = tierOf(rank)) {
  const title = storyTitle(topic);
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
  if (SECTION_LABELS[topic.section]) kickerParts.push(el('span', { class: 'story-section' }, SECTION_LABELS[topic.section]));
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

  // append() would print a skipped part (null/false) as text.
  story.append(...[
    el('div', { class: 'story-kicker' }, el('p', { class: 'story-kicker-text' }, ...kickerParts), share),
    el('h2', { class: 'story-title', id: `story-${rank}-title` }, title),
    media,
    topic.summary && el('p', { class: 'story-summary' }, topic.summary),
    ...renderCoverage(topic, story),
  ].filter(Boolean));
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
  // The previous day's brief, story count and chips go too; the new day's fade in with its stories.
  $('overview').hidden = true;
  $('intro').classList.remove('has-overview');
  $('toc-inline').open = false;
  $('toc-count').textContent = '';
  $('section-filter').hidden = true;
  $('stories').classList.remove('is-filtered');
  $('stories').replaceChildren(...Array.from({ length: tablet.matches ? 7 : 3 }, card));
  $('stories').setAttribute('aria-busy', 'true');
}

async function renderMissing(date, reason) {
  trackReading([]);
  const stories = $('stories');
  stories.setAttribute('aria-busy', 'false');
  stories.classList.remove('is-filtered');
  $('section-filter').hidden = true;
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
  renderSectionFilter(date, stories);

  const list = $('stories');
  list.setAttribute('aria-busy', 'false');
  if (!stories.length) {
    trackReading([]);
    list.classList.remove('is-filtered');
    list.replaceChildren(el('li', { class: 'empty' }, el('h2', {}, 'No stories'), el('p', {}, 'This day’s briefing has no stories.')));
    return;
  }
  renderStoryList(date, stories);
  document.title = `${storyTitle(stories[0])} — Daily News, ${formatDate(date, 'short')}`;
}

// The story list for the current section filter. Stories keep their day rank (ids, share links
// and the day in brief point at it); a filtered view lays them out as rows.
function renderStoryList(date, stories) {
  const list = $('stories');
  trackReading([]);
  const ranked = stories.map((topic, i) => ({ topic, rank: i + 1 }));
  const visible = sectionFilter ? ranked.filter(({ topic }) => topic.section === sectionFilter) : ranked;
  list.classList.toggle('is-filtered', Boolean(sectionFilter));
  list.replaceChildren(...visible.map(({ topic, rank }) => renderStory(date, topic, rank, sectionFilter ? 'row' : tierOf(rank))));

  storyParams = new WeakMap();
  trackReading(visible.map(({ topic, rank }) => {
    const story = $(`story-${rank}`);
    const params = analyticsParams(date, topic, rank);
    storyParams.set(story, params);
    const onRead = () => {
      if (topic.id) toWorker({ type: 'story-read', date, id: topic.id });
      noteStoryRead();
    };
    return { el: story, params, onRead };
  }));
}

// Chips for the day's sections (only when there are at least two), in a fixed order. A filter
// the day has no story for falls back to all. Built once per day; a tap only flips the pressed
// state, so the row keeps its scroll position.
function renderSectionFilter(date, stories) {
  const box = $('section-filter');
  const counts = new Map();
  for (const topic of stories) {
    if (SECTION_LABELS[topic.section]) counts.set(topic.section, (counts.get(topic.section) || 0) + 1);
  }
  if (sectionFilter && !counts.has(sectionFilter)) sectionFilter = null;
  box.hidden = counts.size < 2;
  if (box.hidden) {
    sectionFilter = null;
    box.replaceChildren();
    return;
  }
  const chip = (section, label, count) => el('button', {
    class: 'section-chip',
    type: 'button',
    'data-section': section || '',
    'aria-pressed': String(sectionFilter === section),
    onclick: event => selectSection(date, stories, section, event.currentTarget),
  }, label, el('span', { class: 'section-chip-count' }, String(count)));
  box.replaceChildren(
    chip(null, 'All', stories.length),
    ...Object.keys(SECTION_LABELS).filter(section => counts.has(section))
      .map(section => chip(section, SECTION_LABELS[section], counts.get(section))),
  );
  const active = box.querySelector('[aria-pressed="true"]');
  if (active) centerChip(box, active, 'instant');
}

// The chip changes at once; the old list fades out quickly and the new one rises in. A second
// tap during the fade takes over from wherever the first one is.
let filterChange = 0;
async function selectSection(date, stories, section, chip) {
  if (sectionFilter === section) return;
  sectionFilter = section;
  trackEvent('section_filter', { section: section || 'all', story_date: date });
  const box = $('section-filter');
  for (const button of box.children) button.setAttribute('aria-pressed', String(button === chip));
  centerChip(box, chip, reducedMotion.matches ? 'instant' : 'smooth');

  const list = $('stories');
  const change = ++filterChange;
  if (canAnimate()) {
    const opacity = getComputedStyle(list).opacity;
    list.getAnimations().forEach(animation => animation.cancel());
    await settled(list.animate([{ opacity }, { opacity: 0 }], { ...MOTION.exit, duration: 100, fill: 'forwards' }), 100);
    if (change !== filterChange) return;
  }

  // The chips stay where they were on screen while the list below changes length.
  const before = box.getBoundingClientRect().top;
  renderStoryList(date, stories);
  const shift = box.getBoundingClientRect().top - before;
  if (Math.abs(shift) > 1) window.scrollBy({ top: shift, behavior: 'instant' });
  list.getAnimations().forEach(animation => animation.cancel());
  revealStories();
}

// Horizontal scroll of the chip row only (scrollIntoView could also move the page).
function centerChip(box, chip, behavior) {
  if (box.scrollWidth <= box.clientWidth) return;
  box.scrollTo({ left: chip.offsetLeft - (box.clientWidth - chip.offsetWidth) / 2, behavior });
}

// New content (a filter change, or the day replacing its skeleton): the first stories fade up in
// a short stagger; with `intro`, the heading, day in brief and chips fade in with them.
function revealStories({ intro = false } = {}) {
  if (!canAnimate()) return;
  if (intro) {
    ['intro', 'section-filter'].map($).filter(node => !node.hidden)
      .forEach(node => node.animate([{ opacity: 0 }, { opacity: 1 }], MOTION.enter));
  }
  [...$('stories').children].forEach((slot, i) => {
    if (slot.getBoundingClientRect().top > innerHeight) return;
    slot.animate(
      [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }],
      { ...MOTION.enter, delay: Math.min(i, 5) * 30, fill: 'backwards' },
    );
  });
}

// GA4 event parameters describing a story (register them as custom dimensions in GA).
// Keywords are the topic's top TF-IDF terms, the closest thing to a subject per story.
function analyticsParams(date, topic, rank) {
  return {
    story_date: date,
    story_rank: rank,
    story_title: storyTitle(topic).slice(0, 100),
    story_category: topic.category || 'none',
    story_section: topic.section || 'none',
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
  // A link to a story the section filter hides (day in brief, contents) shows all stories again.
  if (!$(`story-${rank}`) && sectionFilter && current.data) {
    sectionFilter = null;
    renderStories(current.date, current.data);
  }
  const story = $(`story-${rank}`);
  if (!story) return;
  const smooth = !instant && !reducedMotion.matches;
  const header = document.querySelector('.site-header')?.getBoundingClientRect().bottom || 0;
  const moves = Math.abs(story.getBoundingClientRect().top - header) > 24;
  story.scrollIntoView({ behavior: smooth ? 'smooth' : 'instant', block: 'start' });
  story.focus({ preventScroll: true });
  markArrival(story, smooth && moves);
}

// After a jump (contents, day in brief, shared link) the story the reader landed on glows briefly,
// once the scroll has come to rest. It is a colour change only, so it also shows with reduced motion.
function markArrival(story, afterScroll) {
  const show = () => {
    story.classList.remove('is-arriving');
    void story.offsetWidth; // restart the animation on a repeated jump
    story.classList.add('is-arriving');
  };
  if (!afterScroll) return requestAnimationFrame(show);
  let done = false;
  const once = () => {
    if (done) return;
    done = true;
    removeEventListener('scrollend', once);
    show();
  };
  // No scrollend when the story was already in place (or in older browsers): a timeout stands in.
  if ('onscrollend' in window) addEventListener('scrollend', once);
  setTimeout(once, 'onscrollend' in window ? 2000 : 700);
}
document.addEventListener('animationend', event => {
  if (event.animationName === 'story-arrive') event.target.classList.remove('is-arriving');
});

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
      && !event.target.closest('input, .date-picker, .overview-list, .section-filter')
      && !scrollsSideways(event.target)
      ? { x: touch.clientX, y: touch.clientY, time: event.timeStamp, scrollY }
      : null;
  }, { passive: true });
  addEventListener('touchcancel', () => { start = null; }, { passive: true });
  addEventListener('touchend', event => {
    if (!start) return;
    const touch = event.changedTouches[0];
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    const quick = event.timeStamp - start.time < 700;
    // A vertical scroll that drifts sideways is not a swipe: it must be clearly horizontal and
    // must not have moved the page.
    const scrolled = Math.abs(scrollY - start.scrollY) > 8;
    start = null;
    if (scrolled || !quick || Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dx) < 3 * Math.abs(dy)) return;
    if (!document.getSelection()?.isCollapsed) return;
    const target = $(dx > 0 ? 'nav-prev' : 'nav-next').getAttribute('href');
    if (target) location.hash = target.slice(1);
  }, { passive: true });
}

// A swipe that starts in a sideways scroller (chips, wide tables) scrolls it, never changes the day.
function scrollsSideways(node) {
  for (let current = node instanceof Element ? node : null; current && current !== document.body; current = current.parentElement) {
    if (current.scrollWidth > current.clientWidth + 1 && /auto|scroll/.test(getComputedStyle(current).overflowX)) return true;
  }
  return false;
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

// The offline notice opens and closes in place (height and fade together), so the page below
// glides instead of jumping by its height. It keeps its text until it has closed.
function updateNotice() {
  const notice = $('notice');
  const offline = !navigator.onLine;
  if (offline) notice.textContent = 'You’re offline — showing a saved copy.';
  const shown = !notice.hidden && !notice.dataset.closing;
  if (offline === shown) return;
  notice.getAnimations().forEach(animation => animation.cancel());
  delete notice.dataset.closing;
  if (!canAnimate() || !current.date) {
    notice.hidden = !offline;
    return;
  }
  notice.hidden = false;
  const style = getComputedStyle(notice);
  const open = {
    height: `${notice.offsetHeight}px`, marginTop: style.marginTop, paddingTop: style.paddingTop,
    paddingBottom: style.paddingBottom, opacity: 1, overflow: 'clip',
  };
  const closed = { height: '0px', marginTop: '0px', paddingTop: '0px', paddingBottom: '0px', opacity: 0, overflow: 'clip' };
  if (offline) {
    notice.animate([closed, open], MOTION.resize);
    return;
  }
  notice.dataset.closing = '1';
  settled(notice.animate([open, closed], { ...MOTION.resize, duration: 220, fill: 'forwards' }), 220).then(() => {
    if (!notice.dataset.closing) return;
    delete notice.dataset.closing;
    notice.hidden = true;
    notice.getAnimations().forEach(animation => animation.cancel());
  });
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
    return Promise.resolve(update()).catch(() => {});
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
  const direction = previous && date > previous ? 'forward' : 'backward';
  if (!previous && !restoreScroll) restoreScroll = takeReloadScroll();

  // The skeleton only appears when a day is slow, the first visit included: a day that arrives
  // quickly (cached or prefetched) is shown directly instead of flashing a placeholder first.
  // A slow day change slides the skeleton in, so the reader sees the move at once.
  const nav = navContext(date);
  let skeleton = false;
  const showSkeleton = () => {
    if (current.date !== date) return;
    skeleton = true;
    const show = () => {
      renderSkeleton();
      window.scrollTo({ top: 0, behavior: 'instant' });
    };
    if (previous) swapDay(direction, show);
    else show();
    nav.then(context => current.date === date && renderNav(date, context));
  };
  const timer = setTimeout(showSkeleton, SKELETON_DELAY_MS);

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

  const update = async () => {
    renderNav(date, context);
    if (data) renderStories(date, data);
    else await renderMissing(date, error);
    if (restoreScroll) restoreScroll();
    // 'instant': html has scroll-behavior: smooth, which would scroll the whole new day past
    // the reader while it slides in.
    else if (previous) window.scrollTo({ top: 0, behavior: 'instant' });
  };
  if (previous && !skeleton) await swapDay(direction, update);
  else {
    await update();
    // The skeleton gives way to the day with a short fade instead of a hard swap.
    if (skeleton) revealStories({ intro: true });
  }
  return Boolean(data);
}

// A new deploy reloads the page while it is in the background (see index.html), saving where the
// reader was; the reloaded page goes back there instead of starting at the top.
function takeReloadScroll() {
  let saved = null;
  try {
    saved = JSON.parse(sessionStorage.getItem('reload-scroll') || 'null');
    sessionStorage.removeItem('reload-scroll');
  } catch { /* storage unavailable */ }
  if (!saved || saved.hash !== location.hash || !(saved.y > 0)) return null;
  return () => window.scrollTo({ top: saved.y, behavior: 'instant' });
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
    // From here on, things that appear within the page may animate (see .is-ready in the CSS).
    requestAnimationFrame(() => document.documentElement.classList.add('is-ready'));
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
setupInstall();
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
