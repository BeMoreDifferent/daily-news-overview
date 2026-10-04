// The site loads publisher pictures as anonymous CORS requests (no cookies, no referrer). Hosts
// that do not allow that, and dead links, fail in the browser, and every failure is logged as an
// error in the page console. Exported briefings therefore only keep pictures that would load:
// each is requested once, the way the page would, and dropped unless it answers with an image
// that allows the site's origin.

const SITE_ORIGIN = process.env.SITE_ORIGIN || 'https://bemoredifferent.github.io';
const CHECK_TIMEOUT_MS = Number(process.env.IMAGE_CHECK_TIMEOUT_MS || 6000);
const CHECK_CONCURRENCY = 8;

// The page upgrades http pictures to https (mixed content); check the URL it will request.
export function pageImageUrl(url) {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return null;
    u.protocol = 'https:';
    return u.href;
  } catch {
    return null;
  }
}

/**
 * True when `url` serves an image that an anonymous CORS request from `origin` may read.
 * After a cross-origin redirect the browser sends Origin: null, so only `*` passes then.
 */
export async function isLoadableImage(url, { origin = SITE_ORIGIN, timeoutMs = CHECK_TIMEOUT_MS, fetchImpl = fetch } = {}) {
  let res;
  try {
    res = await fetchImpl(url, {
      headers: { Origin: origin, Accept: 'image/avif,image/webp,image/*;q=0.8' },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return false;
  }
  try {
    const allow = res.headers.get('access-control-allow-origin');
    const type = res.headers.get('content-type') || '';
    return res.ok && type.startsWith('image/') && (allow === '*' || (allow === origin && !res.redirected));
  } finally {
    res.body?.cancel().catch(() => {});
  }
}

/**
 * Remove (in place) the `image` of every article whose picture would not load on the site, and
 * store the https URL the page requests for those that would. Returns { checked, kept }.
 */
export async function dropUnloadableImages(topics, options = {}) {
  const articles = topics.flatMap(topic => topic.articles || []).filter(article => article.image);
  const verdicts = new Map();
  for (const article of articles) {
    const url = pageImageUrl(article.image);
    if (url && !verdicts.has(url)) verdicts.set(url, null);
  }

  const queue = [...verdicts.keys()];
  const worker = async () => {
    while (queue.length) {
      const url = queue.shift();
      verdicts.set(url, await isLoadableImage(url, options));
    }
  };
  await Promise.all(Array.from({ length: Math.min(CHECK_CONCURRENCY, queue.length) }, worker));

  let kept = 0;
  for (const article of articles) {
    const url = pageImageUrl(article.image);
    if (url && verdicts.get(url)) {
      article.image = url;
      kept += 1;
    } else {
      delete article.image;
    }
  }
  return { checked: verdicts.size, kept };
}
