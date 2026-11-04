'use strict';

const $ = (selector, root = document) => root.querySelector(selector);
const app = $('#app');

// Kinds and roles come from the server (/api/meta), so every Roblox business type is offered in one place.
let meta = { kinds: [], roles: [], roleGroups: [] };
const KIND_LABELS = { airline: 'Airline', store: 'Roblox store', other: 'Organisation' };
const roleFilters = () => [['', 'All'], ...meta.roleGroups.map((g) => [g.key, g.label])];
const roleOptionsHtml = () => meta.roles.map((r) => `<option value="${esc(r.key)}">${esc(r.label)}</option>`).join('');
// Fallback until /api/meta answers, so the dropdown is never empty.
const FALLBACK_KINDS = [{ key: 'airline', label: 'Airline' }, { key: 'store', label: 'Roblox store' }, { key: 'other', label: 'Other organisation' }];
const kindOptionsHtml = () => (meta.kinds.length ? meta.kinds : FALLBACK_KINDS).map((k) => `<option value="${esc(k.key)}">${esc(k.label)}</option>`).join('');
async function loadMeta() {
  try {
    meta = await api('/api/meta');
  } catch {
    /* keep the defaults; the lists are empty until the server answers */
  }
}
const REDUCED_MOTION = matchMedia('(prefers-reduced-motion: reduce)');

// ---------- helpers ----------

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

// Escape first, then turn #hashtags into links. Tags are [A-Za-z0-9_] only, so nothing unsafe gets through.
const linkify = (text) =>
  esc(text).replace(/#([A-Za-z0-9_]{2,30})/g, (_, tag) => `<a class="tag-link" href="#/tag/${tag.toLowerCase()}">#${tag}</a>`);

// Links. Only https links are recognised. A link never opens straight away: it asks first,
// unless the host (or its kind, like video) is on the user's allowlist.
const URL_RE = /https:\/\/[^\s<>"']+/g;
const LINK_KIND_HOSTS = {
  video: ['youtube.com', 'youtu.be', 'vimeo.com', 'twitch.tv', 'tiktok.com'],
  social: ['x.com', 'twitter.com', 'instagram.com', 'facebook.com', 'reddit.com', 'bsky.app'],
  chat: ['discord.com', 'discord.gg', 'discordapp.com'],
  roblox: ['roblox.com', 'rbxcdn.com'],
};
const LINK_KIND_LABELS = { video: 'Video', social: 'Social', chat: 'Chat', roblox: 'Roblox', other: 'Other' };
const hostOf = (url) => {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
};
const kindOf = (host) =>
  Object.keys(LINK_KIND_HOSTS).find((k) => LINK_KIND_HOSTS[k].some((d) => host === d || host.endsWith(`.${d}`))) || 'other';
const cleanUrl = (u) => u.replace(/[).,!?;:]+$/, '');
const urlsIn = (text) => [...new Set([...String(text ?? '').matchAll(URL_RE)].map((m) => cleanUrl(m[0])))].filter((u) => hostOf(u));

function isAllowed(url) {
  const host = hostOf(url);
  const kind = kindOf(host);
  return (me.linkAllowlist || []).some((e) =>
    (e.scope === 'domain' && (host === e.value || host.endsWith(`.${e.value}`))) || (e.scope === 'kind' && e.value === kind));
}

// Text with hashtags, and each link shown as a button that asks before opening.
function richText(text) {
  const raw = String(text ?? '');
  let out = '';
  let last = 0;
  for (const m of raw.matchAll(URL_RE)) {
    const url = cleanUrl(m[0]);
    if (!hostOf(url)) continue;
    out += linkify(raw.slice(last, m.index));
    out += `<button class="ext-link" type="button" data-action="open-link" data-url="${esc(url)}">${esc(url.replace(/^https:\/\//, ''))}</button>`;
    last = m.index + url.length;
  }
  return out + linkify(raw.slice(last));
}

// One card per distinct link, shown under the text.
function linkCards(text) {
  const urls = urlsIn(text);
  if (!urls.length) return '';
  return `<div class="link-cards">${urls.map((url) => {
    const parsed = new URL(url);
    const host = hostOf(url);
    const kind = kindOf(host);
    const path = parsed.pathname.length > 1 ? parsed.pathname.slice(0, 60) : '';
    return `
      <button class="link-card" type="button" data-action="open-link" data-url="${esc(url)}">
        <span class="link-kind">${LINK_KIND_LABELS[kind]}</span>
        <span class="link-host">${esc(host)}</span>
        <span class="link-path">${esc(path)}</span>
        <span class="link-cta">${isAllowed(url) ? 'Opens directly' : 'Ask first'} ${icon('external', { size: 14 })}</span>
      </button>`;
  }).join('')}</div>`;
}

// The popup. Offers open once, or allow the host, or allow the whole kind of link.
function openLinkDialog(url) {
  const host = hostOf(url);
  const kind = kindOf(host);
  document.querySelector('.sheet-backdrop')?.remove();
  const wrap = document.createElement('div');
  wrap.className = 'sheet-backdrop';
  wrap.innerHTML = `
    <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="link-title">
      <p class="kicker">Leaving Jumpseat</p>
      <h2 id="link-title">Open this link?</h2>
      <p class="muted">This goes to <strong>${esc(host)}</strong>, outside Jumpseat. We can’t see what is there.</p>
      <div class="link-preview"><span class="link-kind">${LINK_KIND_LABELS[kind]}</span><code>${esc(url)}</code></div>
      <div class="sheet-actions">
        <button class="btn primary" data-link="open">Open once</button>
        ${me.user ? `
          <button class="btn secondary" data-link="domain">Always allow ${esc(host)}</button>
          <button class="btn secondary" data-link="kind">Allow all ${esc(LINK_KIND_LABELS[kind].toLowerCase())} links</button>` : ''}
        <button class="btn ghost" data-link="cancel">Cancel</button>
      </div>
      <p class="form-status" data-status></p>
    </div>`;
  document.body.appendChild(wrap);

  const close = () => {
    wrap.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);

  wrap.addEventListener('click', async (e) => {
    if (e.target === wrap) return close();
    const btn = e.target.closest('[data-link]');
    if (!btn) return;
    const choice = btn.dataset.link;
    if (choice === 'cancel') return close();
    try {
      if (choice === 'domain' || choice === 'kind') {
        me.linkAllowlist = await send('POST', '/api/me/link-allowlist', { scope: choice, value: choice === 'domain' ? host : kind });
        toast(choice === 'domain' ? `Allowed ${host}` : `Allowed ${LINK_KIND_LABELS[kind].toLowerCase()} links`);
      }
      window.open(url, '_blank', 'noopener,noreferrer');
      close();
    } catch (err) {
      wrap.querySelector('[data-status]').textContent = err.message;
    }
  });
  wrap.querySelector('[data-link="open"]').focus();
}

const loading = '<div class="skeleton" aria-busy="true" aria-label="Loading"><span></span><span></span><span></span></div>';
const errorBox = (message) => `<p class="error-box">${esc(message)}</p>`;
const initial = (name) => esc(String(name || '?').trim().charAt(0).toUpperCase() || '?');
const safeDecode = (value) => {
  try { return decodeURIComponent(value || ''); } catch { return ''; }
};
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function timeAgo(iso) {
  const seconds = (Date.now() - Date.parse(iso)) / 1000;
  if (seconds < 60) return 'now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

function timeLong(iso) {
  const seconds = (Date.now() - Date.parse(iso)) / 1000;
  if (seconds < 3600) return `${Math.max(1, Math.floor(seconds / 60))}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.code = data.code;
    throw err;
  }
  return data;
}
const send = (method, path, data) => api(path, { method, body: data === undefined ? undefined : JSON.stringify(data) });

// ---------- theme: system by default, or the viewer's light or dark choice (stored in this browser) ----------

const THEME_KEY = 'jumpseat-theme';
const systemDark = () => matchMedia('(prefers-color-scheme: dark)').matches;
function themePref() {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}
function isDark() {
  const pref = themePref();
  return pref === 'dark' || (pref === 'system' && systemDark());
}
function applyTheme(pref) {
  const root = document.documentElement;
  if (pref === 'light' || pref === 'dark') root.dataset.theme = pref;
  else delete root.dataset.theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', isDark() ? '#000000' : '#f5f5f7');
}
function setTheme(pref) {
  try {
    if (pref === 'system') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, pref);
  } catch {
    /* storage blocked: the choice lasts for this page only */
  }
  applyTheme(pref);
}

// Quick switch in the sidebar and on the tab bar's neighbour: flips between light and dark.
function renderThemeToggle() {
  const nav = $('#side-nav');
  nav.querySelector('.theme-quick')?.remove();
  const dark = isDark();
  nav.insertAdjacentHTML('beforeend', `<button class="side-link theme-quick" data-action="theme-toggle" type="button">${icon(dark ? 'sun' : 'moon', { size: 22 })}<span>${dark ? 'Light mode' : 'Dark mode'}</span></button>`);
}

let toastTimer;
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

// ---------- icons (stroke-based, inherit currentColor) ----------

const ICONS = {
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  feed: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  jobs: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M3 13h18"/>',
  plane: '<path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  heart: '<path d="M12 20.5s-7.5-4.6-9.2-9.1C1.7 8.4 3.5 5 7 5c2 0 3.6 1.2 5 3 1.4-1.8 3-3 5-3 3.5 0 5.3 3.4 4.2 6.4C19.5 15.9 12 20.5 12 20.5z"/>',
  message: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.6A8 8 0 1 1 21 12z"/>',
  flag: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="M5 12.5 10 17l9-10"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  back: '<path d="M19 12H5M12 19l-7-7 7-7"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/>',
  video: '<rect x="2" y="6" width="14" height="12" rx="2"/><path d="m16 10 6-3v10l-6-3"/>',
  external: '<path d="M14 4h6v6M20 4 10 14M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  shield: '<path d="M12 3 4 6v6c0 4.5 3.4 8.2 8 9 4.6-.8 8-4.5 8-9V6z"/>',
  send: '<path d="M22 2 11 13M22 2l-7 20-4-9-9-4z"/>',
  block: '<circle cx="12" cy="12" r="9"/><path d="m5.6 5.6 12.8 12.8"/>',
  house: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  wrench: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
};
const icon = (name, { filled = false, size = 20 } = {}) =>
  `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="${filled ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;

// Blue check: a verified organisation (its Roblox group owner has signed in).
const VERIFIED = '<svg class="verified" viewBox="0 0 24 24" role="img" aria-label="Verified organisation"><circle cx="12" cy="12" r="11" fill="currentColor"/><path d="M7.5 12.5l3 3 6-6.5" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// Account badges, in order of meaning:
//  confirmed: green house. The Roblox account is linked with a code in its About section.
//  member:    gold clover check. Granted by an admin to trusted Jumpseat members.
//  admin:     red gradient with a tools icon.
const BADGE_TITLES = {
  confirmed: 'Confirmed account: Roblox account linked with a code in its About section',
  member: 'Jumpseat verified member',
  admin: 'Admin',
};
const BADGE_HTML = {
  confirmed: `<span class="badge b-confirmed" role="img" aria-label="${BADGE_TITLES.confirmed}" title="${BADGE_TITLES.confirmed}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 11.2 12 4.4l8.5 6.8V19a1 1 0 0 1-1 1h-4.6v-5.6h-5.8V20H4.5a1 1 0 0 1-1-1z" fill="#fff"/></svg></span>`,
  member: `<svg class="badge-clover" viewBox="0 0 24 24" role="img" aria-label="${BADGE_TITLES.member}"><title>${BADGE_TITLES.member}</title><g fill="#f2c14e"><circle cx="8" cy="8" r="4.6"/><circle cx="16" cy="8" r="4.6"/><circle cx="8" cy="16" r="4.6"/><circle cx="16" cy="16" r="4.6"/><circle cx="12" cy="12" r="5.2"/></g><path d="M8.6 12.3l2.2 2.2 3.9-4.1" fill="none" stroke="#5c3d00" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  admin: `<span class="badge b-admin" role="img" aria-label="${BADGE_TITLES.admin}" title="${BADGE_TITLES.admin}"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg></span>`,
};
const badgesHtml = (badges = []) => ['confirmed', 'member', 'admin'].filter((b) => badges.includes(b)).map((b) => BADGE_HTML[b]).join('');

// Name, then the blue org check (if any), then the user's badges.
const nameLine = (name, { badges = [], verified = false } = {}) =>
  `${esc(name)}${verified ? VERIFIED : ''}${badgesHtml(badges)}`;

// Solid, muted avatar colors. Each name maps to one of these, so avatars stay consistent.
const AVATAR_COLORS = ['#3b4a63', '#4b3f63', '#3e5c4e', '#5e4b3a', '#3a5561', '#5a3e4c', '#4a5a3a', '#3e4a5e'];
const avatarColor = (seed) => {
  const sum = [...String(seed)].reduce((a, c) => a + c.charCodeAt(0), 0);
  return AVATAR_COLORS[sum % AVATAR_COLORS.length];
};
const avatar = (name, { airline = false, size = '' } = {}) =>
  `<span class="avatar${airline ? ' sq' : ''}${size ? ` ${size}` : ''}" style="background:${avatarColor(name)}" aria-hidden="true">${initial(name)}</span>`;

// ---------- state ----------

let me = { user: null, airlines: [], isAdmin: false, pendingRoblox: null, devLogin: false };
let homeTab = 'following';
let airlineTab = 'posts';
let airlineTabFor = null;
let messagesTab = 'inbox';
let adminTab = 'overview';
let jobFilter = { role: '', q: '' };
let unreadTotal = 0;
let threadPoll = null;
let renderedMessageIds = new Set();
let threadStateKey = null;
let threadPresenceKey = null;
let currentThread = null;

const NAV = [
  { href: '#/', icon: 'home', label: 'Home', match: /^#\/?$/ },
  { href: '#/feed', icon: 'feed', label: 'Feed', match: /^#\/feed$/ },
  { href: '#/discover', icon: 'search', label: 'Discover', match: /^#\/discover/ },
  { href: '#/jobs', icon: 'jobs', label: 'Jobs', match: /^#\/(jobs|job\/)/ },
  { href: '#/airlines', icon: 'plane', label: 'Orgs', match: /^#\/(airlines|airline\/|claim)/ },
  { href: '#/messages', icon: 'message', label: 'Messages', match: /^#\/messages/, badge: true },
  { href: '#/me', icon: 'user', label: 'Profile', match: /^#\/(me|u\/|admin)/ },
];

const navBadge = (count) => (count > 0 ? `<span class="nav-badge" aria-label="${count} unread">${count > 99 ? '99+' : count}</span>` : '');

function renderChrome() {
  const hash = location.hash || '#/';
  $('#side-nav').innerHTML = NAV.map((n) =>
    `<a class="side-link${n.match.test(hash) ? ' active' : ''}" href="${n.href}">${icon(n.icon, { size: 22 })}<span>${n.label}</span>${n.badge ? navBadge(unreadTotal) : ''}</a>`).join('');
  $('#tabbar').innerHTML = NAV.map((n) =>
    `<a class="tab-link${n.match.test(hash) ? ' active' : ''}" href="${n.href}">${icon(n.icon, { size: 23 })}<span>${n.label}</span>${n.badge && unreadTotal ? '<span class="tab-dot"></span>' : ''}</a>`).join('');

  $('#account').innerHTML = me.user
    ? `<a class="account" href="#/me">${avatar(me.user.displayName)}<span class="account-text"><strong>${nameLine(me.user.displayName, { badges: me.user.badges })}</strong><span class="muted">@${esc(me.user.username)}</span></span></a>`
    : '<a class="btn primary wide" href="/auth/login">Sign in</a>';
}

async function loadMe() {
  try {
    me = await api('/api/me');
  } catch {
    me = { user: null, airlines: [], isAdmin: false, pendingRoblox: null, devLogin: false };
  }
  renderChrome();
}

async function refreshUnread() {
  if (!me.user) return;
  try {
    const data = await api('/api/conversations');
    if (data.totalUnread !== unreadTotal) {
      unreadTotal = data.totalUnread;
      renderChrome();
    }
  } catch {
    /* offline or signed out: keep the last count */
  }
}

async function renderRail() {
  const rail = $('#rail');
  rail.innerHTML = `
    <section class="surface rail-card"><h3>Trending</h3><div id="rail-tags">${loading}</div></section>
    <section class="surface rail-card"><h3>Organisations</h3><div id="rail-airlines">${loading}</div></section>
    <p class="fine">Jumpseat is a fan project. It is not affiliated with Roblox Corporation or any airline or store listed here.</p>`;
  try {
    const [tags, airlines] = await Promise.all([api('/api/tags'), api('/api/airlines')]);
    $('#rail-tags').innerHTML = tags.length
      ? tags.slice(0, 5).map((t) => `<a class="tag-row" href="#/tag/${esc(t.tag)}"><span>#${esc(t.tag)}</span><span class="muted">${plural(t.count, 'post')}</span></a>`).join('')
      : '<p class="muted">No tags yet.</p>';
    $('#rail-airlines').innerHTML = airlines.length
      ? airlines.slice(0, 4).map((a) => `
          <a class="rail-airline" href="#/airline/${esc(a.slug)}">
            ${avatar(a.name, { airline: true, size: 'sm' })}
            <span class="rail-airline-text">
              <strong>${esc(a.name)}${a.verified ? VERIFIED : ''}</strong>
              <span class="muted">${esc(a.kindLabel)} · ${plural(a.followers, 'follower')}</span>
            </span>
          </a>`).join('')
      : '<p class="muted">No organisations yet.</p>';
  } catch {
    $('#rail-tags').innerHTML = '';
    $('#rail-airlines').innerHTML = '';
  }
}

// ---------- components ----------

function pageHead(title, { back = false } = {}) {
  return `<header class="page-head">${back
    ? `<button class="icon-btn" data-action="back" aria-label="Back">${icon('back', { size: 20 })}</button>`
    : ''}<h1 class="page-title">${esc(title)}</h1></header>`;
}

function seg(scope, options, current) {
  return `<div class="seg" role="tablist">${options.map(([value, label]) =>
    `<button role="tab" class="${value === current ? 'on' : ''}" data-scope="${scope}" data-tab="${value}" aria-selected="${value === current}">${label}</button>`).join('')}</div>`;
}

function embed(src, title) {
  return `<div class="embed"><iframe src="${esc(src)}" title="${esc(title)}" loading="lazy" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe></div>`;
}

// Images, linked video files, and YouTube or Vimeo embeds. Only one media type per post.
function mediaHtml(p) {
  if (p.video?.kind === 'file') {
    return `<video class="post-media" src="${esc(p.video.src)}" controls playsinline preload="metadata" referrerpolicy="no-referrer"></video>`;
  }
  if (p.video?.kind === 'youtube') return embed(`https://www.youtube-nocookie.com/embed/${encodeURIComponent(p.video.id)}`, 'YouTube video');
  if (p.video?.kind === 'vimeo') return embed(`https://player.vimeo.com/video/${encodeURIComponent(p.video.id)}`, 'Vimeo video');
  if (p.imageUrl) return `<img class="post-img" src="${esc(p.imageUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer">`;
  return '';
}

function postCard(p) {
  const isOrg = p.author.type === 'airline';
  const href = isOrg ? `#/airline/${esc(p.author.slug)}` : `#/u/${esc(p.author.username)}`;
  const handle = isOrg ? `${KIND_LABELS[p.author.kind] || 'Organisation'}` : `@${p.author.username}`;
  const name = isOrg
    ? nameLine(p.author.name, { verified: p.author.verified })
    : nameLine(p.author.name, { badges: p.author.badges });
  return `
    <article class="post" data-post="${esc(p.id)}">
      <a class="post-avatar" href="${href}" tabindex="-1">${avatar(p.author.name, { airline: isOrg })}</a>
      <div class="post-main">
        <header class="post-head">
          <a class="post-name" href="${href}">${name}</a>
          <span class="post-handle">${esc(handle)} · ${timeAgo(p.createdAt)}</span>
          ${p.canDelete ? `<button class="icon-btn quiet" data-action="delete" data-id="${esc(p.id)}" aria-label="Delete post">${icon('trash', { size: 16 })}</button>` : ''}
        </header>
        <div class="post-body">${richText(p.body)}</div>
        ${linkCards(p.body)}
        ${mediaHtml(p)}
        <footer class="post-actions">
          <button class="act${p.likedByMe ? ' on' : ''}" data-action="like" data-id="${esc(p.id)}" aria-pressed="${p.likedByMe}" aria-label="Like">${icon('heart', { filled: p.likedByMe, size: 18 })}<span>${p.likeCount}</span></button>
          <a class="act" href="#/post/${esc(p.id)}" aria-label="Comments">${icon('message', { size: 18 })}<span>${p.commentCount}</span></a>
          <button class="act" data-action="report" data-id="${esc(p.id)}" aria-label="Report post">${icon('flag', { size: 18 })}</button>
        </footer>
      </div>
    </article>`;
}

function jobRow(job) {
  return `
    <a class="row" href="#/job/${esc(job.id)}">
      ${avatar(job.airline?.name || '?', { airline: true })}
      <div class="row-main">
        <div class="row-title">${esc(job.title)}</div>
        <div class="row-sub">${esc(job.airline?.name || 'Unknown organisation')}${job.airline?.verified ? VERIFIED : ''}</div>
      </div>
      <div class="row-end"><span class="pill">${esc(job.roleLabel)}</span><span>${timeAgo(job.createdAt)}</span></div>
    </a>`;
}

function orgRow(a) {
  return `
    <a class="row" href="#/airline/${esc(a.slug)}">
      ${avatar(a.name, { airline: true })}
      <div class="row-main">
        <div class="row-title">${esc(a.name)}${a.verified ? VERIFIED : ''}<span class="kind">${esc(a.kindLabel)}</span></div>
        <div class="row-sub clamp">${esc(a.description || 'No description yet.')}</div>
      </div>
      <div class="row-end"><span>${plural(a.followers, 'follower')}</span></div>
    </a>`;
}

function orgCard(a) {
  return `
    <a class="card surface" href="#/airline/${esc(a.slug)}">
      <div class="org-top">${avatar(a.name, { airline: true })}<span class="kind">${esc(a.kindLabel)}</span></div>
      <h3 class="org-name">${esc(a.name)}${a.verified ? VERIFIED : ''}</h3>
      <p class="muted clamp">${esc(a.description || 'No description yet.')}</p>
      <p class="small muted" style="margin-top:10px">${plural(a.followers, 'follower')}</p>
    </a>`;
}

function userRow(u) {
  return `
    <a class="row" href="#/u/${esc(u.username)}">
      ${avatar(u.displayName)}
      <div class="row-main">
        <div class="row-title">${nameLine(u.displayName, { badges: u.badges })}</div>
        <div class="row-sub">@${esc(u.username)}</div>
      </div>
    </a>`;
}

function commentItem(c) {
  return `
    <div class="comment">
      ${avatar(c.author.name, { size: 'sm' })}
      <div>
        <div class="post-head">
          <strong>${nameLine(c.author.name, { badges: c.author.badges })}</strong><span class="post-handle">@${esc(c.author.username)} · ${timeAgo(c.createdAt)}</span>
          ${c.mine ? `<button class="icon-btn quiet" data-action="delete-comment" data-id="${esc(c.id)}" aria-label="Delete comment">${icon('trash', { size: 16 })}</button>` : ''}
        </div>
        <p>${richText(c.body)}</p>
      </div>
    </div>`;
}

function composer(defaultOrgSlug = null) {
  if (!me.user) return '';
  const owned = me.airlines.filter((a) => a.owner);
  const options = [
    `<option value="">Post as @${esc(me.user.username)}</option>`,
    ...owned.map((a) => `<option value="${esc(a.slug)}"${a.slug === defaultOrgSlug ? ' selected' : ''}>Post as ${esc(a.name)}</option>`),
  ].join('');
  return `
    <form class="composer" data-form="composer">
      ${avatar(me.user.displayName)}
      <div class="composer-main">
        <textarea name="body" rows="2" maxlength="500" placeholder="What's happening in the skies?" aria-label="Post text" required></textarea>
        <div class="composer-tools">
          <label class="url-field">${icon('video', { size: 15 })}<input name="media" type="url" placeholder="Image, video or YouTube/Vimeo link" maxlength="500" aria-label="Media link"></label>
          ${owned.length ? `<select name="airlineSlug" aria-label="Post as">${options}</select>` : ''}
          <button class="btn primary small" type="submit">Post</button>
        </div>
        <p class="form-status" data-status></p>
      </div>
    </form>`;
}

function signInPrompt(headline, text) {
  return `
    <section class="prompt">
      <p class="kicker">Jumpseat</p>
      <h1 class="display">${esc(headline)}</h1>
      <p class="lede">${esc(text)}</p>
      <div class="cta"><a class="btn primary" href="/auth/login">Sign in</a></div>
    </section>`;
}

// ---------- form wiring ----------

// One helper for every form: disables the button while it works, shows errors inline, then runs onSuccess.
function bindForm(selector, handler, onSuccess) {
  const form = $(selector);
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const button = form.querySelector('button[type="submit"]');
    const status = form.querySelector('[data-status]');
    if (button) button.disabled = true;
    if (status) status.textContent = 'Working…';
    try {
      const result = await handler(Object.fromEntries(new FormData(form)), form);
      if (status) status.textContent = '';
      if (onSuccess) await onSuccess(result, form);
    } catch (err) {
      if (status) status.textContent = err.message;
    } finally {
      if (button) button.disabled = false;
    }
  });
}

function bindComposer() {
  bindForm('[data-form="composer"]', (data) => send('POST', '/api/posts', {
    body: data.body,
    media: data.media || undefined,
    airlineSlug: data.airlineSlug || undefined,
  }), () => {
    toast('Posted');
    route();
  });
}

// ---------- views: home (dashboard) ----------

async function renderHome() {
  const guest = !me.user;
  app.innerHTML = `
    ${pageHead('Home')}
    <section class="home-hero">
      <p class="kicker">${guest ? 'Roblox airlines and stores, in one place' : `Welcome back, ${esc(me.user.displayName)}`}</p>
      <h1 class="display">${guest ? 'Your airline community, in one feed.' : 'Fly, hire and get hired.'}</h1>
      <p class="lede">${guest
        ? 'Follow the airlines and Roblox stores you care about, see what crews post, and apply to open roles without leaving the sky.'
        : 'Your dashboard for organisations, roles and the crew around you.'}</p>
      <div class="cta">
        ${guest
          ? '<a class="btn primary" href="/auth/login">Sign in</a><a class="btn secondary" href="#/discover">Explore</a>'
          : '<a class="btn primary" href="#/feed">Open your feed</a><a class="btn secondary" href="#/jobs">Browse roles</a>'}
      </div>
    </section>
    ${guest ? '' : checklistCard()}
    <div id="home-stats" class="stat-strip">${loading}</div>
    <div class="section-head"><h2>Open roles</h2><a class="small" href="#/jobs">See all</a></div>
    <div id="home-jobs" class="list">${loading}</div>
    <div class="section-head"><h2>Organisations</h2><a class="small" href="#/airlines">See all</a></div>
    <div id="home-orgs" class="org-grid">${loading}</div>
    <div class="section-head"><h2>Popular right now</h2><a class="small" href="#/feed">Open feed</a></div>
    <div id="home-posts" class="feed">${loading}</div>
    <div class="section-head"><h2>Trending</h2></div>
    <div id="home-tags" class="tag-cloud">${loading}</div>
    ${guest ? `<section class="features">
      ${feature('plane', 'Follow organisations', 'Posts, hiring news and route updates from airlines and Roblox stores.')}
      ${feature('jobs', 'Apply once', 'One application goes straight to the organisation’s Discord.')}
      ${feature('shield', 'Confirmed and verified', 'Accounts confirm their Roblox link. Organisations prove they own their group.')}
    </section>` : ''}`;

  try {
    const [orgs, jobs, posts, tags] = await Promise.all([
      api('/api/airlines'),
      api('/api/jobs'),
      api('/api/posts?sort=top'),
      api('/api/tags'),
    ]);
    const verified = orgs.filter((o) => o.verified);
    $('#home-stats').innerHTML = [
      statTile(verified.length, 'verified organisations'),
      statTile(jobs.length, 'open roles'),
      statTile(posts.length, 'posts this week'),
    ].join('');
    $('#home-jobs').innerHTML = jobs.length ? jobs.slice(0, 4).map(jobRow).join('') : '<p class="empty">No open roles yet.</p>';
    $('#home-orgs').innerHTML = verified.length
      ? verified.slice(0, 3).map(orgCard).join('')
      : '<p class="empty">No verified organisations yet.</p>';
    $('#home-posts').innerHTML = posts.length ? posts.slice(0, 2).map(postCard).join('') : '<p class="empty">No posts yet.</p>';
    $('#home-tags').innerHTML = tags.length
      ? tags.slice(0, 8).map((t) => `<a class="chip" href="#/tag/${esc(t.tag)}">#${esc(t.tag)} <span class="muted">${t.count}</span></a>`).join('')
      : '<p class="muted">No tags yet.</p>';
  } catch (err) {
    $('#home-stats').innerHTML = errorBox(err.message);
  }
}

function feature(iconName, title, text) {
  return `<div class="feature"><span class="feature-ic">${icon(iconName, { size: 20 })}</span><h3>${esc(title)}</h3><p>${esc(text)}</p></div>`;
}

function statTile(value, label) {
  return `<div class="stat"><strong>${value}</strong><span class="muted">${esc(label)}</span></div>`;
}

// For signed-in users: the steps to get set up, with the confirmation step first.
function checklistCard() {
  const confirmed = Boolean(me.user.confirmed);
  const hasOrg = me.airlines.length > 0;
  const followed = me.following > 0;
  const steps = [
    { done: true, title: 'Sign in', text: 'You are signed in.' },
    {
      done: confirmed,
      title: 'Confirm your Roblox account',
      text: confirmed ? 'Confirmed. The green house shows on your profile.' : 'Paste a short code into your Roblox About to confirm the account. Needed before you can set up an organisation.',
      href: confirmed ? null : '#/me',
      cta: 'Confirm',
    },
    {
      done: hasOrg,
      title: 'Set up your organisation',
      text: hasOrg ? `You have ${plural(me.airlines.length, 'organisation')}.` : 'Airline, Roblox store or another group. Needs a confirmed account.',
      href: hasOrg ? null : '#/claim',
      cta: 'Set up',
      locked: !confirmed,
    },
    { done: followed, title: 'Follow an organisation', text: followed ? 'Your feed is set up.' : 'Follow a few to fill your feed.', href: followed ? null : '#/airlines', cta: 'Browse' },
  ];
  const doneCount = steps.filter((s) => s.done).length;
  if (doneCount === steps.length) return '';
  return `
    <section class="surface checklist">
      <div class="section-head" style="padding-top:0"><h2>Get set up</h2><span class="muted small">${doneCount} of ${steps.length} done</span></div>
      <ol class="steps">
        ${steps.map((s) => `
          <li class="step${s.done ? ' done' : ''}">
            <span class="step-mark">${s.done ? icon('check', { size: 16 }) : ''}</span>
            <div class="step-text">
              <strong>${esc(s.title)}${s.title.startsWith('Confirm') ? ` ${BADGE_HTML.confirmed}` : ''}</strong>
              <span class="muted small">${esc(s.text)}</span>
            </div>
            ${s.href && !s.done ? `<a class="btn ${s.locked ? 'secondary' : 'primary'} small" href="${s.href}">${s.cta}</a>` : ''}
          </li>`).join('')}
      </ol>
    </section>`;
}

// ---------- views: feed ----------

async function loadFeed() {
  const feed = $('#feed');
  try {
    let posts = me.user && homeTab === 'following' ? await api('/api/feed') : await api('/api/posts?sort=top');
    let notice = '';
    if (me.user && homeTab === 'following' && !posts.length) {
      posts = await api('/api/posts?sort=top');
      notice = '<div class="surface notice">You are not following anyone yet. Follow organisations or crew in Discover and their posts will land here. Popular posts are shown for now.</div>';
    }
    feed.innerHTML = notice + (posts.length ? posts.map(postCard).join('') : '<p class="empty">No posts yet. Be the first to post.</p>');
  } catch (err) {
    feed.innerHTML = errorBox(err.message);
  }
}

function renderFeed() {
  app.innerHTML = `
    ${pageHead('Feed')}
    ${me.user ? composer() : `<section class="surface notice">Sign in to post and follow. <a class="tag-link" href="/auth/login">Sign in</a></section>`}
    <div class="toolbar">${seg('home', me.user ? [['following', 'Following'], ['explore', 'Explore']] : [['explore', 'Popular']], me.user ? homeTab : 'explore')}</div>
    <div id="feed" class="feed">${loading}</div>`;
  bindComposer();
  loadFeed();
}

// ---------- views: discover, tags ----------

function renderDiscover(q = '') {
  app.innerHTML = `
    ${pageHead('Discover')}
    <form id="search-form" class="search" role="search">
      ${icon('search', { size: 18 })}
      <input id="q" type="search" placeholder="Search organisations, people, posts, roles or #tags" value="${esc(q)}" aria-label="Search">
    </form>
    <div id="results">${q ? loading : `
      <div class="section-head"><h2>Popular tags</h2></div>
      <div id="tags" class="tag-cloud">${loading}</div>`}</div>`;

  $('#search-form').addEventListener('submit', (e) => {
    e.preventDefault();
    location.hash = `#/discover?q=${encodeURIComponent($('#q').value.trim())}`;
  });

  if (q) loadDiscover(q);
  else loadTags();
}

async function loadTags() {
  try {
    const tags = await api('/api/tags');
    $('#tags').innerHTML = tags.length
      ? tags.map((t) => `<a class="chip" href="#/tag/${esc(t.tag)}">#${esc(t.tag)} <span class="muted">${t.count}</span></a>`).join('')
      : '<p class="muted">No tags yet.</p>';
  } catch (err) {
    $('#tags').innerHTML = errorBox(err.message);
  }
}

function resultSection(title, html) {
  return html ? `<div class="section-head"><h2>${esc(title)}</h2></div>${html}` : '';
}

async function loadDiscover(q) {
  const results = $('#results');
  try {
    const r = await api(`/api/discover?q=${encodeURIComponent(q)}`);
    const html = [
      resultSection('Organisations', r.airlines.length ? `<div class="list">${r.airlines.map(orgRow).join('')}</div>` : ''),
      resultSection('People', r.users.length ? `<div class="list">${r.users.map(userRow).join('')}</div>` : ''),
      resultSection('Roles', r.jobs.length ? `<div class="list">${r.jobs.map(jobRow).join('')}</div>` : ''),
      resultSection('Posts', r.posts.length ? `<div class="feed">${r.posts.map(postCard).join('')}</div>` : ''),
    ].join('');
    results.innerHTML = html || '<p class="empty">Nothing matched that yet.</p>';
  } catch (err) {
    results.innerHTML = errorBox(err.message);
  }
}

async function renderTag(tag) {
  app.innerHTML = `${pageHead(`#${tag}`, { back: true })}<div id="feed" class="feed">${loading}</div>`;
  try {
    const posts = await api(`/api/posts?tag=${encodeURIComponent(tag)}`);
    $('#feed').innerHTML = posts.length ? posts.map(postCard).join('') : '<p class="empty">No posts with this tag yet.</p>';
  } catch (err) {
    $('#feed').innerHTML = errorBox(err.message);
  }
}

// ---------- views: post detail ----------

async function renderPost(id) {
  app.innerHTML = `${pageHead('Post', { back: true })}${loading}`;
  try {
    const post = await api(`/api/posts/${encodeURIComponent(id)}`);
    const comments = post.comments.length
      ? post.comments.map(commentItem).join('')
      : '<p class="empty">No comments yet.</p>';
    app.innerHTML = `
      ${pageHead('Post', { back: true })}
      <div class="feed">${postCard(post)}</div>
      ${me.user ? `
        <form class="composer" data-form="comment">
          ${avatar(me.user.displayName)}
          <div class="composer-main">
            <textarea name="body" rows="2" maxlength="280" placeholder="Post your reply" aria-label="Reply" required></textarea>
            <div class="composer-tools"><span class="grow"></span><button class="btn primary small" type="submit">Reply</button></div>
            <p class="form-status" data-status></p>
          </div>
        </form>` : '<p class="muted" style="padding:16px 0"><a class="tag-link" href="/auth/login">Sign in</a> to reply.</p>'}
      <div class="comments">${comments}</div>`;
    bindForm('[data-form="comment"]', (data) => send('POST', `/api/posts/${encodeURIComponent(id)}/comments`, data), () => {
      toast('Reply posted');
      renderPost(id);
    });
  } catch (err) {
    app.innerHTML = `${pageHead('Post', { back: true })}${errorBox(err.message)}`;
  }
}

// ---------- views: messages ----------

function convoRow(c) {
  const preview = c.lastMessage
    ? `${c.lastMessage.mine ? 'You: ' : ''}${esc(c.lastMessage.body)}`
    : (c.role === 'initiator' ? 'Request sent. Waiting for a reply.' : 'Wants to message you.');
  const showHandle = c.other.displayName !== c.other.username;
  return `
    <a class="row convo${c.unread ? ' unread' : ''}" href="#/messages/${esc(c.id)}">
      ${avatar(c.other.displayName)}
      <div class="row-main">
        <div class="row-title">${nameLine(c.other.displayName, { badges: c.other.badges })}${showHandle ? ` <span class="handle-sm">@${esc(c.other.username)}</span>` : ''}</div>
        <div class="row-sub clamp">${preview}</div>
      </div>
      <div class="row-end">
        <span>${timeAgo(c.updatedAt)}</span>
        ${c.unread ? `<span class="unread-dot">${c.unread}</span>` : ''}
      </div>
    </a>`;
}

async function renderMessages() {
  app.innerHTML = `
    ${pageHead('Messages')}
    ${me.user ? '' : signInPrompt('Your messages', 'Sign in to send and read direct messages.')}
    ${me.user ? `
      <div class="toolbar" style="padding-top:16px">${seg('messages', [['inbox', 'Inbox'], ['request', 'Requests']], messagesTab)}</div>
      <p class="muted small" style="padding:10px 0 0">${messagesTab === 'request'
        ? 'People you have not chatted with yet. Accept to reply.'
        : 'Your conversations. Only accepted chats show here.'}</p>
      <div id="convos" class="list">${loading}</div>` : ''}`;
  if (!me.user) return;

  try {
    const data = await api('/api/conversations');
    unreadTotal = data.totalUnread;
    renderChrome();
    const items = data.conversations.filter((c) => c.kind === messagesTab);
    $('#convos').innerHTML = items.length
      ? items.map(convoRow).join('')
      : `<p class="empty">${messagesTab === 'request'
        ? 'No message requests.'
        : 'No conversations yet. Open someone’s profile and tap Message to start one.'}</p>`;
  } catch (err) {
    $('#convos').innerHTML = errorBox(err.message);
  }
}

function bubbleHtml(m, animate) {
  return `
    <div class="bubble-row${m.mine ? ' mine' : ''}${animate ? ' new' : ''}" data-msg="${esc(m.id)}">
      <div class="bubble">${richText(m.body)}</div>
      <span class="bubble-time">${clock(m.createdAt)}</span>
    </div>`;
}

// Appends only messages we have not drawn yet, so existing bubbles are never re-animated or re-rendered.
function appendMessages(messages, animate) {
  const box = $('#messages');
  if (!box) return;
  const fresh = messages.filter((m) => !renderedMessageIds.has(m.id));
  if (!fresh.length) return;
  const nearBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 240;
  box.querySelector('.empty')?.remove();
  box.insertAdjacentHTML('beforeend', fresh.map((m) => bubbleHtml(m, animate)).join(''));
  fresh.forEach((m) => renderedMessageIds.add(m.id));
  if (nearBottom || fresh.some((m) => m.mine)) {
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: animate && !REDUCED_MOTION.matches ? 'smooth' : 'auto' });
  }
}

function threadFooter(t) {
  const other = t.other.displayName;
  switch (t.reason) {
    case null:
      return `
        ${t.status === 'pending' ? `<p class="thread-note">Request sent. You can send one message until ${esc(other)} accepts.</p>` : ''}
        <form class="thread-compose" data-form="dm">
          <textarea name="body" rows="1" maxlength="1000" placeholder="Message" aria-label="Message" required></textarea>
          <button class="btn primary" type="submit" aria-label="Send">${icon('send', { size: 18 })}</button>
        </form>
        <p class="form-status" data-status></p>`;
    case 'request':
      return `
        <div class="request-bar">
          <p class="thread-note">${esc(other)} wants to message you.</p>
          <div class="hero-actions" style="margin:0">
            <button class="btn primary small" data-action="accept-dm" data-id="${esc(t.id)}">Accept</button>
            <button class="btn secondary small" data-action="decline-dm" data-id="${esc(t.id)}">Decline</button>
          </div>
        </div>`;
    case 'waiting':
      return `<p class="thread-note">Waiting for ${esc(other)} to accept your request.</p>`;
    case 'you-blocked':
      return `<p class="thread-note">You blocked ${esc(other)}. Unblock to message again.</p>`;
    default:
      return `<p class="thread-note">${esc(t.reasonText || 'You cannot message this account.')}</p>`;
  }
}

function threadHeader(t) {
  const blocked = t.reason === 'you-blocked';
  return `
    <div class="thread-head">
      <a class="row" style="border:0;padding:0;flex:1" href="#/u/${esc(t.other.username)}">
        ${avatar(t.other.displayName, { size: 'sm' })}
        <div class="row-main">
          <div class="row-title">${nameLine(t.other.displayName, { badges: t.other.badges })}</div>
          <div class="row-sub">@${esc(t.other.username)}</div>
        </div>
      </a>
      <button class="btn secondary small" data-action="${blocked ? 'unblock-dm' : 'block-dm'}" data-id="${esc(t.other.id)}">${icon('block', { size: 15 })} ${blocked ? 'Unblock' : 'Block'}</button>
      <button class="icon-btn" data-action="report-dm" data-id="${esc(t.id)}" aria-label="Report conversation">${icon('flag', { size: 18 })}</button>
    </div>`;
}

// One circle with a status ring, and a glass pill over its lower edge. Tap for options.
function iosThreadHead(t) {
  const online = Boolean(t.other.online);
  const name = t.other.displayName;
  return `
    <button class="ios-hero" type="button" data-action="thread-menu" aria-label="Options for ${esc(name)}">
      <span class="status-ring ${online ? 'online' : 'offline'}" role="img" aria-label="${online ? 'Online' : 'Offline'}">${avatar(name, { size: 'lg' })}</span>
      <span class="ios-pill">
        <span class="ios-name">${nameLine(name, { badges: t.other.badges })}</span>
      </span>
    </button>`;
}

// The options sheet: profile, block or unblock, report, cancel. Actions reuse the existing handlers.
function openThreadMenu(t) {
  if (!t) return;
  document.querySelector('.sheet-backdrop')?.remove();
  const blocked = t.reason === 'you-blocked';
  const name = t.other.displayName;
  const wrap = document.createElement('div');
  wrap.className = 'sheet-backdrop';
  wrap.innerHTML = `
    <div class="sheet menu-sheet" role="dialog" aria-modal="true" aria-label="Options for ${esc(name)}">
      <div class="menu-head">${avatar(name, { size: 'sm' })}<div><strong>${esc(name)}</strong><div class="muted small">@${esc(t.other.username)}</div></div></div>
      <div class="sheet-actions">
        <a class="btn secondary" href="#/u/${esc(t.other.username)}" data-close>View profile</a>
        <button class="btn secondary" data-action="${blocked ? 'unblock-dm' : 'block-dm'}" data-id="${esc(t.other.id)}">${blocked ? 'Unblock' : 'Block'}</button>
        <button class="btn secondary" data-action="report-dm" data-id="${esc(t.id)}">Report conversation</button>
        <button class="btn ghost" type="button" data-close>Cancel</button>
      </div>
    </div>`;
  wrap.addEventListener('click', (e) => { if (e.target === wrap) wrap.remove(); });
  $('#app').appendChild(wrap);
}

function renderThreadChrome(t) {
  $('#thread-head').innerHTML = iosThreadHead(t);
  $('#thread-foot').innerHTML = threadFooter(t);
  bindForm('[data-form="dm"]', (data) => send('POST', `/api/conversations/${encodeURIComponent(t.id)}/messages`, { body: data.body }), (msg, form) => {
    form.reset();
    appendMessages([msg], true);
  });
  const dmForm = $('[data-form="dm"]');
  if (dmForm) {
    const ta = dmForm.querySelector('textarea');
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        dmForm.requestSubmit();
      }
    });
    ta.addEventListener('input', () => {
      ta.style.height = 'auto';
      ta.style.height = `${Math.min(ta.scrollHeight, 140)}px`;
    });
  }
}

async function loadThread(id, initial) {
  if (location.hash !== `#/messages/${id}`) return;
  let t;
  try {
    t = await api(`/api/conversations/${encodeURIComponent(id)}`);
  } catch (err) {
    if (initial) app.innerHTML = `${pageHead('Message', { back: true })}${errorBox(err.message)}`;
    stopThreadPoll();
    return;
  }
  // Rebuild the header and footer only when the conversation state changes. Otherwise typed text survives.
  // Presence can change without the conversation changing. Refresh just the header then.
  currentThread = t;
  const presence = t.other.online ? 'on' : 'off';
  if (initial || presence !== threadPresenceKey) {
    threadPresenceKey = presence;
    $('#thread-head').innerHTML = iosThreadHead(t);
  }
  const key = `${t.status}|${t.reason}|${t.canSend}`;
  if (initial || key !== threadStateKey) {
    threadStateKey = key;
    renderThreadChrome(t);
  }
  if (initial) {
    $('#messages').innerHTML = t.messages.length ? '' : '<p class="empty">Say hello.</p>';
    appendMessages(t.messages, false);
    window.scrollTo({ top: document.documentElement.scrollHeight });
  } else {
    appendMessages(t.messages, true);
  }
}

function stopThreadPoll() {
  if (threadPoll) clearInterval(threadPoll);
  threadPoll = null;
}

async function renderThread(id) {
  stopThreadPoll();
  threadStateKey = null;
  renderedMessageIds = new Set();
  app.innerHTML = `
    ${pageHead('Message', { back: true })}
    <div id="thread-head"></div>
    <div id="messages" class="messages">${loading}</div>
    <div id="thread-foot" class="thread-foot"></div>`;
  await loadThread(id, true);
  threadPoll = setInterval(() => loadThread(id, false), 3000);
}

// ---------- views: jobs ----------

function renderJobs() {
  app.innerHTML = `
    ${pageHead('Jobs')}
    <p class="lede" style="margin-top:20px;font-size:16px">Open roles from verified organisations. Applications go straight to the organisation’s Discord.</p>
    <div class="toolbar" style="padding-top:14px">
      <label class="search" style="margin-top:0;flex:1 1 260px">${icon('search', { size: 18 })}
        <input id="search" type="search" placeholder="Search roles or organisations" aria-label="Search jobs" value="${esc(jobFilter.q)}">
      </label>
    </div>
    <div class="toolbar" style="padding-top:4px">${seg('jobs', roleFilters(), jobFilter.role)}</div>
    <div id="list" class="list">${loading}</div>`;

  $('.toolbar .seg').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-tab]');
    if (!btn) return;
    jobFilter.role = btn.dataset.tab;
    jobFilter.q = $('#search').value.trim();
    renderJobs();
  });

  let timer;
  $('#search').addEventListener('input', (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      jobFilter.q = e.target.value.trim();
      loadJobs();
    }, 200);
  });
  loadJobs();
}

async function loadJobs() {
  const list = $('#list');
  const params = new URLSearchParams();
  if (jobFilter.role) params.set('group', jobFilter.role);
  if (jobFilter.q) params.set('q', jobFilter.q);
  try {
    const jobs = await api(`/api/jobs?${params}`);
    list.innerHTML = jobs.length ? jobs.map(jobRow).join('') : '<p class="empty">No open roles match that yet.</p>';
  } catch (err) {
    list.innerHTML = errorBox(err.message);
  }
}

// How people in a Roblox business usually get hired: join the group, then apply or take the quiz.
function howToApplyHtml(org) {
  const join = org.robloxGroupId
    ? `<a class="btn secondary small" href="https://www.roblox.com/communities/${esc(org.robloxGroupId)}" target="_blank" rel="noopener">${icon('external', { size: 15 })} Join the Roblox group</a>`
    : '';
  const note = org.applyInstructions ? `<p class="prose" style="padding:0">${esc(org.applyInstructions)}</p>` : '';
  if (!join && !note) return '';
  return `<section class="surface apply-how"><h2>How to apply</h2>${note}${join ? `<div class="profile-actions" style="margin-top:8px">${join}</div>` : ''}</section>`;
}

async function renderJob(id) {
  app.innerHTML = `${pageHead('Role', { back: true })}${loading}`;
  try {
    const job = await api(`/api/jobs/${encodeURIComponent(id)}`);
    app.innerHTML = `
      ${pageHead('Role', { back: true })}
      <header class="job-head">
        <h1>${esc(job.title)}</h1>
        <a class="row" style="padding:0;border:0" href="#/airline/${esc(job.airline.slug)}">
          ${avatar(job.airline.name, { airline: true, size: 'sm' })}
          <div class="row-main"><div class="row-title">${esc(job.airline.name)}${job.airline.verified ? VERIFIED : ''}</div></div>
        </a>
        <div class="meta"><span class="pill">${esc(job.roleLabel)}</span><span>Posted ${timeLong(job.createdAt)}</span></div>
      </header>
      <p class="prose">${esc(job.description)}</p>
      ${howToApplyHtml(job.airline)}
      <section class="surface apply">
        <h2>Apply</h2>
        <form class="form" data-form="apply">
          <label class="field">Roblox username
            <input name="robloxUsername" required minlength="3" maxlength="20" pattern="[A-Za-z0-9_]{3,20}" autocomplete="off" value="${esc(me.user?.robloxUsername || me.user?.username || '')}">
          </label>
          <label class="field">Why you?
            <textarea name="message" rows="4" maxlength="1000"></textarea>
          </label>
          <div><button class="btn primary" type="submit">Send application</button></div>
          <p class="form-status" data-status></p>
        </form>
      </section>`;

    bindForm('[data-form="apply"]', (data) => send('POST', `/api/jobs/${encodeURIComponent(id)}/applications`, data), (result, form) => {
      form.outerHTML = `
        <div class="form">
          <h2>Application sent</h2>
          <p class="muted">${result.delivered
            ? 'The organisation received it in their Discord.'
            : 'Saved. This organisation has not connected a Discord yet, so it was not forwarded.'}</p>
          <div><a class="btn secondary" href="#/jobs">Back to roles</a></div>
        </div>`;
    });
  } catch (err) {
    app.innerHTML = `${pageHead('Role', { back: true })}${errorBox(err.message)}`;
  }
}

// ---------- views: organisations ----------

async function renderAirlines() {
  app.innerHTML = `
    ${pageHead('Organisations')}
    <div class="toolbar" style="padding-top:18px">
      <span class="muted grow">Airlines, Roblox stores and other groups. Verified ones have proven their Roblox group.</span>
      <a class="btn primary small" href="#/claim">${icon('plus', { size: 16 })} Set up</a>
    </div>
    <div id="list" class="list">${loading}</div>`;
  try {
    const orgs = await api('/api/airlines');
    $('#list').innerHTML = orgs.length ? orgs.map(orgRow).join('') : '<p class="empty">No organisations yet.</p>';
  } catch (err) {
    $('#list').innerHTML = errorBox(err.message);
  }
}

async function renderAirline(slug) {
  if (airlineTabFor !== slug) {
    airlineTab = 'posts';
    airlineTabFor = slug;
  }
  app.innerHTML = `${pageHead('Organisation', { back: true })}${loading}`;
  try {
    const a = await api(`/api/airlines/${encodeURIComponent(slug)}`);
    const mine = me.airlines.find((x) => x.slug === a.slug);

    let actions = '';
    if (!me.user) actions = '<a class="btn secondary" href="/auth/login">Sign in to follow</a>';
    else if (!a.owner) actions = `<button class="btn ${a.following ? 'secondary' : 'primary'}" data-action="follow" data-type="airline" data-id="${esc(a.id)}">${a.following ? 'Following' : 'Follow'}</button>`;
    if (mine && !a.verified) actions += ` <a class="btn secondary" href="/auth/roblox?airline=${esc(a.slug)}">${icon('shield', { size: 16 })} Verify with Roblox</a>`;

    const tabs = [['posts', 'Posts'], ['roles', `Roles${a.jobs.length ? ` · ${a.jobs.length}` : ''}`], ['about', 'About']];
    if (a.owner) tabs.push(['manage', 'Manage']);
    if (!tabs.some(([v]) => v === airlineTab)) airlineTab = 'posts';

    let pane = '';
    if (airlineTab === 'posts') {
      pane = `${composer(a.owner ? a.slug : null)}<div class="feed">${a.posts.length ? a.posts.map(postCard).join('') : '<p class="empty">No posts yet.</p>'}</div>`;
    } else if (airlineTab === 'roles') {
      pane = `<div class="list">${a.jobs.length ? a.jobs.map((j) => jobRow({ ...j, airline: { slug: a.slug, name: a.name, verified: a.verified } })).join('') : '<p class="empty">No open roles right now.</p>'}</div>`;
    } else if (airlineTab === 'about') {
      pane = `
        <div class="form" style="padding-top:20px">
          <p class="prose" style="padding:0">${esc(a.description || 'No description yet.')}</p>
          <div class="surface form" style="gap:10px">
            <div class="row" style="border:0;padding:4px 0"><span class="muted grow">Type</span><span>${esc(a.kindLabel)}</span></div>
            <div class="row" style="border:0;padding:4px 0"><span class="muted grow">Status</span><span>${a.verified ? 'Verified' : 'Unverified'}</span></div>
            <div class="row" style="border:0;padding:4px 0"><span class="muted grow">Followers</span><span>${a.followers}</span></div>
            ${a.robloxGroupId ? `<div class="row" style="border:0;padding:4px 0"><span class="muted grow">Roblox group</span><a class="tag-link" href="https://www.roblox.com/communities/${esc(a.robloxGroupId)}" target="_blank" rel="noopener">View group ${icon('external', { size: 14 })}</a></div>` : ''}
            ${a.discordInvite ? `<div class="row" style="border:0;padding:4px 0"><span class="muted grow">Discord</span><a class="tag-link" href="${esc(a.discordInvite)}" target="_blank" rel="noopener">Join server ${icon('external', { size: 14 })}</a></div>` : ''}
          </div>
        </div>`;
    } else if (airlineTab === 'manage') {
      pane = `
        <div class="form" style="padding-top:20px">
          <section class="surface form">
            <h2>Post a role</h2>
            <form class="form" data-form="role">
              <label class="field">Title<input name="title" required minlength="3" maxlength="80" placeholder="First Officer"></label>
              <label class="field">Category
                <select name="role">${roleOptionsHtml()}</select>
              </label>
              <label class="field">Description<textarea name="description" rows="4" required maxlength="2000"></textarea></label>
              <div><button class="btn primary small" type="submit">Publish role</button></div>
              <p class="form-status" data-status></p>
            </form>
          </section>
          <section class="surface form">
            <h2>Settings</h2>
            <form class="form" data-form="settings">
              <label class="field">Description<textarea name="description" rows="3" maxlength="500">${esc(a.description)}</textarea></label>
              <label class="field">Discord invite<input name="discordInvite" value="${esc(a.discordInvite || '')}" placeholder="https://discord.gg/…"></label>
              <label class="field">Discord webhook${a.hasWebhook ? ' (set; leave blank to keep)' : ''}
                <input name="discordWebhook" type="password" autocomplete="off" placeholder="https://discord.com/api/webhooks/…"></label>
              <div><button class="btn secondary small" type="submit">Save settings</button></div>
              <p class="form-status" data-status></p>
            </form>
          </section>
        </div>`;
    }

    app.innerHTML = `
      ${pageHead(a.name, { back: true })}
      <section class="profile">
        <div class="profile-top">
          ${avatar(a.name, { airline: true, size: 'lg' })}
          <div class="profile-id">
            <h1>${esc(a.name)}${a.verified ? VERIFIED : ''}</h1>
            <p class="handle"><span class="kind">${esc(a.kindLabel)}</span> ${a.verified ? 'Verified' : 'Unverified'}${a.sample ? ' · sample' : ''}</p>
            <p class="bio">${esc(a.description || 'No description yet.')}</p>
            <div class="stats"><span><b>${a.followers}</b> followers</span><span><b>${a.jobs.length}</b> open roles</span><span><b>${a.posts.length}</b> posts</span></div>
          </div>
        </div>
        ${actions ? `<div class="profile-actions">${actions}</div>` : ''}
      </section>
      <div class="toolbar">${seg('airline', tabs, airlineTab)}</div>
      <div id="pane">${pane}</div>`;

    bindComposer();
    bindForm('[data-form="role"]', (data) => send('POST', `/api/airlines/${encodeURIComponent(a.slug)}/jobs`, data), () => {
      toast('Role published');
      airlineTab = 'roles';
      route();
    });
    bindForm('[data-form="settings"]', (data) => {
      const payload = { description: data.description, discordInvite: data.discordInvite };
      if (data.discordWebhook) payload.discordWebhook = data.discordWebhook;
      return send('PATCH', `/api/airlines/${encodeURIComponent(a.slug)}`, payload);
    }, () => {
      toast('Settings saved');
      route();
    });
  } catch (err) {
    app.innerHTML = `${pageHead('Organisation', { back: true })}${errorBox(err.message)}`;
  }
}

function renderClaim() {
  if (!me.user) {
    app.innerHTML = `${pageHead('Set up an organisation', { back: true })}${signInPrompt('Sign in to set up an organisation', 'You need a Jumpseat account with a confirmed Roblox account first.')}`;
    return;
  }
  if (!me.user.confirmed) {
    app.innerHTML = `
      ${pageHead('Set up an organisation', { back: true })}
      <section class="prompt">
        <p class="kicker">One step first</p>
        <h1 class="display">Confirm your Roblox account</h1>
        <p class="lede">To set up an airline, store or other organisation, your Roblox account has to be confirmed. It takes about a minute: paste a short code into your Roblox About section.</p>
        <div class="cta"><a class="btn primary" href="#/me">Confirm my account ${BADGE_HTML.confirmed}</a></div>
      </section>`;
    return;
  }
  app.innerHTML = `
    ${pageHead('Set up an organisation', { back: true })}
    <p class="lede" style="margin:20px 0;font-size:16px">Add your airline or store, then verify it by signing in with the Roblox account that owns the group. Verified organisations can post roles and updates.</p>
    <section class="surface">
      <form class="form" data-form="claim">
        <label class="field">Type
          <select name="kind">
            ${kindOptionsHtml()}
          </select>
        </label>
        <label class="field">Name<input name="name" required maxlength="40"></label>
        <label class="field">Roblox group ID<input name="robloxGroupId" required inputmode="numeric" pattern="\\d{1,12}" placeholder="e.g. 1234567"></label>
        <label class="field">Description<textarea name="description" rows="3" maxlength="500"></textarea></label>
        <label class="field">Discord invite (optional)<input name="discordInvite" placeholder="https://discord.gg/…"></label>
        <label class="field">Discord webhook (optional, receives applications)
          <input name="discordWebhook" type="password" autocomplete="off" placeholder="https://discord.com/api/webhooks/…"></label>
        <label class="field">How to apply (optional, shown on every role)
          <textarea name="applyInstructions" rows="3" maxlength="400" placeholder="e.g. Join our group, then open the Applications centre in the game."></textarea></label>
        <div><button class="btn primary" type="submit">Create</button></div>
        <p class="form-status" data-status></p>
      </form>
    </section>`;

  bindForm('[data-form="claim"]', (data) => send('POST', '/api/airlines', data), async (org, form) => {
    await loadMe();
    form.outerHTML = `
      <div class="surface form">
        <h2>${esc(org.name)} is set up</h2>
        <p class="muted">Verify it to unlock posting and roles. Sign in with the Roblox account that owns the group.</p>
        <div><a class="btn primary" href="${esc(org.verifyUrl)}">${icon('shield', { size: 16 })} Verify with Roblox</a></div>
      </div>`;
  });
}

// ---------- views: profiles ----------

async function renderUser(username) {
  app.innerHTML = `${pageHead('Profile', { back: true })}${loading}`;
  try {
    const u = await api(`/api/users/${encodeURIComponent(username)}`);
    const runs = u.airlines.length
      ? `<p class="muted">Runs ${u.airlines.map((a) => `<a class="tag-link" href="#/airline/${esc(a.slug)}">${esc(a.name)}</a>`).join(', ')}</p>`
      : '';

    let actions = '';
    if (u.isMe) {
      actions = '<a class="btn secondary" href="#/me">Edit profile</a>';
    } else if (!me.user) {
      actions = '<a class="btn secondary" href="/auth/login">Sign in to follow or message</a>';
    } else {
      actions = `<button class="btn ${u.followedByMe ? 'secondary' : 'primary'}" data-action="follow" data-type="user" data-id="${esc(u.id)}">${u.followedByMe ? 'Following' : 'Follow'}</button>`;
      if (u.blockedByMe) {
        actions += ` <button class="btn secondary" data-action="block-user" data-id="${esc(u.id)}">${icon('block', { size: 15 })} Unblock</button>`;
      } else if (u.canMessage) {
        actions += ` <button class="btn secondary" data-action="message" data-username="${esc(u.username)}">${icon('message', { size: 15 })} Message</button>`;
      }
    }

    app.innerHTML = `
      ${pageHead(u.displayName, { back: true })}
      <section class="profile">
        <div class="profile-top">
          ${avatar(u.displayName, { size: 'lg' })}
          <div class="profile-id">
            <h1>${nameLine(u.displayName, { badges: u.badges })}</h1>
            <p class="handle">@${esc(u.username)}${u.confirmedRobloxName ? ` · Roblox @${esc(u.confirmedRobloxName)}` : ''}</p>
            ${u.bio ? `<p class="bio">${esc(u.bio)}</p>` : ''}
            ${runs}
            <div class="stats"><span><b>${u.followers}</b> followers</span><span><b>${u.following}</b> following</span><span><b>${u.posts.length}</b> posts</span></div>
          </div>
        </div>
        <div class="profile-actions">${actions}</div>
      </section>
      <div class="feed" style="margin-top:4px">${u.posts.length ? u.posts.map(postCard).join('') : '<p class="empty">No posts yet.</p>'}</div>`;
  } catch (err) {
    app.innerHTML = `${pageHead('Profile', { back: true })}${errorBox(err.message)}`;
  }
}

// The Roblox confirmation card. Three states: confirmed, code issued, or not started.
function confirmCard() {
  const u = me.user;
  if (u.confirmed) {
    return `
      <section class="surface confirm-card done">
        <div class="confirm-top">${BADGE_HTML.confirmed}<div><strong>Account confirmed</strong><p class="muted small">Roblox @${esc(u.robloxUsername || '')} is linked to this account.</p></div></div>
      </section>`;
  }
  if (me.pendingRoblox) {
    const p = me.pendingRoblox;
    return `
      <section class="surface confirm-card">
        <h2>Confirm your Roblox account</h2>
        <p class="muted">Add this code to the About section of <strong>@${esc(p.robloxUsername)}</strong> on Roblox, save your profile, then press Check.</p>
        <div class="code-row">
          <code class="code-box" id="confirm-code">${esc(p.code)}</code>
          <button class="btn secondary small" data-action="copy-code" data-code="${esc(p.code)}">${icon('copy', { size: 15 })} Copy</button>
        </div>
        <p class="muted small">Valid until ${clock(p.expiresAt)} today. Roblox may take a moment to show a new About text.</p>
        <div class="profile-actions">
          <button class="btn primary" data-action="roblox-check">Check now</button>
          <button class="btn secondary" data-action="roblox-cancel">Cancel</button>
          ${me.devLogin ? '<button class="btn danger" data-action="roblox-dev">Confirm without check (dev only)</button>' : ''}
        </div>
      </section>`;
  }
  return `
    <section class="surface confirm-card">
      <h2>Confirm your Roblox account</h2>
      <p class="muted">Needed before you can set up an airline, Roblox store or other organisation. You will get a short code to paste into your Roblox About. Nothing else is shared.</p>
      <form class="form" data-form="roblox-start">
        <label class="field">Your Roblox username<input name="username" required minlength="3" maxlength="20" pattern="[A-Za-z0-9_]{3,20}" autocomplete="off" placeholder="e.g. YourRobloxName"></label>
        <div class="profile-actions"><button class="btn primary" type="submit">Get my code</button>${me.devLogin ? '<button class="btn danger" type="button" data-action="roblox-dev">Confirm without check (dev only)</button>' : ''}</div>
        <p class="form-status" data-status></p>
      </form>
    </section>`;
}

function renderMe() {
  if (!me.user) {
    app.innerHTML = `${pageHead('Profile')}${signInPrompt('Your Jumpseat account', 'Sign in with Discord or Roblox to post, follow, apply and message.')}`;
    return;
  }
  const listings = me.airlines.length
    ? `<div class="list">${me.airlines.map((a) => `
        <a class="row" href="#/airline/${esc(a.slug)}">
          ${avatar(a.name, { airline: true })}
          <div class="row-main">
            <div class="row-title">${esc(a.name)}${a.verified ? VERIFIED : ''}<span class="kind">${esc(a.kindLabel)}</span></div>
            <div class="row-sub">${a.verified ? 'Verified' : 'Waiting for verification'}</div>
          </div>
          ${icon('chevron', { size: 18 })}
        </a>`).join('')}</div>`
    : '<p class="muted">You have not set up an organisation yet.</p>';

  app.innerHTML = `
    ${pageHead('Profile')}
    <section class="profile">
      <div class="profile-top">
        ${avatar(me.user.displayName, { size: 'lg' })}
        <div class="profile-id">
          <h1>${nameLine(me.user.displayName, { badges: me.user.badges })}</h1>
          <p class="handle">@${esc(me.user.username)}</p>
          ${me.user.bio ? `<p class="bio">${esc(me.user.bio)}</p>` : ''}
          <div class="stats"><span><b>${me.following}</b> following</span></div>
        </div>
      </div>
      <div class="profile-actions">
        <a class="btn secondary" href="#/u/${esc(me.user.username)}">View public profile</a>
        ${me.isAdmin ? '<a class="btn secondary" href="#/admin">Admin tools</a>' : ''}
        <button class="btn danger" data-action="logout">${icon('logout', { size: 16 })} Sign out</button>
      </div>
    </section>

    <div class="section-head"><h2>Appearance</h2></div>
    <section class="surface">
      <p class="muted small" style="margin-bottom:12px">Follow your system, or pick light or dark. Stored in this browser.</p>
      ${seg('theme', [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']], themePref())}
    </section>

    <div class="section-head"><h2>Account</h2></div>
    ${confirmCard()}
    <section class="surface badge-key">
      <div class="key-row">${BADGE_HTML.confirmed}<span class="muted small">Confirmed account. Roblox linked with a code.</span></div>
      <div class="key-row">${BADGE_HTML.member}<span class="muted small">Jumpseat verified member, granted by admins.</span></div>
      <div class="key-row">${BADGE_HTML.admin}<span class="muted small">Admin.</span></div>
      <div class="key-row">${VERIFIED}<span class="muted small">Verified organisation. Its Roblox group owner has signed in.</span></div>
    </section>

    <div class="section-head"><h2>Edit profile</h2></div>
    <section class="surface">
      <form class="form" data-form="profile">
        <label class="field">Display name<input name="displayName" maxlength="40" value="${esc(me.user.displayName)}"></label>
        <label class="field">Bio<textarea name="bio" rows="3" maxlength="160">${esc(me.user.bio)}</textarea></label>
        <div><button class="btn primary small" type="submit">Save</button></div>
        <p class="form-status" data-status></p>
      </form>
    </section>

    <div class="section-head"><h2>Allowed links</h2></div>
    <p class="muted small">Links you allow open straight away. Anything else asks first.</p>
    ${(me.linkAllowlist || []).length ? `<div class="list">${me.linkAllowlist.map((e) => `
        <div class="row">
          <div class="row-main">
            <div class="row-title">${e.scope === 'kind' ? `All ${esc(LINK_KIND_LABELS[e.value] || e.value)} links` : esc(e.value)}</div>
            <div class="row-sub">${e.scope === 'kind' ? 'Kind' : 'Domain'}</div>
          </div>
          <button class="btn secondary small" data-action="unallow" data-scope="${esc(e.scope)}" data-value="${esc(e.value)}">Remove</button>
        </div>`).join('')}</div>` : '<p class="muted">No allowed links yet.</p>'}

    <div class="section-head"><h2>Your organisations</h2><a class="btn secondary small" href="#/claim">${icon('plus', { size: 16 })} Set up</a></div>
    ${listings}`;

  bindForm('[data-form="roblox-start"]', (data) => send('POST', '/api/me/roblox/start', { username: data.username }), async (result) => {
    me.pendingRoblox = { code: result.code, robloxUsername: result.robloxUsername, expiresAt: result.expiresAt };
    renderMe();
  });
  bindForm('[data-form="profile"]', (data) => send('PATCH', '/api/me', data), async () => {
    toast('Profile saved');
    await loadMe();
    renderMe();
  });
}

// ---------- views: admin ----------

async function renderAdmin() {
  if (!me.user || !me.isAdmin) {
    app.innerHTML = `${pageHead('Admin', { back: true })}<p class="empty">Admins only.</p>`;
    return;
  }
  app.innerHTML = `
    ${pageHead('Admin tools', { back: true })}
    <div class="toolbar" style="padding-top:16px">${seg('admin', [['overview', 'Overview'], ['reports', 'Reports'], ['members', 'Members'], ['orgs', 'Organisations']], adminTab)}</div>
    <div id="admin-pane">${loading}</div>`;
  if (adminTab === 'overview') loadAdminOverview();
  else if (adminTab === 'reports') loadAdminReports();
  else if (adminTab === 'orgs') loadAdminOrgs('');
  else loadAdminMembers('');
}

async function loadAdminReports() {
  const pane = $('#admin-pane');
  try {
    const r = await api('/api/admin/reports');
    const posts = r.posts.length
      ? r.posts.map((item) => `
          <article class="surface report">
            <div class="report-meta">
              <span class="pill">${plural(item.reportCount, 'report')}</span>
              ${item.hidden ? '<span class="pill pill-warn">Hidden</span>' : ''}
              <span class="muted small">${esc(item.reasons.join(' · '))}</span>
            </div>
            ${postCard(item.post)}
            <div class="profile-actions">
              <button class="btn secondary small" data-action="admin-restore" data-id="${esc(item.post.id)}">Restore</button>
              <button class="btn danger small" data-action="admin-remove" data-id="${esc(item.post.id)}">Remove post</button>
            </div>
          </article>`).join('')
      : '<p class="empty">No reported posts.</p>';
    const dms = r.conversations.length
      ? r.conversations.map((c) => `
          <div class="row">
            <div class="row-main"><div class="row-title">Conversation report</div><div class="row-sub">${esc(c.reason)} · from @${esc(c.reporter.username)} · ${timeAgo(c.createdAt)}</div></div>
          </div>`).join('')
      : '<p class="empty">No conversation reports.</p>';
    pane.innerHTML = `
      <div class="section-head"><h2>Reported posts</h2></div>
      <div class="stack">${posts}</div>
      <div class="section-head"><h2>Reported conversations</h2></div>
      <p class="muted small">Message content is not shown here. Open a report with the moderation process before reading anything.</p>
      <div class="list">${dms}</div>`;
  } catch (err) {
    pane.innerHTML = errorBox(err.message);
  }
}

async function loadAdminMembers(q) {
  const pane = $('#admin-pane');
  pane.innerHTML = `
    <div class="search" style="margin-top:16px">${icon('search', { size: 18 })}<input id="member-q" type="search" placeholder="Find a member by username" value="${esc(q)}" aria-label="Find member"></div>
    <div id="member-list" class="list" style="margin-top:8px">${loading}</div>`;
  let timer;
  $('#member-q').addEventListener('input', (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => loadAdminMembers(e.target.value.trim()), 250);
  });
  try {
    const users = await api(`/api/admin/users?q=${encodeURIComponent(q)}`);
    $('#member-list').innerHTML = users.length
      ? users.map((u) => `
          <div class="row">
            ${avatar(u.displayName)}
            <div class="row-main">
              <div class="row-title">${nameLine(u.displayName, { badges: u.badges })}</div>
              <div class="row-sub">@${esc(u.username)}${u.confirmed ? '' : ' · not confirmed'}</div>
            </div>
            <button class="btn ${u.verifiedMember ? 'secondary' : 'primary'} small" data-action="admin-member" data-id="${esc(u.id)}" data-value="${u.verifiedMember ? '0' : '1'}">${u.verifiedMember ? 'Remove gold check' : 'Grant gold check'}</button>
          </div>`).join('')
      : '<p class="empty">No matching members.</p>';
  } catch (err) {
    $('#member-list').innerHTML = errorBox(err.message);
  }
}

async function loadAdminOverview() {
  const pane = $('#admin-pane');
  try {
    const { counts: c, admins, audit } = await api('/api/admin/overview');
    const tiles = [
      ['Members', c.users], ['Online now', c.online], ['Confirmed', c.confirmed], ['Gold checks', c.members],
      ['Verified orgs', `${c.verifiedOrgs} / ${c.orgs}`], ['Open roles', c.openRoles],
      ['Posts', c.posts], ['Hidden posts', c.hiddenPosts], ['Reported posts', c.reportedPosts], ['Conversation reports', c.conversationReports],
    ].map(([label, value]) => `<div class="stat"><strong>${esc(value)}</strong><span class="muted">${esc(label)}</span></div>`).join('');
    pane.innerHTML = `
      <div class="stat-grid">${tiles}</div>
      <div class="section-head"><h2>Admins</h2></div>
      <p class="muted small">Set in server configuration (ADMIN_USERNAMES): ${admins.length ? admins.map((a) => `@${esc(a)}`).join(', ') : 'none'}</p>
      <div class="section-head"><h2>Recent admin actions</h2></div>
      <div class="list">${audit.length
        ? audit.map((a) => `
            <div class="row">
              <div class="row-main">
                <div class="row-title">${esc(a.action)} <span class="handle-sm">${esc(a.target)}</span></div>
                <div class="row-sub">by @${esc(a.actor)} · ${timeAgo(a.createdAt)}</div>
              </div>
            </div>`).join('')
        : '<p class="empty">No admin actions yet.</p>'}</div>`;
  } catch (err) {
    pane.innerHTML = errorBox(err.message);
  }
}

async function loadAdminOrgs(q) {
  const pane = $('#admin-pane');
  pane.innerHTML = `
    <div class="search" style="margin-top:16px">${icon('search', { size: 18 })}<input id="org-q" type="search" placeholder="Find an organisation" value="${esc(q)}" aria-label="Find organisation"></div>
    <div id="org-list" class="list" style="margin-top:8px">${loading}</div>`;
  let timer;
  $('#org-q').addEventListener('input', (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => loadAdminOrgs(e.target.value.trim()), 250);
  });
  try {
    const orgs = await api(`/api/admin/orgs?q=${encodeURIComponent(q)}`);
    $('#org-list').innerHTML = orgs.length
      ? orgs.map((o) => `
          <div class="row">
            ${avatar(o.name, { airline: true })}
            <div class="row-main">
              <div class="row-title">${esc(o.name)}${o.verified ? VERIFIED : ''}<span class="kind">${esc(o.kindLabel)}</span></div>
              <div class="row-sub">Owner ${o.ownerUsername ? `@${esc(o.ownerUsername)}` : 'none'} · created by ${o.createdByUsername ? `@${esc(o.createdByUsername)}` : 'unknown'} · ${o.openRoles} roles · ${o.posts} posts</div>
            </div>
            <div class="row-actions">
              ${o.verified ? `<button class="btn secondary small" data-action="admin-unverify" data-id="${esc(o.slug)}">Unverify</button>` : ''}
              <button class="btn danger small" data-action="admin-remove-org" data-id="${esc(o.slug)}">Remove</button>
            </div>
          </div>`).join('')
      : '<p class="empty">No organisations match.</p>';
  } catch (err) {
    $('#org-list').innerHTML = errorBox(err.message);
  }
}

// ---------- routing ----------

const routes = [
  [/^#\/?$/, () => renderHome()],
  [/^#\/feed$/, () => renderFeed()],
  [/^#\/discover(?:\?q=(.*))?$/, (m) => renderDiscover(safeDecode(m[1]))],
  [/^#\/messages$/, () => renderMessages()],
  [/^#\/messages\/([\w-]+)$/, (m) => renderThread(m[1])],
  [/^#\/jobs$/, () => renderJobs()],
  [/^#\/job\/([\w-]+)$/, (m) => renderJob(m[1])],
  [/^#\/airlines$/, () => renderAirlines()],
  [/^#\/airline\/([\w-]+)$/, (m) => renderAirline(m[1])],
  [/^#\/u\/(\w+)$/, (m) => renderUser(m[1])],
  [/^#\/post\/([\w-]+)$/, (m) => renderPost(m[1])],
  [/^#\/tag\/(\w+)$/, (m) => renderTag(m[1])],
  [/^#\/me$/, () => renderMe()],
  [/^#\/admin$/, () => renderAdmin()],
  [/^#\/claim$/, () => renderClaim()],
];

function renderRoute() {
  const hash = location.hash || '#/';
  stopThreadPoll();
  document.body.classList.toggle('in-thread', /^#\/messages\/[\w-]+$/.test(hash));
  window.scrollTo(0, 0);
  renderChrome();
  renderRail();
  renderThemeToggle();
  for (const [pattern, handler] of routes) {
    const match = hash.match(pattern);
    if (match) return handler(match);
  }
  app.innerHTML = `${pageHead('Not found', { back: true })}<p class="empty">That page does not exist.</p>`;
  return undefined;
}

// Cross-fade between views where the browser supports it. Motion is skipped under reduced-motion.
function route() {
  if (document.startViewTransition && !REDUCED_MOTION.matches) {
    document.startViewTransition(() => renderRoute());
  } else {
    renderRoute();
  }
}

// Clicks are handled in one place: tabs, like, report, delete, follow, DMs, confirmation, admin, sign out.
app.addEventListener('click', async (e) => {
  const tab = e.target.closest('[data-tab]');
  if (tab) {
    const value = tab.dataset.tab;
    if (tab.dataset.scope === 'home') homeTab = value;
    else if (tab.dataset.scope === 'airline') airlineTab = value;
    else if (tab.dataset.scope === 'messages') messagesTab = value;
    else if (tab.dataset.scope === 'admin') {
      adminTab = value;
      renderAdmin();
      return;
    } else if (tab.dataset.scope === 'theme') {
      setTheme(value);
      renderMe();
      renderThemeToggle();
      return;
    } else if (tab.dataset.scope === 'jobs') return; // handled by the jobs filter listener
    route();
    return;
  }

  const closer = e.target.closest('[data-close]');
  if (closer) {
    closer.closest('.sheet-backdrop')?.remove();
    return;
  }
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  btn.closest('.sheet-backdrop')?.remove();
  const { action, id } = btn.dataset;
  try {
    if (action === 'back') {
      if (history.length > 1) history.back();
      else location.hash = '#/';
    } else if (action === 'like') {
      const r = await send('POST', `/api/posts/${id}/like`);
      btn.classList.toggle('on', r.liked);
      btn.setAttribute('aria-pressed', String(r.liked));
      btn.innerHTML = `${icon('heart', { filled: r.liked, size: 18 })}<span>${r.likeCount}</span>`;
      if (r.liked) btn.querySelector('svg').classList.add('pop');
    } else if (action === 'report') {
      if (!confirm('Report this post to the moderators?')) return;
      await send('POST', `/api/posts/${id}/report`, { reason: 'reported from feed' });
      btn.disabled = true;
      toast('Thanks. The post has been reported.');
    } else if (action === 'delete') {
      if (!confirm('Delete this post? This cannot be undone.')) return;
      await send('DELETE', `/api/posts/${id}`);
      toast('Post deleted');
      if (location.hash.startsWith('#/post/')) location.hash = '#/';
      else btn.closest('[data-post]')?.remove();
    } else if (action === 'delete-comment') {
      if (!confirm('Delete this comment?')) return;
      await send('DELETE', `/api/comments/${id}`);
      btn.closest('.comment')?.remove();
    } else if (action === 'follow') {
      await send('POST', '/api/follows', { targetType: btn.dataset.type, targetId: id });
      await loadMe();
      route();
    } else if (action === 'message') {
      const conv = await send('POST', '/api/conversations', { username: btn.dataset.username });
      location.hash = `#/messages/${conv.id}`;
    } else if (action === 'block-user' || action === 'block-dm' || action === 'unblock-dm') {
      if (action === 'block-dm' && !confirm('Block this account? They will not be able to message you, and you will not be able to message them.')) return;
      const r = await send('POST', `/api/users/${id}/block`);
      toast(r.blocked ? 'Blocked' : 'Unblocked');
      route();
    } else if (action === 'accept-dm') {
      await send('POST', `/api/conversations/${id}/accept`);
      toast('Request accepted');
      route();
    } else if (action === 'decline-dm') {
      if (!confirm('Decline this request? They will not be able to message you here.')) return;
      await send('POST', `/api/conversations/${id}/decline`);
      location.hash = '#/messages';
    } else if (action === 'report-dm') {
      if (!confirm('Report this conversation to the moderators? The other person will not be told.')) return;
      await send('POST', `/api/conversations/${id}/report`, { reason: 'reported conversation' });
      toast('Report sent');
    } else if (action === 'open-link') {
      const url = btn.dataset.url;
      if (isAllowed(url)) window.open(url, '_blank', 'noopener,noreferrer');
      else openLinkDialog(url);
    } else if (action === 'unallow') {
      me.linkAllowlist = await send('DELETE', '/api/me/link-allowlist', { scope: btn.dataset.scope, value: btn.dataset.value });
      toast('Removed');
      renderMe();
    } else if (action === 'thread-menu') {
      openThreadMenu(currentThread);
    } else if (action === 'theme-toggle') {
      setTheme(isDark() ? 'light' : 'dark');
      renderChrome();
      renderThemeToggle();
    } else if (action === 'copy-code') {
      await navigator.clipboard.writeText(btn.dataset.code);
      toast('Code copied');
    } else if (action === 'roblox-check') {
      btn.disabled = true;
      try {
        await send('POST', '/api/me/roblox/check');
        toast('Confirmed. The green house is on your profile.');
        await loadMe();
        route();
      } finally {
        btn.disabled = false;
      }
    } else if (action === 'roblox-cancel') {
      await send('POST', '/api/me/roblox/cancel');
      me.pendingRoblox = null;
      renderMe();
    } else if (action === 'roblox-dev') {
      await send('POST', '/api/me/roblox/dev-confirm');
      toast('Confirmed (dev)');
      await loadMe();
      route();
    } else if (action === 'admin-restore') {
      await send('POST', `/api/admin/posts/${id}/restore`);
      toast('Post restored');
      loadAdminReports();
    } else if (action === 'admin-remove') {
      if (!confirm('Remove this post permanently?')) return;
      await send('POST', `/api/admin/posts/${id}/remove`);
      toast('Post removed');
      loadAdminReports();
    } else if (action === 'admin-member') {
      const r = await send('POST', `/api/admin/users/${id}/member`, { verified: btn.dataset.value === '1' });
      toast(r.badges.includes('member') ? 'Gold check granted' : 'Gold check removed');
      loadAdminMembers($('#member-q')?.value.trim() || '');
    } else if (action === 'admin-unverify') {
      if (!confirm('Remove the verified check from this organisation? Its owner loses posting rights until they verify again.')) return;
      await send('POST', `/api/admin/orgs/${id}/unverify`);
      toast('Verification removed');
      loadAdminOrgs($('#org-q')?.value.trim() || '');
    } else if (action === 'admin-remove-org') {
      if (!confirm('Remove this organisation, its roles and its posts? This cannot be undone.')) return;
      await send('POST', `/api/admin/orgs/${id}/remove`);
      toast('Organisation removed');
      loadAdminOrgs($('#org-q')?.value.trim() || '');
    } else if (action === 'logout') {
      await send('POST', '/auth/logout');
      await loadMe();
      location.hash = '#/';
      route();
      toast('Signed out');
    }
  } catch (err) {
    toast(err.message);
  }
});

// Account form for Roblox confirmation: the Get-code form is bound in renderMe. Nothing else to wire here.

// Start the router last, after every view and handler is defined.
window.addEventListener('hashchange', route);
applyTheme(themePref());
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(themePref()));
Promise.all([loadMe(), loadMeta()]).then(() => {
  route();
  refreshUnread();
  setInterval(refreshUnread, 15000);
});
