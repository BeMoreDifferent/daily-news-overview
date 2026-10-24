// "Add to home screen" promotion for phones and tablets.
//
// Only Chromium browsers (Chrome, Edge, Samsung Internet) offer an install prompt the page can open
// (beforeinstallprompt). Everywhere else the reader installs from the browser's own menus, so the
// page explains the steps instead: Safari and the other iOS browsers (Share → Add to Home Screen;
// on iOS 26 Share sits behind •••), and Firefox on Android (menu). In-app browsers (Instagram,
// Facebook, TikTok, …) cannot install web apps at all; there the reader is sent to a real browser.
//
// The banner never appears on the first page load: a returning reader sees it once they have read
// a story, a new one after reading several. It waits until the consent banner is answered. "Not
// now" snoozes it for 30 days, then 90; after the third dismissal it stays away. "Install app" in
// the footer is always there while installing is possible. Nothing is shown inside the installed
// app. State stays in localStorage (see privacy.html) and never leaves the device.

import { trackEvent } from './analytics.js?v=27';

const STATE_KEY = 'install-prompt';
const SNOOZE_DAYS = [30, 90];
const MAX_DISMISSALS = 3;
// Stories read (5 s in the reading band, see analytics.js) before the banner may appear.
const READS_RETURNING = 1;
const READS_FIRST_VISIT = 3;

const $ = id => document.getElementById(id);
const ua = navigator.userAgent;
const isIOS = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
const isIPad = isIOS && !/iPhone|iPod/.test(ua);
const isAndroid = /Android/.test(ua);
// In-app browsers: known app tokens, Android WebViews ("; wv)") and iOS web views, which lack the
// "Safari/" token every iOS browser sends.
const isInApp = /FBAN|FBAV|FB_IAB|Instagram|LinkedInApp|Line\/|Snapchat|musical_ly|BytedanceWebview|TikTok|GSA\//.test(ua)
  || (isAndroid && /; wv\)/.test(ua))
  || (isIOS && !/Safari\//.test(ua));

const standalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

// Safari 26 froze the OS version in its user agent; its own Version/ token still counts up.
function iosBrowser() {
  if (/CriOS\//.test(ua)) return 'chrome';
  if (/FxiOS\//.test(ua)) return 'firefox';
  if (/EdgiOS\//.test(ua)) return 'edge';
  if (/OPT\/|YaBrowser|DuckDuckGo|Ddg\//.test(ua)) return 'other';
  return Number(ua.match(/Version\/(\d+)/)?.[1]) >= 26 ? 'safari26' : 'safari';
}

function readState() {
  try {
    const state = JSON.parse(localStorage.getItem(STATE_KEY));
    return state && typeof state === 'object' ? state : {};
  } catch {
    return {};
  }
}

function writeState(patch) {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify({ ...readState(), ...patch }));
  } catch { /* storage unavailable (private mode): the banner may come back next visit */ }
}

// ── Icons (static markup) ────────────────────────────────────────────────────

const svg = body => `<svg class="install-icon" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const ICON = {
  share: svg('<path d="M12 3v12M7 8l5-5 5 5M5 13v6a2 2 0 002 2h10a2 2 0 002-2v-6"/>'),
  add: svg('<rect x="3" y="3" width="18" height="18" rx="4"/><path d="M12 8v8M8 12h8"/>'),
  more: svg('<circle cx="5" cy="12" r="1.2" fill="currentColor"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/><circle cx="19" cy="12" r="1.2" fill="currentColor"/>'),
  menu: svg('<circle cx="12" cy="5" r="1.2" fill="currentColor"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/><circle cx="12" cy="19" r="1.2" fill="currentColor"/>'),
  burger: svg('<path d="M4 7h16M4 12h16M4 17h16"/>'),
  done: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
};

// Steps per browser: [icon, text] pairs. The text is plain; <b> marks the label to look for.
function steps(kind) {
  const add = [ICON.add, 'Scroll down and tap <b>Add to Home Screen</b>.'];
  switch (kind) {
    case 'safari26': return [
      [ICON.more, `Tap <b>•••</b> ${isIPad ? 'beside the address bar' : 'in the address bar'}, then <b>Share</b>. If you see the Share button in the toolbar, tap it directly.`],
      add,
      [ICON.done, 'Keep <b>Open as Web App</b> switched on and tap <b>Add</b>.'],
    ];
    case 'safari': return [
      [ICON.share, `Tap the <b>Share</b> button ${isIPad ? 'at the top of the screen' : 'in the toolbar at the bottom of the screen'}.`],
      add,
      [ICON.done, 'Tap <b>Add</b>.'],
    ];
    case 'chrome': return [[ICON.share, 'Tap the <b>Share</b> button in the address bar.'], add, [ICON.done, 'Tap <b>Add</b>.']];
    case 'edge': return [[ICON.more, 'Tap <b>•••</b>, then <b>Share</b>.'], add, [ICON.done, 'Tap <b>Add</b>.']];
    case 'firefox': return [[ICON.burger, 'Tap the <b>menu</b> button, then <b>Share</b>.'], add, [ICON.done, 'Tap <b>Add</b>.']];
    case 'android': return [
      [ICON.menu, 'Tap the browser’s <b>menu</b> button.'],
      [ICON.add, 'Tap <b>Add app to Home screen</b> (or <b>Install</b>).'],
      [ICON.done, 'Confirm with <b>Add</b>.'],
    ];
    default: return [[ICON.share, 'Open the browser’s <b>Share</b> menu.'], add, [ICON.done, 'Tap <b>Add</b>.']];
  }
}

// ── Setup ────────────────────────────────────────────────────────────────────

let promptEvent = null;
let kind = null; // 'prompt' | iOS browser | 'android' | 'inapp'
let reads = 0;
let returning = false;
let shownThisVisit = false;

function canInstall() {
  return !standalone() && !readState().installed && (kind !== 'prompt' || promptEvent !== null);
}

function updateFooter() {
  $('install-app').hidden = !kind || !canInstall();
}

// ── Banner ───────────────────────────────────────────────────────────────────

function mayShowBanner() {
  const state = readState();
  return (isIOS || isAndroid) && kind && kind !== 'inapp' && canInstall() && !shownThisVisit
    && (state.dismissals || 0) < MAX_DISMISSALS && Date.now() >= (state.snoozeUntil || 0)
    && reads >= (returning ? READS_RETURNING : READS_FIRST_VISIT)
    && $('consent').hidden && !document.querySelector('dialog[open]');
}

function showBanner() {
  if (!mayShowBanner()) return;
  shownThisVisit = true;
  const banner = $('install-banner');
  $('install-banner-action').textContent = kind === 'prompt' ? 'Install' : 'Show me how';
  banner.hidden = false;
  trackEvent('install_prompt', { install_step: 'shown', install_kind: kind });
}

function hideBanner() {
  $('install-banner').hidden = true;
}

function snooze() {
  const dismissals = (readState().dismissals || 0) + 1;
  const days = SNOOZE_DAYS[Math.min(dismissals, SNOOZE_DAYS.length) - 1];
  writeState({ dismissals, snoozeUntil: Date.now() + days * 864e5 });
}

// ── Install / instructions ───────────────────────────────────────────────────

async function install(source) {
  hideBanner();
  if (kind === 'prompt' && promptEvent) {
    const event = promptEvent;
    promptEvent = null; // a prompt can be shown once
    updateFooter();
    try {
      await event.prompt();
      const { outcome } = await event.userChoice;
      trackEvent('install_prompt', { install_step: outcome, install_kind: kind, install_source: source });
      if (outcome === 'dismissed' && source === 'banner') snooze();
    } catch { /* prompt unavailable */ }
    return;
  }
  // The instructions count as a showing: a reader who followed them is not asked again for a while.
  if (source === 'banner') snooze();
  trackEvent('install_prompt', { install_step: 'help', install_kind: kind, install_source: source });
  openHelp();
}

function openHelp() {
  const dialog = $('install-help');
  const body = $('install-help-body');
  if (kind === 'inapp') {
    $('install-help-title').textContent = 'Open in your browser to install';
    body.innerHTML = `<p class="install-help-text">This app’s built-in browser can’t add web apps to your home screen. Open this page in ${isIOS ? 'Safari' : 'Chrome'} first: tap <b>•••</b> or the share button and choose <b>Open in browser</b>, or copy the link and paste it there.</p>`;
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'btn';
    copy.textContent = 'Copy link';
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(location.href);
        copy.textContent = 'Link copied';
      } catch {
        copy.textContent = 'Copy the link from the address bar';
      }
    });
    body.append(copy);
  } else {
    $('install-help-title').textContent = 'Add Daily News to your home screen';
    // Static strings from steps(); no data is interpolated.
    body.innerHTML = `<ol class="install-steps" role="list">${steps(kind).map(([icon, text]) =>
      `<li><span class="install-step-icon">${icon}</span><span>${text}</span></li>`).join('')}</ol>`;
  }
  dialog.showModal();
}

function setupHelpDialog() {
  const dialog = $('install-help');
  dialog.addEventListener('click', event => {
    // A tap on the backdrop lands on the dialog element itself.
    if (event.target === dialog || event.target.closest('[data-close]')) dialog.close();
  });
}

// ── Engagement ───────────────────────────────────────────────────────────────

// Called by the page each time a story counts as read.
export function noteStoryRead() {
  reads += 1;
  showBanner();
}

function countVisit() {
  const today = new Date().toISOString().slice(0, 10);
  const { lastVisit } = readState();
  returning = Boolean(lastVisit) && lastVisit !== today;
  if (lastVisit !== today) writeState({ lastVisit: today });
}

export function setupInstall() {
  if (!$('install-banner')) return;
  setupHelpDialog();
  countVisit();

  if (isInApp) kind = 'inapp';
  else if (isIOS) kind = iosBrowser();
  else if (isAndroid && /Firefox\//.test(ua)) kind = 'android';
  else kind = 'prompt';

  // Chromium: keep the event and suppress the browser's own mini-infobar; the banner and the footer
  // button open the prompt from a tap. It may arrive late (after the browser's engagement check).
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    promptEvent = event;
    kind = 'prompt';
    // Chromium offers the prompt again after the app was uninstalled.
    if (readState().installed) writeState({ installed: false });
    updateFooter();
    showBanner();
  });
  window.addEventListener('appinstalled', () => {
    writeState({ installed: true });
    promptEvent = null;
    hideBanner();
    updateFooter();
    trackEvent('install_prompt', { install_step: 'installed', install_kind: kind });
  });

  $('install-banner-action').addEventListener('click', () => install('banner'));
  $('install-banner-close').addEventListener('click', () => {
    hideBanner();
    snooze();
    trackEvent('install_prompt', { install_step: 'not_now', install_kind: kind });
  });
  $('install-app').addEventListener('click', () => install('footer'));
  // The consent banner goes first; the install banner may follow once it is answered.
  $('consent').addEventListener('click', event => {
    if (event.target.closest('[data-consent]')) setTimeout(showBanner, 1500);
  });
  window.matchMedia('(display-mode: standalone)').addEventListener('change', () => { hideBanner(); updateFooter(); });

  updateFooter();
}
