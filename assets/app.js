const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CACHE_KEY = 'latest-date';
const MAX_PROBE = 60;
// Coverage rows visible per story on phones before "Show more"; the rest stay one tap away.
const COMPACT_SOURCES = 3;
// Feed "images" that are video files, icons or logos would render as broken or meaningless boxes.
const NON_PHOTO_RE = /\.(mp4|webm|mov|m3u8|gif|svg)$|(^|[/_-])(icon|logo|avatar|favicon|sprite|pixel)s?([/_.-]|$)/i;

const $ = id => document.getElementById(id);
const tablet = window.matchMedia('(min-width: 640px)');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

let current = { date: null, data: null };
let spy = null;

// ── Dates ────────────────────────────────────────────────────────────────────

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

async function fileExists(date) {
  try {
    const res = await fetch(`news/${date}.json`, { method: 'GET' });
    return res.ok;
  } catch {
    return false;
  }
}

// news/index.json lists every exported date; null when missing (older deployments), in which
// case the viewer falls back to probing files day by day.
let indexPromise = null;
function loadIndex() {
  if (!indexPromise) {
    indexPromise = fetch('news/index.json')
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

async function renderNav(date) {
  const button = $('date-button');
  button.textContent = formatDate(date, 'short');
  button.setAttribute('aria-label', `Choose a date. Showing ${formatDate(date)}`);
  $('date-input').value = date;

  const [{ prev, next }, dates] = await Promise.all([neighbours(date), loadIndex()]);
  if (date !== current.date) return; // user navigated on while we were waiting
  setNavLink($('nav-prev'), prev);
  setNavLink($('nav-next'), next);
  $('nav-prev').setAttribute('aria-label', prev ? `Previous day, ${formatDate(prev)}` : 'Previous day');
  $('nav-next').setAttribute('aria-label', next ? `Next day, ${formatDate(next)}` : 'Next day');

  const latest = dates?.[dates.length - 1];
  $('nav-latest').hidden = !latest || latest === date;
  if (dates?.length) {
    $('date-input').min = dates[0];
    $('date-input').max = latest;
  }

  // Warm the cache so stepping back a day is instant.
  if (prev) (window.requestIdleCallback || setTimeout)(() => fetch(`news/${prev}.json`).catch(() => {}));
}

function renderIntro(date, data, stories) {
  $('briefing-date').textContent = formatDate(date);
  const outlets = new Set(stories.flatMap(t => t.articles.map(a => domainOf(a.url)).filter(Boolean)));
  const updated = formatUpdated(data?.generated_at);
  $('briefing-meta').textContent = stories.length
    ? [`${stories.length} ${stories.length === 1 ? 'story' : 'stories'}`, `${outlets.size} outlets`, updated && `Updated ${updated}`]
      .filter(Boolean).join(' · ')
    : '';
  $('briefing-note').hidden = !stories.some(t => t.summary);
  $('footer-meta').textContent = updated ? `Briefing generated ${updated}` : '';
}

function renderToc(date, stories) {
  const build = () => stories.map((topic, i) => el('li', {},
    el('a', { href: storyHash(date, i + 1), 'data-rank': i + 1 },
      el('span', { class: 'toc-rank', 'aria-hidden': 'true' }, String(i + 1)),
      el('span', { class: 'toc-title' }, storyTitle(topic)),
    ),
  ));
  $('toc-rail').replaceChildren(...build());
  $('toc-list').replaceChildren(...build());
  $('toc-count').textContent = `(${stories.length})`;
  const inline = $('toc-inline');
  inline.hidden = stories.length === 0;
  inline.open = tablet.matches;
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
  const img = el('img', {
    src: candidates[0].src,
    alt: '',
    loading: isLead ? 'eager' : 'lazy',
    fetchpriority: isLead ? 'high' : null,
    decoding: 'async',
    referrerpolicy: 'no-referrer',
  });
  const figure = el('figure', { class: 'story-media' }, img, caption);
  img.addEventListener('error', () => {
    index += 1;
    if (index < candidates.length) {
      img.src = candidates[index].src;
      caption.textContent = `Image: ${candidates[index].credit || 'publisher'}`;
    } else {
      figure.closest('.story')?.classList.remove('has-media');
      figure.remove();
    }
  });
  return figure;
}

function renderCoverage(topic, story) {
  const items = topic.articles.map((article, i) => {
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
    return el('li', { class: i >= COMPACT_SOURCES ? 'is-extra' : null }, row);
  });

  const list = el('ul', { class: 'coverage', role: 'list', 'aria-label': 'Coverage' }, ...items);
  const extra = items.length - COMPACT_SOURCES;
  if (extra <= 0) return [list];

  const more = el('button', {
    class: 'coverage-more',
    type: 'button',
    'aria-expanded': 'false',
    onclick: () => {
      const expanded = story.classList.toggle('is-expanded');
      more.setAttribute('aria-expanded', String(expanded));
      more.textContent = expanded ? 'Show fewer' : `Show ${extra} more ${extra === 1 ? 'outlet' : 'outlets'}`;
      if (expanded) items[COMPACT_SOURCES].querySelector('a, div')?.focus();
    },
  }, `Show ${extra} more ${extra === 1 ? 'outlet' : 'outlets'}`);
  return [list, more];
}

function renderStory(date, topic, rank) {
  const title = storyTitle(topic);
  const isLead = rank === 1;
  const story = el('article', {
    class: `story${isLead ? ' story--lead' : ''}`,
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
  return el('li', {}, story);
}

function renderSkeleton() {
  const block = cls => el('span', { class: `skeleton ${cls}` });
  const card = () => el('li', { 'aria-hidden': 'true' },
    el('div', { class: 'story story--skeleton' },
      block('sk-kicker'), block('sk-title'), block('sk-title sk-short'),
      block('sk-line'), block('sk-line'), block('sk-line sk-short'),
    ),
  );
  $('stories').replaceChildren(card(), card(), card());
  $('stories').setAttribute('aria-busy', 'true');
}

async function renderMissing(date, reason) {
  const stories = $('stories');
  stories.setAttribute('aria-busy', 'false');
  renderIntro(date, null, []);
  renderToc(date, []);
  $('rail-heading').parentElement.hidden = true;

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
  renderIntro(date, data, stories);
  renderToc(date, stories);
  $('rail-heading').parentElement.hidden = stories.length === 0;

  const list = $('stories');
  list.setAttribute('aria-busy', 'false');
  if (!stories.length) {
    list.replaceChildren(el('li', { class: 'empty' }, el('h2', {}, 'No stories'), el('p', {}, 'This day’s briefing has no stories.')));
    return;
  }
  list.replaceChildren(...stories.map((topic, i) => renderStory(date, topic, i + 1)));
  document.title = `${storyTitle(stories[0])} — Daily News, ${formatDate(date, 'short')}`;
  watchScroll(stories.length);
}

// ── Interaction ──────────────────────────────────────────────────────────────

async function shareStory(date, rank, title) {
  const url = location.href.split('#')[0] + storyHash(date, rank);
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
  story.scrollIntoView({ behavior: instant || reducedMotion.matches ? 'auto' : 'smooth', block: 'start' });
  story.focus({ preventScroll: true });
}

// Scroll-spy: highlight the story currently being read in the desktop contents rail.
function watchScroll(count) {
  spy?.disconnect();
  const links = [...$('toc-rail').querySelectorAll('a')];
  const setCurrent = rank => links.forEach(a => {
    if (a.dataset.rank === String(rank)) a.setAttribute('aria-current', 'true');
    else a.removeAttribute('aria-current');
  });
  setCurrent(1);
  spy = new IntersectionObserver(entries => {
    const visible = entries.filter(e => e.isIntersecting).map(e => +e.target.id.split('-')[1]);
    if (visible.length) setCurrent(Math.min(...visible));
  }, { rootMargin: '-20% 0px -70% 0px' });
  for (let rank = 1; rank <= count; rank++) spy.observe($(`story-${rank}`));
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
    if (!DATE_RE.test(picked) || picked === current.date) return;
    const dates = await loadIndex();
    // Snap to the closest earlier briefing (or the first one) when the picked day has none.
    const target = dates ? (dates.filter(d => d <= picked).pop() || dates[0]) : picked;
    if (dates && target !== picked) toast(`No briefing on ${formatDate(picked, 'short')} — showing ${formatDate(target, 'short')}`);
    location.hash = target;
  });
}

// Following the same contents link twice fires no hashchange; scroll anyway.
function setupTocClicks() {
  for (const list of [$('toc-rail'), $('toc-list')]) {
    list.addEventListener('click', event => {
      const link = event.target.closest('a[data-rank]');
      if (link && link.getAttribute('href') === location.hash) {
        event.preventDefault();
        focusStory(link.dataset.rank);
      }
    });
  }
}

function updateNotice() {
  const notice = $('notice');
  notice.hidden = navigator.onLine;
  notice.textContent = navigator.onLine ? '' : 'You’re offline — showing a saved copy.';
}

// ── Routing: #YYYY-MM-DD or #YYYY-MM-DD/<rank> ───────────────────────────────

function parseHash() {
  const [date, rank] = location.hash.slice(1).split('/');
  return { date: DATE_RE.test(date) ? date : null, rank: /^\d{1,2}$/.test(rank || '') ? +rank : null };
}

async function loadDate(date) {
  current = { date, data: null };
  document.title = `Daily News — ${formatDate(date, 'short')}`;
  renderSkeleton();
  renderNav(date);

  let data;
  try {
    const res = await fetch(`news/${date}.json`);
    if (res.status === 503) throw new Error('offline');
    if (!res.ok) throw new Error('not_found');
    data = await res.json();
  } catch (err) {
    if (current.date === date) await renderMissing(date, err.message);
    return false;
  }
  if (current.date !== date) return false;
  current.data = data;
  renderStories(date, data);
  return true;
}

async function route() {
  let { date, rank } = parseHash();
  const toLatest = !date;
  if (!date) {
    date = await findLatestDate();
    if (!date) {
      $('stories').setAttribute('aria-busy', 'false');
      $('stories').replaceChildren(el('li', { class: 'empty' }, el('h2', {}, 'No briefings yet'), el('p', {}, 'Check back tomorrow.')));
      return;
    }
    history.replaceState(null, '', '#' + date);
  }

  if (date !== current.date) {
    const isNewDay = current.date !== null;
    const loaded = await loadDate(date);
    if (loaded && rank) return focusStory(rank, { instant: true });
    if (isNewDay) window.scrollTo({ top: 0 });
    return;
  }
  if (rank) focusStory(rank);
  else if (toLatest) window.scrollTo({ top: 0, behavior: reducedMotion.matches ? 'auto' : 'smooth' });
}

setupDatePicker();
setupTocClicks();
updateNotice();
window.addEventListener('online', updateNotice);
window.addEventListener('offline', updateNotice);
window.addEventListener('hashchange', route);
route();
