const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CACHE_KEY = 'latest-date';
const MAX_PROBE = 60;

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

function shiftDate(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function formatDate(dateStr) {
  const [y, m, d] = dateStr.split('-');
  const dt = new Date(Date.UTC(+y, +m - 1, +d));
  return dt.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

function formatTime(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC';
}

async function fileExists(date) {
  try {
    const res = await fetch(`news/${date}.json`, { method: 'GET' });
    return res.ok;
  } catch {
    return false;
  }
}

async function findLatestDate() {
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

function hashDate() {
  const h = location.hash.slice(1);
  return DATE_RE.test(h) ? h : null;
}

function setNav(date, prevExists, nextExists) {
  document.getElementById('nav-date').textContent = date;

  const prev = document.getElementById('nav-prev');
  const next = document.getElementById('nav-next');

  if (prevExists) {
    prev.href = '#' + shiftDate(date, -1);
    prev.classList.remove('disabled');
    prev.removeAttribute('aria-disabled');
  } else {
    prev.removeAttribute('href');
    prev.classList.add('disabled');
    prev.setAttribute('aria-disabled', 'true');
  }

  if (nextExists) {
    next.href = '#' + shiftDate(date, 1);
    next.classList.remove('disabled');
    next.removeAttribute('aria-disabled');
  } else {
    next.removeAttribute('href');
    next.classList.add('disabled');
    next.setAttribute('aria-disabled', 'true');
  }
}

function capitalize(str) {
  return str ? str.charAt(0).toUpperCase() + str.slice(1) : str;
}

function renderTopics(data, content) {
  document.getElementById('footer-meta').textContent =
    `Generated ${new Date(data.generated_at).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })} UTC`;

  if (!data.topics || data.topics.length === 0) {
    content.innerHTML = '<p class="status">No topics for this date.</p>';
    return;
  }

  const frag = document.createDocumentFragment();

  for (const topic of data.topics) {
    if (!topic.articles || topic.articles.length === 0) continue;
    const article = topic.articles[0];

    const section = document.createElement('section');
    section.className = 'topic';

    // Topic header
    const header = document.createElement('div');
    header.className = 'topic-header';

    const labelEl = document.createElement('div');
    labelEl.className = 'topic-label';
    labelEl.textContent = (topic.label || []).join(', ');

    const titleEl = document.createElement('div');
    titleEl.className = 'topic-title';
    titleEl.textContent = capitalize(topic.label?.[0] || 'Topic');

    const metaEl = document.createElement('div');
    metaEl.className = 'topic-meta';

    const cat = document.createElement('span');
    cat.textContent = topic.category || '';

    const sources = document.createElement('span');
    sources.textContent = `${topic.source_count} source${topic.source_count !== 1 ? 's' : ''}`;

    const count = document.createElement('span');
    count.textContent = `${topic.article_count} article${topic.article_count !== 1 ? 's' : ''}`;

    metaEl.append(cat, sources, count);
    header.append(labelEl, titleEl, metaEl);

    // Article
    const articleEl = document.createElement('div');
    articleEl.className = 'article';

    if (article.image) {
      const imgWrap = document.createElement('div');
      imgWrap.className = 'article-image';
      const img = document.createElement('img');
      img.src = article.image;
      img.alt = '';
      img.loading = 'lazy';
      imgWrap.appendChild(img);
      articleEl.appendChild(imgWrap);
    }

    const body = document.createElement('div');
    body.className = 'article-body';

    const titleWrap = document.createElement('div');
    titleWrap.className = 'article-title';

    if (article.url) {
      const link = document.createElement('a');
      link.href = article.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = article.title;
      titleWrap.appendChild(link);
    } else {
      titleWrap.textContent = article.title;
    }

    const sourceEl = document.createElement('div');
    sourceEl.className = 'article-source';

    if (article.source) {
      const src = document.createElement('span');
      src.textContent = article.source;
      sourceEl.appendChild(src);
    }

    const t = formatTime(article.published_at);
    if (t) {
      const time = document.createElement('span');
      time.textContent = t;
      sourceEl.appendChild(time);
    }

    body.append(titleWrap, sourceEl);
    articleEl.appendChild(body);

    section.append(header, articleEl);
    frag.appendChild(section);
  }

  content.innerHTML = '';
  content.appendChild(frag);
}

async function loadDate(date) {
  const content = document.getElementById('content');
  document.title = `Daily News — ${date}`;
  content.innerHTML = '<p class="status">Loading&hellip;</p>';
  document.getElementById('nav-date').textContent = date;
  document.getElementById('footer-meta').textContent = '';

  let data;
  try {
    const res = await fetch(`news/${date}.json`);
    if (!res.ok) throw new Error('not_found');
    data = await res.json();
  } catch (err) {
    const isNotFound = err.message === 'not_found';
    content.innerHTML = isNotFound
      ? `<p class="error-msg">No news found for ${formatDate(date)}. <a href="#">Go to latest</a></p>`
      : `<p class="error-msg">Failed to load news for ${date}. Try refreshing.</p>`;
    setNav(date, false, false);
    return;
  }

  renderTopics(data, content);

  // Probe prev/next in parallel
  const prevDate = shiftDate(date, -1);
  const nextDate = shiftDate(date, 1);
  const [prevExists, nextExists] = await Promise.all([fileExists(prevDate), fileExists(nextDate)]);
  setNav(date, prevExists, nextExists);
}

async function route() {
  let date = hashDate();
  if (!date) {
    date = await findLatestDate();
    if (!date) {
      document.getElementById('content').innerHTML = '<p class="error-msg">No news files found.</p>';
      return;
    }
    history.replaceState(null, '', '#' + date);
  }
  await loadDate(date);
}

window.addEventListener('hashchange', route);
route();
