// Google Analytics 4 behind an opt-in consent banner (GDPR, § 25 TDDDG).
//
// Until the reader chooses, Google is not contacted at all: gtag.js is loaded only after a choice.
//  - Accept:  analytics_storage granted. GA sets its _ga cookies to recognise repeat visits.
//  - Decline: Consent Mode with every storage type denied. No cookies or identifiers are stored;
//             gtag sends cookieless pings that GA only uses in aggregate.
// Advertising features are always off: no Google signals, no ad personalisation, ad data redacted.
// The choice is kept in localStorage (strictly necessary to remember it) and can be changed at any
// time from "Privacy settings" in the footer or via #privacy-settings, e.g. from privacy.html.

const MEASUREMENT_ID = 'G-JG3KGGEV2T';
// Bump when the banner text or the processing changes materially, so everyone is asked again.
const CONSENT_KEY = 'analytics-consent-v1';
const SETTINGS_HASH = '#privacy-settings';

let loaded = false;

function storedChoice() {
  try {
    const value = localStorage.getItem(CONSENT_KEY);
    return value === 'granted' || value === 'denied' ? value : null;
  } catch {
    return null;
  }
}

function storeChoice(choice) {
  try {
    localStorage.setItem(CONSENT_KEY, choice);
  } catch { /* storage blocked: the banner asks again next visit */ }
}

function gtag() {
  // gtag.js reads the arguments object, not an array; keep the classic signature.
  window.dataLayer.push(arguments);
}

function loadGtag(choice) {
  if (loaded) return;
  loaded = true;
  window.dataLayer = window.dataLayer || [];
  gtag('consent', 'default', {
    analytics_storage: choice,
    ad_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied',
  });
  gtag('set', 'ads_data_redaction', true);
  gtag('js', new Date());
  // The app routes by hash, so page views are sent by trackPageView, not on load.
  gtag('config', MEASUREMENT_ID, {
    send_page_view: false,
    allow_google_signals: false,
    allow_ad_personalization_signals: false,
  });
  const script = document.createElement('script');
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${MEASUREMENT_ID}`;
  document.head.append(script);
}

// _ga and _ga_<container> are set on the widest domain GA could write to; try every level.
function deleteGaCookies() {
  const names = document.cookie.split(';').map(c => c.split('=')[0].trim()).filter(n => n.startsWith('_ga'));
  const parts = location.hostname.split('.');
  const domains = [''];
  for (let i = 0; i < parts.length - 1; i++) domains.push(`; domain=.${parts.slice(i).join('.')}`);
  for (const name of names) {
    for (const domain of domains) {
      document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/${domain}`;
    }
  }
}

export function trackPageView() {
  if (!loaded) return;
  gtag('event', 'page_view', {
    page_location: location.href,
    page_title: document.title,
  });
}

export function trackEvent(name, params = {}) {
  if (loaded) gtag('event', name, params);
}

function applyChoice(choice) {
  const previous = storedChoice();
  storeChoice(choice);
  if (!loaded) {
    loadGtag(choice);
    trackPageView(); // the page the reader made the choice on
    return;
  }
  if (choice === previous) return;
  gtag('consent', 'update', { analytics_storage: choice });
  if (choice === 'denied') deleteGaCookies();
}

function showBanner(banner, { focus = false } = {}) {
  banner.hidden = false;
  const choice = storedChoice();
  banner.querySelectorAll('[data-consent]').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.consent === choice));
  });
  if (focus) banner.querySelector('[data-consent]').focus();
}

export function setupAnalytics() {
  const banner = document.getElementById('consent');
  if (!banner) return;

  banner.addEventListener('click', event => {
    const button = event.target.closest('[data-consent]');
    if (!button) return;
    applyChoice(button.dataset.consent);
    banner.hidden = true;
  });

  document.getElementById('privacy-settings')?.addEventListener('click', () => showBanner(banner, { focus: true }));

  const openFromHash = () => {
    if (location.hash !== SETTINGS_HASH) return;
    history.replaceState(history.state, '', location.pathname + location.search);
    showBanner(banner, { focus: true });
  };
  window.addEventListener('hashchange', openFromHash);

  const choice = storedChoice();
  if (choice) loadGtag(choice);
  else showBanner(banner);
  openFromHash();
}
