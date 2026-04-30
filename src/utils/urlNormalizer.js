/**
 * Normalizes a URL for stable dedupe.
 * @param {string} url - The URL to normalize
 * @returns {string} The normalized URL
 */
export function normalizeUrl(url) {
  if (!url) return url;

  try {
    const urlObj = new URL(url);

    if (urlObj.hostname.includes('youtube.com') || urlObj.hostname.includes('youtu.be')) {
      const videoId = urlObj.searchParams.get('v');
      const timestamp = urlObj.searchParams.get('t');

      urlObj.search = '';

      if (videoId) {
        urlObj.searchParams.set('v', videoId);
      }
      if (timestamp) {
        urlObj.searchParams.set('t', timestamp);
      }

      return urlObj.toString();
    }

    if (urlObj.hostname.includes('bbc.com')) {
      if (urlObj.pathname.includes('/articles/')) {
        const match = urlObj.pathname.match(/\/articles\/([^/]+)/);
        if (match) {
          return `https://www.bbc.com/news/articles/${match[1]}`;
        }
      }
      if (urlObj.pathname.includes('/videos/')) {
        const match = urlObj.pathname.match(/\/videos\/([^/]+)/);
        if (match) {
          return `https://www.bbc.com/news/videos/${match[1]}`;
        }
      }
    }

    urlObj.search = '';
    urlObj.hash = '';

    let normalizedUrl = urlObj.toString();
    if (normalizedUrl.endsWith('/') && normalizedUrl.length > 1) {
      normalizedUrl = normalizedUrl.slice(0, -1);
    }

    return normalizedUrl.toLowerCase();
  } catch {
    return url;
  }
}

