'use strict';

const $ = (selector, root = document) => root.querySelector(selector);
const app = $('#app');

const ROLE_FILTERS = [['', 'All'], ['pilot', 'Pilots'], ['cabin-crew', 'Cabin crew'], ['ground', 'Ground ops']];
const ROLE_OPTIONS = { pilot: 'Pilot', 'cabin-crew': 'Cabin crew', ground: 'Ground ops' };

// ---------- helpers ----------

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

// Escape first, then turn #hashtags into links. Tags are [A-Za-z0-9_] only, so nothing unsafe gets through.
const linkify = (text) =>
  esc(text).replace(/#([A-Za-z0-9_]{2,30})/g, (_, tag) => `<a class="tag-link" href="#/tag/${tag.toLowerCase()}">#${tag}</a>`);

const loading = '<p class="empty">Loading…</p>';
const errorBox = (message) => `<p class="error-box">${esc(message)}</p>`;
const initial = (name) => esc(String(name || '?').trim().charAt(0).toUpperCase() || '?');
const safeDecode = (value) => {
  try { return decodeURIComponent(value || ''); } catch { return ''; }
};

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

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
const send = (method, path, data) => api(path, { method, body: data === undefined ? undefined : JSON.stringify(data) });

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
  home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
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
  external: '<path d="M14 4h6v6M20 4 10 14M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  shield: '<path d="M12 3 4 6v6c0 4.5 3.4 8.2 8 9 4.6-.8 8-4.5 8-9V6z"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18.5 14.5A6.5 6.5 0 0 1 21.5 20"/>',
};
const icon = (name, { filled = false, size = 20 } = {}) =>
  `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="${filled ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;

const VERIFIED = '<svg class="verified" viewBox="0 0 24 24" role="img" aria-label="Verified"><circle cx="12" cy="12" r="11" fill="currentColor"/><path d="M7.5 12.5l3 3 6-6.5" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// Solid, muted avatar colors. Each name maps to one of these, so avatars stay consistent.
const AVATAR_COLORS = ['#3b4a63', '#4b3f63', '#3e5c4e', '#5e4b3a', '#3a5561', '#5a3e4c', '#4a5a3a', '#3e4a5e'];
const avatarColor = (seed) => {
  const sum = [...String(seed)].reduce((a, c) => a + c.charCodeAt(0), 0);
  return AVATAR_COLORS[sum % AVATAR_COLORS.length];
};
const avatar = (name, { airline = false, size = '' } = {}) =>
  `<span class="avatar${airline ? ' sq' : ''}${size ? ` ${size}` : ''}" style="background:${avatarColor(name)}" aria-hidden="true">${initial(name)}</span>`;

// ---------- state ----------

let me = { user: null, airlines: [] };
let homeTab = 'following';
let airlineTab = 'posts';
let airlineTabFor = null;
let jobFilter = { role: '', q: '' };

const NAV = [
  { href: '#/', icon: 'home', label: 'Home', match: /^#\/?$/ },
  { href: '#/discover', icon: 'search', label: 'Discover', match: /^#\/discover/ },
  { href: '#/jobs', icon: 'jobs', label: 'Jobs', match: /^#\/(jobs|job\/)/ },
  { href: '#/airlines', icon: 'plane', label: 'Airlines', match: /^#\/(airlines|airline\/|claim)/ },
  { href: '#/me', icon: 'user', label: 'Profile', match: /^#\/(me|u\/)/ },
];

function renderChrome() {
  const hash = location.hash || '#/';
  $('#side-nav').innerHTML = NAV.map((n) =>
    `<a class="side-link${n.match.test(hash) ? ' active' : ''}" href="${n.href}">${icon(n.icon, { size: 22 })}<span>${n.label}</span></a>`).join('');
  $('#tabbar').innerHTML = NAV.map((n) =>
    `<a class="tab-link${n.match.test(hash) ? ' active' : ''}" href="${n.href}">${icon(n.icon, { size: 24 })}<span>${n.label}</span></a>`).join('');

  $('#account').innerHTML = me.user
    ? `<a class="account" href="#/me">${avatar(me.user.displayName)}<span class="account-text"><strong>${esc(me.user.displayName)}</strong><span class="muted">@${esc(me.user.username)}</span></span></a>`
    : '<a class="btn primary wide" href="/auth/login">Sign in with Roblox</a>';
}

async function loadMe() {
  try {
    me = await api('/api/me');
  } catch {
    me = { user: null, airlines: [] };
  }
  renderChrome();
}

async function renderRail() {
  const rail = $('#rail');
  rail.innerHTML = `
    <section class="surface rail-card"><h3>Trending</h3><div id="rail-tags">${loading}</div></section>
    <section class="surface rail-card"><h3>Airlines</h3><div id="rail-airlines">${loading}</div></section>
    <p class="fine">Jumpseat is a fan project. It is not affiliated with Roblox Corporation or any airline.</p>`;
  try {
    const [tags, airlines] = await Promise.all([api('/api/tags'), api('/api/airlines')]);
    $('#rail-tags').innerHTML = tags.length
      ? tags.slice(0, 5).map((t) => `<a class="tag-row" href="#/tag/${esc(t.tag)}"><span>#${esc(t.tag)}</span><span class="muted">${t.count} posts</span></a>`).join('')
      : '<p class="muted">No tags yet.</p>';
    $('#rail-airlines').innerHTML = airlines.length
      ? airlines.slice(0, 4).map((a) => `
          <a class="rail-airline" href="#/airline/${esc(a.slug)}">
            ${avatar(a.name, { airline: true, size: 'sm' })}
            <span class="rail-airline-text">
              <strong>${esc(a.name)}${a.verified ? VERIFIED : ''}</strong>
              <span class="muted">${a.followers} follower${a.followers === 1 ? '' : 's'}</span>
            </span>
          </a>`).join('')
      : '<p class="muted">No airlines yet.</p>';
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

function postCard(p) {
  const isAirline = p.author.type === 'airline';
  const href = isAirline ? `#/airline/${esc(p.author.slug)}` : `#/u/${esc(p.author.username)}`;
  const handle = isAirline ? 'Airline' : `@${p.author.username}`;
  return `
    <article class="post" data-post="${esc(p.id)}">
      <a class="post-avatar" href="${href}" tabindex="-1">${avatar(p.author.name, { airline: isAirline })}</a>
      <div class="post-main">
        <header class="post-head">
          <a class="post-name" href="${href}">${esc(p.author.name)}</a>${p.author.verified ? VERIFIED : ''}
          <span class="post-handle">${esc(handle)} · ${timeAgo(p.createdAt)}</span>
          ${p.canDelete ? `<button class="icon-btn quiet" data-action="delete" data-id="${esc(p.id)}" aria-label="Delete post">${icon('trash', { size: 16 })}</button>` : ''}
        </header>
        <div class="post-body">${linkify(p.body)}</div>
        ${p.imageUrl ? `<img class="post-img" src="${esc(p.imageUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}
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
        <div class="row-sub">${esc(job.airline?.name || 'Unknown airline')}${job.airline?.verified ? VERIFIED : ''}</div>
      </div>
      <div class="row-end"><span class="pill">${esc(job.roleLabel)}</span><span>${timeAgo(job.createdAt)}</span></div>
    </a>`;
}

function airlineRow(a) {
  return `
    <a class="row" href="#/airline/${esc(a.slug)}">
      ${avatar(a.name, { airline: true })}
      <div class="row-main">
        <div class="row-title">${esc(a.name)}${a.verified ? VERIFIED : ''}</div>
        <div class="row-sub clamp">${esc(a.description || 'No description yet.')}</div>
      </div>
      <div class="row-end"><span>${a.followers} follower${a.followers === 1 ? '' : 's'}</span></div>
    </a>`;
}

function userRow(u) {
  return `
    <a class="row" href="#/u/${esc(u.username)}">
      ${avatar(u.displayName)}
      <div class="row-main">
        <div class="row-title">${esc(u.displayName)}</div>
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
          <strong>${esc(c.author.name)}</strong><span class="post-handle">@${esc(c.author.username)} · ${timeAgo(c.createdAt)}</span>
          ${c.mine ? `<button class="icon-btn quiet" data-action="delete-comment" data-id="${esc(c.id)}" aria-label="Delete comment">${icon('trash', { size: 16 })}</button>` : ''}
        </div>
        <p>${linkify(c.body)}</p>
      </div>
    </div>`;
}

function composer(defaultAirlineSlug = null) {
  if (!me.user) return '';
  const owned = me.airlines.filter((a) => a.owner);
  const options = [
    `<option value="">Post as @${esc(me.user.username)}</option>`,
    ...owned.map((a) => `<option value="${esc(a.slug)}"${a.slug === defaultAirlineSlug ? ' selected' : ''}>Post as ${esc(a.name)}</option>`),
  ].join('');
  return `
    <form class="composer" data-form="composer">
      ${avatar(me.user.displayName)}
      <div class="composer-main">
        <textarea name="body" rows="2" maxlength="500" placeholder="What's happening in the skies?" aria-label="Post text" required></textarea>
        <div class="composer-tools">
          <label class="url-field">${icon('image', { size: 15 })}<input name="imageUrl" type="url" placeholder="Image link (https)" maxlength="500" aria-label="Image link"></label>
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
      <div class="cta"><a class="btn primary" href="/auth/login">Sign in with Roblox</a></div>
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
    imageUrl: data.imageUrl || undefined,
    airlineSlug: data.airlineSlug || undefined,
  }), () => {
    toast('Posted');
    route();
  });
}

// ---------- views: home ----------

async function loadFeed() {
  const feed = $('#feed');
  try {
    let posts = me.user && homeTab === 'following' ? await api('/api/feed') : await api('/api/posts?sort=top');
    let notice = '';
    if (me.user && homeTab === 'following' && !posts.length) {
      // Nothing followed yet: show what is popular and say why.
      posts = await api('/api/posts?sort=top');
      notice = '<div class="surface notice">You are not following anyone yet. Follow airlines or crew in Discover and their posts will land here. Popular posts are shown for now.</div>';
    }
    feed.innerHTML = notice + (posts.length ? posts.map(postCard).join('') : '<p class="empty">No posts yet. Be the first to post.</p>');
  } catch (err) {
    feed.innerHTML = errorBox(err.message);
  }
}

function renderHome() {
  const welcome = me.user ? '' : `
    <section class="welcome">
      <p class="kicker">Roblox aviation, in one place</p>
      <h1 class="display">Your airline community, in one feed.</h1>
      <p class="lede">Follow the airlines you fly with, see what crews are posting, and apply to open roles without leaving the sky.</p>
      <div class="cta">
        <a class="btn primary" href="/auth/login">Sign in with Roblox</a>
        <a class="btn secondary" href="#/discover">Explore airlines</a>
      </div>
    </section>
    <section class="features">
      ${feature('plane', 'Follow airlines', 'Posts, hiring news and route updates from the carriers you like.')}
      ${feature('jobs', 'Apply once', 'One application goes straight to the airline’s Discord.')}
      ${feature('check', 'Verified owners', 'Airlines prove they own their Roblox group before posting roles.')}
    </section>`;

  const feedHead = me.user
    ? `<div class="toolbar">${seg('home', [['following', 'Following'], ['explore', 'Explore']], homeTab)}</div>`
    : '<div class="section-head"><h2>Popular right now</h2></div>';

  app.innerHTML = `${pageHead('Home')}${welcome}${composer()}${feedHead}<div id="feed" class="feed">${loading}</div>`;
  bindComposer();
  loadFeed();
}

function feature(iconName, title, text) {
  return `<div class="feature"><span class="feature-ic">${icon(iconName, { size: 20 })}</span><h3>${esc(title)}</h3><p>${esc(text)}</p></div>`;
}

// ---------- views: discover, tags ----------

function renderDiscover(q = '') {
  app.innerHTML = `
    ${pageHead('Discover')}
    <form id="search-form" class="search" role="search">
      ${icon('search', { size: 18 })}
      <input id="q" type="search" placeholder="Search airlines, people, posts, roles or #tags" value="${esc(q)}" aria-label="Search">
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
      resultSection('Airlines', r.airlines.length ? `<div class="list">${r.airlines.map(airlineRow).join('')}</div>` : ''),
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

// ---------- views: jobs ----------

function renderJobs() {
  app.innerHTML = `
    ${pageHead('Jobs')}
    <p class="lede" style="margin-top:20px;font-size:16px">Open roles from verified Roblox airlines. Applications go straight to the airline’s Discord.</p>
    <div class="toolbar" style="padding-top:14px">
      <label class="search" style="margin-top:0;flex:1 1 260px">${icon('search', { size: 18 })}
        <input id="search" type="search" placeholder="Search roles or airlines" aria-label="Search jobs" value="${esc(jobFilter.q)}">
      </label>
    </div>
    <div class="toolbar" style="padding-top:4px">${seg('jobs', ROLE_FILTERS, jobFilter.role)}</div>
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
  if (jobFilter.role) params.set('role', jobFilter.role);
  if (jobFilter.q) params.set('q', jobFilter.q);
  try {
    const jobs = await api(`/api/jobs?${params}`);
    list.innerHTML = jobs.length ? jobs.map(jobRow).join('') : '<p class="empty">No open roles match that yet.</p>';
  } catch (err) {
    list.innerHTML = errorBox(err.message);
  }
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
      <section class="surface apply">
        <h2>Apply</h2>
        <form class="form" data-form="apply">
          <label class="field">Roblox username
            <input name="robloxUsername" required minlength="3" maxlength="20" pattern="[A-Za-z0-9_]{3,20}" autocomplete="off" value="${esc(me.user?.username || '')}">
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
            ? 'The airline received it in their Discord.'
            : 'Saved. This airline has not connected a Discord yet, so it was not forwarded.'}</p>
          <div><a class="btn secondary" href="#/jobs">Back to roles</a></div>
        </div>`;
    });
  } catch (err) {
    app.innerHTML = `${pageHead('Role', { back: true })}${errorBox(err.message)}`;
  }
}

// ---------- views: airlines ----------

async function renderAirlines() {
  app.innerHTML = `
    ${pageHead('Airlines')}
    <div class="toolbar" style="padding-top:18px">
      <span class="muted grow">Verified airlines post roles and updates. Unverified ones are still listed.</span>
      <a class="btn primary small" href="#/claim">${icon('plus', { size: 16 })} List airline</a>
    </div>
    <div id="list" class="list">${loading}</div>`;
  try {
    const airlines = await api('/api/airlines');
    $('#list').innerHTML = airlines.length ? airlines.map(airlineRow).join('') : '<p class="empty">No airlines yet.</p>';
  } catch (err) {
    $('#list').innerHTML = errorBox(err.message);
  }
}

async function renderAirline(slug) {
  if (airlineTabFor !== slug) {
    airlineTab = 'posts';
    airlineTabFor = slug;
  }
  app.innerHTML = `${pageHead('Airline', { back: true })}${loading}`;
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
                <select name="role">${Object.entries(ROLE_OPTIONS).map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
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
            <p class="handle">${a.verified ? 'Verified airline' : 'Unverified airline'}${a.sample ? ' · sample' : ''}</p>
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
    app.innerHTML = `${pageHead('Airline', { back: true })}${errorBox(err.message)}`;
  }
}

function renderClaim() {
  if (!me.user) {
    app.innerHTML = `${pageHead('List an airline', { back: true })}${signInPrompt('Sign in to list your airline', 'Listing needs a Roblox account. You will verify the airline by signing in with the account that owns its group.')}`;
    return;
  }
  app.innerHTML = `
    ${pageHead('List an airline', { back: true })}
    <p class="lede" style="margin:20px 0;font-size:16px">Add your airline, then verify it by signing in with the Roblox account that owns the group. Verified airlines can post roles and updates.</p>
    <section class="surface">
      <form class="form" data-form="claim">
        <label class="field">Airline name<input name="name" required maxlength="40"></label>
        <label class="field">Roblox group ID<input name="robloxGroupId" required inputmode="numeric" pattern="\\d{1,12}" placeholder="e.g. 1234567"></label>
        <label class="field">Description<textarea name="description" rows="3" maxlength="500"></textarea></label>
        <label class="field">Discord invite (optional)<input name="discordInvite" placeholder="https://discord.gg/…"></label>
        <label class="field">Discord webhook (optional, receives applications)
          <input name="discordWebhook" type="password" autocomplete="off" placeholder="https://discord.com/api/webhooks/…"></label>
        <div><button class="btn primary" type="submit">Create listing</button></div>
        <p class="form-status" data-status></p>
      </form>
    </section>`;

  bindForm('[data-form="claim"]', (data) => send('POST', '/api/airlines', data), async (airline, form) => {
    await loadMe();
    form.outerHTML = `
      <div class="surface form">
        <h2>${esc(airline.name)} is listed</h2>
        <p class="muted">Verify it to unlock posting and roles. Sign in with the Roblox account that owns the group.</p>
        <div><a class="btn primary" href="${esc(airline.verifyUrl)}">${icon('shield', { size: 16 })} Verify with Roblox</a></div>
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
    let action = '';
    if (u.isMe) action = '<a class="btn secondary" href="#/me">Edit profile</a>';
    else if (me.user) action = `<button class="btn ${u.followedByMe ? 'secondary' : 'primary'}" data-action="follow" data-type="user" data-id="${esc(u.id)}">${u.followedByMe ? 'Following' : 'Follow'}</button>`;
    else action = '<a class="btn secondary" href="/auth/login">Sign in to follow</a>';

    app.innerHTML = `
      ${pageHead(u.displayName, { back: true })}
      <section class="profile">
        <div class="profile-top">
          ${avatar(u.displayName, { size: 'lg' })}
          <div class="profile-id">
            <h1>${esc(u.displayName)}</h1>
            <p class="handle">@${esc(u.username)}</p>
            ${u.bio ? `<p class="bio">${esc(u.bio)}</p>` : ''}
            ${runs}
            <div class="stats"><span><b>${u.followers}</b> followers</span><span><b>${u.following}</b> following</span><span><b>${u.posts.length}</b> posts</span></div>
          </div>
        </div>
        <div class="profile-actions">${action}</div>
      </section>
      <div class="feed" style="margin-top:4px">${u.posts.length ? u.posts.map(postCard).join('') : '<p class="empty">No posts yet.</p>'}</div>`;
  } catch (err) {
    app.innerHTML = `${pageHead('Profile', { back: true })}${errorBox(err.message)}`;
  }
}

function renderMe() {
  if (!me.user) {
    app.innerHTML = `${pageHead('Profile')}${signInPrompt('Your Jumpseat account', 'Sign in with Roblox to post, follow, apply and list your airline.')}`;
    return;
  }
  const listings = me.airlines.length
    ? `<div class="list">${me.airlines.map((a) => `
        <a class="row" href="#/airline/${esc(a.slug)}">
          ${avatar(a.name, { airline: true })}
          <div class="row-main">
            <div class="row-title">${esc(a.name)}${a.verified ? VERIFIED : ''}</div>
            <div class="row-sub">${a.verified ? 'Verified' : 'Waiting for verification'}</div>
          </div>
          ${icon('chevron', { size: 18 })}
        </a>`).join('')}</div>`
    : '<p class="muted">You have not listed an airline yet.</p>';

  app.innerHTML = `
    ${pageHead('Profile')}
    <section class="profile">
      <div class="profile-top">
        ${avatar(me.user.displayName, { size: 'lg' })}
        <div class="profile-id">
          <h1>${esc(me.user.displayName)}</h1>
          <p class="handle">@${esc(me.user.username)}</p>
          ${me.user.bio ? `<p class="bio">${esc(me.user.bio)}</p>` : ''}
          <div class="stats"><span><b>${me.following}</b> following</span></div>
        </div>
      </div>
      <div class="profile-actions">
        <a class="btn secondary" href="#/u/${esc(me.user.username)}">View public profile</a>
        <button class="btn danger" data-action="logout">${icon('logout', { size: 16 })} Sign out</button>
      </div>
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

    <div class="section-head"><h2>Your airlines</h2><a class="btn secondary small" href="#/claim">${icon('plus', { size: 16 })} List airline</a></div>
    ${listings}`;

  bindForm('[data-form="profile"]', (data) => send('PATCH', '/api/me', data), async () => {
    toast('Profile saved');
    await loadMe();
    renderMe();
  });
}

// ---------- routing ----------

const routes = [
  [/^#\/?$/, () => renderHome()],
  [/^#\/discover(?:\?q=(.*))?$/, (m) => renderDiscover(safeDecode(m[1]))],
  [/^#\/jobs$/, () => renderJobs()],
  [/^#\/job\/([\w-]+)$/, (m) => renderJob(m[1])],
  [/^#\/airlines$/, () => renderAirlines()],
  [/^#\/airline\/([\w-]+)$/, (m) => renderAirline(m[1])],
  [/^#\/u\/(\w+)$/, (m) => renderUser(m[1])],
  [/^#\/post\/([\w-]+)$/, (m) => renderPost(m[1])],
  [/^#\/tag\/(\w+)$/, (m) => renderTag(m[1])],
  [/^#\/me$/, () => renderMe()],
  [/^#\/claim$/, () => renderClaim()],
];

function route() {
  const hash = location.hash || '#/';
  window.scrollTo(0, 0);
  renderChrome();
  renderRail();
  for (const [pattern, handler] of routes) {
    const match = hash.match(pattern);
    if (match) return handler(match);
  }
  app.innerHTML = `${pageHead('Not found', { back: true })}<p class="empty">That page does not exist.</p>`;
  return undefined;
}

// Clicks are handled in one place: tabs, like, report, delete, follow, sign out, back.
app.addEventListener('click', async (e) => {
  const tab = e.target.closest('[data-tab]');
  if (tab) {
    const value = tab.dataset.tab;
    if (tab.dataset.scope === 'home') homeTab = value;
    else if (tab.dataset.scope === 'airline') airlineTab = value;
    if (tab.dataset.scope === 'jobs') return; // handled by the jobs filter listener
    route();
    return;
  }

  const btn = e.target.closest('[data-action]');
  if (!btn) return;
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

// Start the router last, after every view and handler is defined.
window.addEventListener('hashchange', route);
loadMe().then(route);
