'use strict';

const $ = (selector, root = document) => root.querySelector(selector);
const app = $('#app');

const ROLE_FILTERS = { '': 'All roles', pilot: 'Pilots', 'cabin-crew': 'Cabin crew', ground: 'Ground ops' };
const ROLE_OPTIONS = { pilot: 'Pilot', 'cabin-crew': 'Cabin crew', ground: 'Ground ops' };

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

// Escape first, then turn #hashtags into links. Tags are [A-Za-z0-9_] only, so nothing unsafe can slip through.
const linkify = (text) =>
  esc(text).replace(/#([A-Za-z0-9_]{2,30})/g, (_, tag) => `<a class="tag" href="#/tag/${tag.toLowerCase()}">#${tag}</a>`);

const loading = '<p class="muted">Loading…</p>';
const errorBox = (message) => `<div class="glass panel"><p class="error">${esc(message)}</p></div>`;
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

// ---------- state ----------

let me = { user: null, airlines: [] };
let homeTab = 'following';
let jobFilter = { role: '', q: '' };

async function loadMe() {
  try {
    me = await api('/api/me');
  } catch {
    me = { user: null, airlines: [] };
  }
  const account = $('#account');
  if (me.user) {
    account.textContent = `@${me.user.username}`;
    account.href = '#/me';
    account.className = 'btn ghost small';
  } else {
    account.textContent = 'Sign in';
    account.href = '/auth/login';
    account.className = 'btn small';
  }
}

const signInPrompt = (message) => `
  <section class="hero glass">
    <p class="eyebrow">Sign in</p>
    <h1>${esc(message)}</h1>
    <p class="lede">Jumpseat uses your Roblox account. No password to create.</p>
    <div class="hero-actions"><a class="btn" href="/auth/login">Sign in with Roblox</a></div>
  </section>`;

// ---------- components ----------

function postCard(p) {
  const isAirline = p.author.type === 'airline';
  const byline = isAirline
    ? `<a class="author-name" href="#/airline/${esc(p.author.slug)}">${esc(p.author.name)}</a>${p.author.verified ? ' <span class="verified">✓</span>' : ''}`
    : `<a class="author-name" href="#/u/${esc(p.author.username)}">${esc(p.author.name)}</a> <span class="muted">@${esc(p.author.username)}</span>`;
  return `
    <article class="glass post" data-post="${esc(p.id)}">
      <div class="post-head">
        <span class="avatar${isAirline ? ' airline' : ''}">${initial(p.author.name)}</span>
        <div class="post-meta">${byline}<span class="muted"> · ${timeAgo(p.createdAt)}</span></div>
        ${p.canDelete ? `<button class="link-btn" data-action="delete" data-id="${esc(p.id)}">Delete</button>` : ''}
      </div>
      <div class="post-body">${linkify(p.body)}</div>
      ${p.imageUrl ? `<img class="post-img" src="${esc(p.imageUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}
      <div class="post-actions">
        <button class="action${p.likedByMe ? ' on' : ''}" data-action="like" data-id="${esc(p.id)}">♥ ${p.likeCount}</button>
        <a class="action" href="#/post/${esc(p.id)}">Comments ${p.commentCount}</a>
        <button class="action" data-action="report" data-id="${esc(p.id)}">Report</button>
      </div>
    </article>`;
}

function jobCard(job) {
  return `
    <a class="card glass" href="#/job/${esc(job.id)}">
      <div class="job-top">
        <span class="pill">${esc(job.roleLabel)}</span>
        ${job.airline?.verified ? '<span class="verified">✓ Verified</span>' : ''}
      </div>
      <h3>${esc(job.title)}</h3>
      <p class="muted">${esc(job.airline?.name || 'Unknown airline')}</p>
    </a>`;
}

function airlineCard(a) {
  return `
    <a class="card glass" href="#/airline/${esc(a.slug)}">
      <div class="job-top">
        <span class="pill">${a.sample ? 'Sample' : 'Airline'}</span>
        ${a.verified ? '<span class="verified">✓ Verified</span>' : '<span class="muted">Unverified</span>'}
      </div>
      <h3>${esc(a.name)}</h3>
      <p class="muted">${esc(a.description || 'No description yet.')}</p>
      <p class="small muted">${a.followers} follower${a.followers === 1 ? '' : 's'}</p>
    </a>`;
}

function userRow(u) {
  return `
    <a class="card glass row" href="#/u/${esc(u.username)}">
      <span class="avatar">${initial(u.displayName)}</span>
      <div><strong>${esc(u.displayName)}</strong><div class="muted">@${esc(u.username)}</div></div>
    </a>`;
}

function commentItem(c) {
  return `
    <div class="comment">
      <div class="post-meta">
        <strong>${esc(c.author.name)}</strong> <span class="muted">@${esc(c.author.username)} · ${timeAgo(c.createdAt)}</span>
        ${c.mine ? `<button class="link-btn" data-action="delete-comment" data-id="${esc(c.id)}">Delete</button>` : ''}
      </div>
      <p>${linkify(c.body)}</p>
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
    <form class="glass panel composer" data-form="composer">
      <textarea name="body" rows="3" maxlength="500" placeholder="What's happening in the skies? Use #tags to be found." required></textarea>
      <div class="composer-row">
        <input name="imageUrl" type="url" placeholder="Image link (https, optional)" maxlength="500">
        ${owned.length ? `<select name="airlineSlug" aria-label="Post as">${options}</select>` : ''}
        <button class="btn small" type="submit">Post</button>
      </div>
      <p class="muted small" data-status></p>
    </form>`;
}

// ---------- form wiring ----------

// One helper for every form: disables the button while working, shows errors inline, runs onSuccess.
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

function bindComposer(defaultAirlineSlug) {
  bindForm('[data-form="composer"]', (data) => send('POST', '/api/posts', {
    body: data.body,
    imageUrl: data.imageUrl || undefined,
    airlineSlug: data.airlineSlug || undefined,
  }), () => route());
}

// ---------- views ----------

async function loadFeed() {
  const feed = $('#feed');
  const useFeed = Boolean(me.user) && homeTab === 'following';
  try {
    const posts = useFeed ? await api('/api/feed') : await api('/api/posts?sort=top');
    feed.innerHTML = posts.length
      ? posts.map(postCard).join('')
      : `<p class="muted">${useFeed
        ? 'Nothing here yet. Follow airlines or people in Discover to fill your feed.'
        : 'No posts yet. Be the first to post.'}</p>`;
  } catch (err) {
    feed.innerHTML = errorBox(err.message);
  }
}

function renderHome() {
  const intro = me.user ? '' : `
    <section class="hero glass">
      <p class="eyebrow">Roblox aviation, in one place</p>
      <h1>Fly, post, and find your next seat.</h1>
      <p class="lede">Follow airlines, see what their crews post, and apply to open roles in one tap.</p>
      <div class="hero-actions">
        <a class="btn" href="/auth/login">Sign in with Roblox</a>
        <a class="btn ghost" href="#/discover">Explore</a>
      </div>
    </section>`;
  const tabs = me.user ? `
    <div class="tabs">
      <button class="tab${homeTab === 'following' ? ' on' : ''}" data-tab="following">Following</button>
      <button class="tab${homeTab === 'explore' ? ' on' : ''}" data-tab="explore">Explore</button>
    </div>` : '<h2>Popular right now</h2>';

  app.innerHTML = `${intro}${composer()}${tabs}<div id="feed" class="stack">${loading}</div>`;
  bindComposer(null);
  loadFeed();
}

function renderDiscover(q = '') {
  app.innerHTML = `
    <section class="hero glass">
      <p class="eyebrow">Discover</p>
      <h1>Find airlines, crews, and roles</h1>
      <form id="search-form" class="search-form">
        <input id="q" type="search" placeholder="Search airlines, people, posts, roles or #tags" value="${esc(q)}" aria-label="Search">
      </form>
    </section>
    <div id="results">${q ? loading : `<h2>Popular tags</h2><div id="tags" class="chips">${loading}</div>`}</div>`;

  $('#search-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const value = $('#q').value.trim();
    location.hash = `#/discover?q=${encodeURIComponent(value)}`;
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

function section(title, items, render) {
  if (!items.length) return '';
  return `<h2>${esc(title)}</h2><div class="${title === 'Posts' ? 'stack' : 'grid'}">${items.map(render).join('')}</div>`;
}

async function loadDiscover(q) {
  const results = $('#results');
  try {
    const r = await api(`/api/discover?q=${encodeURIComponent(q)}`);
    const html = [
      section('Airlines', r.airlines, airlineCard),
      section('People', r.users, userRow),
      section('Roles', r.jobs, jobCard),
      section('Posts', r.posts, postCard),
    ].join('');
    results.innerHTML = html || '<p class="muted">Nothing matched that yet.</p>';
  } catch (err) {
    results.innerHTML = errorBox(err.message);
  }
}

async function renderTag(tag) {
  app.innerHTML = `
    <a class="back" href="#/discover">← Discover</a>
    <section class="hero glass"><p class="eyebrow">Tag</p><h1>#${esc(tag)}</h1></section>
    <div id="feed" class="stack">${loading}</div>`;
  try {
    const posts = await api(`/api/posts?tag=${encodeURIComponent(tag)}`);
    $('#feed').innerHTML = posts.length ? posts.map(postCard).join('') : '<p class="muted">No posts with this tag yet.</p>';
  } catch (err) {
    $('#feed').innerHTML = errorBox(err.message);
  }
}

async function renderPost(id) {
  app.innerHTML = loading;
  try {
    const post = await api(`/api/posts/${encodeURIComponent(id)}`);
    const comments = post.comments.map(commentItem).join('') || '<p class="muted">No comments yet.</p>';
    app.innerHTML = `
      <a class="back" href="#/">← Back</a>
      ${postCard(post)}
      <h2>Comments</h2>
      ${me.user ? `
        <form class="glass panel composer" data-form="comment">
          <textarea name="body" rows="2" maxlength="280" placeholder="Add a comment" required></textarea>
          <div class="composer-row"><span class="grow"></span><button class="btn small" type="submit">Comment</button></div>
          <p class="muted small" data-status></p>
        </form>` : '<p class="muted"><a href="/auth/login">Sign in</a> to comment.</p>'}
      <div class="glass panel stack-tight">${comments}</div>`;
    bindForm('[data-form="comment"]', (data) => send('POST', `/api/posts/${encodeURIComponent(id)}/comments`, data), () => renderPost(id));
  } catch (err) {
    app.innerHTML = errorBox(err.message);
  }
}

async function renderJobs() {
  app.innerHTML = `
    <section class="hero glass">
      <p class="eyebrow">Jobs</p>
      <h1>Apply once.<br>Fly with anyone.</h1>
      <p class="lede">Open roles from verified Roblox airlines. Applications go straight to the airline's Discord.</p>
      <input id="search" type="search" placeholder="Search roles or airlines" aria-label="Search jobs" value="${esc(jobFilter.q)}">
      <div class="chips">
        ${Object.entries(ROLE_FILTERS)
          .map(([value, label]) => `<button class="chip${value === jobFilter.role ? ' on' : ''}" data-role="${value}">${label}</button>`)
          .join('')}
      </div>
    </section>
    <div id="list" class="grid">${loading}</div>`;

  $('.chips').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-role]');
    if (!chip) return;
    jobFilter.role = chip.dataset.role;
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
    list.innerHTML = jobs.length ? jobs.map(jobCard).join('') : '<p class="muted">No open roles match that yet.</p>';
  } catch (err) {
    list.innerHTML = errorBox(err.message);
  }
}

async function renderJob(id) {
  app.innerHTML = loading;
  try {
    const job = await api(`/api/jobs/${encodeURIComponent(id)}`);
    app.innerHTML = `
      <a class="back" href="#/jobs">← All jobs</a>
      <div class="layout">
        <article class="glass panel">
          <span class="pill">${esc(job.roleLabel)}</span>
          <h1>${esc(job.title)}</h1>
          <p class="muted">at <a href="#/airline/${esc(job.airline.slug)}">${esc(job.airline.name)}</a> ${job.airline.verified ? '· <span class="verified">✓ Verified</span>' : ''}</p>
          <p class="body">${esc(job.description)}</p>
        </article>
        <form class="glass panel form" data-form="apply">
          <h2>Apply</h2>
          <label>Roblox username
            <input name="robloxUsername" required minlength="3" maxlength="20" pattern="[A-Za-z0-9_]{3,20}" autocomplete="off" value="${esc(me.user?.username || '')}">
          </label>
          <label>Why you?
            <textarea name="message" rows="5" maxlength="1000"></textarea>
          </label>
          <button class="btn" type="submit">Send application</button>
          <p class="muted small" data-status></p>
        </form>
      </div>`;

    bindForm('[data-form="apply"]', (data) => send('POST', `/api/jobs/${encodeURIComponent(id)}/applications`, data), (result, form) => {
      form.innerHTML = `
        <h2>Application sent</h2>
        <p class="muted">${result.delivered
          ? 'The airline received it in their Discord.'
          : 'Saved. This airline has not connected a Discord yet, so it was not forwarded.'}</p>
        <a class="btn ghost" href="#/jobs">Back to jobs</a>`;
    });
  } catch (err) {
    app.innerHTML = errorBox(err.message);
  }
}

async function renderAirlines() {
  app.innerHTML = `
    <section class="hero glass">
      <p class="eyebrow">Directory</p>
      <h1>Airlines</h1>
      <p class="lede">Every airline on Jumpseat. Verified means the Roblox group owner has signed in.</p>
      <div class="hero-actions"><a class="btn" href="#/claim">List your airline</a></div>
    </section>
    <div id="list" class="grid">${loading}</div>`;
  try {
    const airlines = await api('/api/airlines');
    $('#list').innerHTML = airlines.length ? airlines.map(airlineCard).join('') : '<p class="muted">No airlines yet.</p>';
  } catch (err) {
    $('#list').innerHTML = errorBox(err.message);
  }
}

async function renderAirline(slug) {
  app.innerHTML = loading;
  try {
    const a = await api(`/api/airlines/${encodeURIComponent(slug)}`);
    const mine = me.airlines.find((x) => x.slug === a.slug);

    let action = '';
    if (!me.user) action = '<a class="btn ghost" href="/auth/login">Sign in to follow</a>';
    else if (!a.owner) action = `<button class="btn${a.following ? ' ghost' : ''}" data-action="follow" data-type="airline" data-id="${esc(a.id)}">${a.following ? 'Following' : 'Follow'}</button>`;
    if (mine && !a.verified) action += ` <a class="btn small" href="/auth/roblox?airline=${esc(a.slug)}">Verify with Roblox</a>`;

    const ownerTools = a.owner ? `
      <details class="glass panel owner-tools">
        <summary>Owner tools</summary>
        <h3>Post a role</h3>
        <form class="form" data-form="role">
          <label>Title<input name="title" required minlength="3" maxlength="80" placeholder="First Officer"></label>
          <label>Category
            <select name="role">${Object.entries(ROLE_OPTIONS).map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
          </label>
          <label>Description<textarea name="description" rows="4" required maxlength="2000"></textarea></label>
          <button class="btn small" type="submit">Publish role</button>
          <p class="muted small" data-status></p>
        </form>
        <h3>Settings</h3>
        <form class="form" data-form="settings">
          <label>Description<textarea name="description" rows="2" maxlength="500">${esc(a.description)}</textarea></label>
          <label>Discord invite<input name="discordInvite" value="${esc(a.discordInvite || '')}" placeholder="https://discord.gg/…"></label>
          <label>Discord webhook (leave blank to keep current${a.hasWebhook ? ', currently set' : ''})
            <input name="discordWebhook" type="password" autocomplete="off" placeholder="https://discord.com/api/webhooks/…"></label>
          <button class="btn small" type="submit">Save settings</button>
          <p class="muted small" data-status></p>
        </form>
      </details>` : '';

    const jobs = a.jobs.map((j) => jobCard({ ...j, airline: { slug: a.slug, name: a.name, verified: a.verified } }));
    app.innerHTML = `
      <a class="back" href="#/airlines">← Airlines</a>
      <section class="hero glass">
        <div class="job-top">
          <span class="pill">${a.sample ? 'Sample' : 'Airline'}</span>
          ${a.verified ? '<span class="verified">✓ Verified</span>' : '<span class="muted">Unverified</span>'}
        </div>
        <h1>${esc(a.name)}</h1>
        <p class="lede">${esc(a.description || 'No description yet.')}</p>
        <div class="hero-actions">
          ${action}
          ${a.discordInvite ? `<a class="btn ghost" href="${esc(a.discordInvite)}" target="_blank" rel="noopener">Discord</a>` : ''}
          <span class="muted">${a.followers} follower${a.followers === 1 ? '' : 's'}</span>
        </div>
      </section>
      ${ownerTools}
      ${composer(a.owner ? a.slug : null)}
      <h2>Open roles</h2>
      <div class="grid">${jobs.length ? jobs.join('') : '<p class="muted">No open roles right now.</p>'}</div>
      <h2>Posts</h2>
      <div class="stack">${a.posts.length ? a.posts.map(postCard).join('') : '<p class="muted">No posts yet.</p>'}</div>`;

    bindComposer(a.owner ? a.slug : null);
    bindForm('[data-form="role"]', (data) => send('POST', `/api/airlines/${encodeURIComponent(a.slug)}/jobs`, data), () => renderAirline(a.slug));
    bindForm('[data-form="settings"]', (data) => {
      const payload = { description: data.description, discordInvite: data.discordInvite };
      if (data.discordWebhook) payload.discordWebhook = data.discordWebhook;
      return send('PATCH', `/api/airlines/${encodeURIComponent(a.slug)}`, payload);
    }, () => renderAirline(a.slug));
  } catch (err) {
    app.innerHTML = errorBox(err.message);
  }
}

async function renderUser(username) {
  app.innerHTML = loading;
  try {
    const u = await api(`/api/users/${encodeURIComponent(username)}`);
    const airlines = u.airlines.length
      ? `<p class="muted">Runs ${u.airlines.map((a) => `<a href="#/airline/${esc(a.slug)}">${esc(a.name)}</a>`).join(', ')}</p>`
      : '';
    const action = u.isMe
      ? '<a class="btn ghost" href="#/me">Edit profile</a>'
      : (me.user
        ? `<button class="btn${u.followedByMe ? ' ghost' : ''}" data-action="follow" data-type="user" data-id="${esc(u.id)}">${u.followedByMe ? 'Following' : 'Follow'}</button>`
        : '<a class="btn ghost" href="/auth/login">Sign in to follow</a>');

    app.innerHTML = `
      <a class="back" href="#/discover">← Back</a>
      <section class="hero glass">
        <span class="avatar xl">${initial(u.displayName)}</span>
        <h1>${esc(u.displayName)}</h1>
        <p class="muted">@${esc(u.username)}</p>
        <p class="lede">${esc(u.bio)}</p>
        ${airlines}
        <div class="hero-actions">
          ${action}
          <span class="muted"><strong>${u.followers}</strong> followers · <strong>${u.following}</strong> following</span>
        </div>
      </section>
      <div class="stack">${u.posts.length ? u.posts.map(postCard).join('') : '<p class="muted">No posts yet.</p>'}</div>`;
  } catch (err) {
    app.innerHTML = errorBox(err.message);
  }
}

function renderMe() {
  if (!me.user) {
    app.innerHTML = signInPrompt('Sign in to your Jumpseat account');
    return;
  }
  const listings = me.airlines.length
    ? me.airlines.map((a) => `
        <a class="card glass row" href="#/airline/${esc(a.slug)}">
          <span class="avatar airline">${initial(a.name)}</span>
          <div><strong>${esc(a.name)}</strong>
            <div class="muted small">${a.verified ? '✓ Verified' : 'Pending verification'}</div></div>
        </a>`).join('')
    : '<p class="muted">You have not listed an airline yet.</p>';

  app.innerHTML = `
    <section class="hero glass">
      <p class="eyebrow">Your account</p>
      <h1>${esc(me.user.displayName)}</h1>
      <p class="muted">@${esc(me.user.username)}</p>
      <div class="hero-actions">
        <a class="btn ghost" href="#/u/${esc(me.user.username)}">View profile</a>
        <button class="btn ghost" data-action="logout">Sign out</button>
      </div>
    </section>
    <form class="glass panel form" data-form="profile">
      <h2>Profile</h2>
      <label>Display name<input name="displayName" maxlength="40" value="${esc(me.user.displayName)}"></label>
      <label>Bio<textarea name="bio" rows="3" maxlength="160">${esc(me.user.bio)}</textarea></label>
      <button class="btn small" type="submit">Save profile</button>
      <p class="muted small" data-status></p>
    </form>
    <h2>Your airlines</h2>
    <div class="stack">${listings}</div>
    <div class="hero-actions"><a class="btn" href="#/claim">List an airline</a></div>`;

  bindForm('[data-form="profile"]', (data) => send('PATCH', '/api/me', data), async () => {
    await loadMe();
    renderMe();
  });
}

function renderClaim() {
  if (!me.user) {
    app.innerHTML = signInPrompt('Sign in to list your airline');
    return;
  }
  app.innerHTML = `
    <section class="hero glass">
      <p class="eyebrow">For airlines</p>
      <h1>List your airline</h1>
      <p class="lede">Add your airline, then verify it by signing in with the Roblox account that owns the group.</p>
    </section>
    <form class="glass panel form" data-form="claim">
      <label>Airline name<input name="name" required maxlength="40"></label>
      <label>Roblox group ID<input name="robloxGroupId" required inputmode="numeric" pattern="\\d{1,12}" placeholder="e.g. 1234567"></label>
      <label>Description<textarea name="description" rows="3" maxlength="500"></textarea></label>
      <label>Discord invite (optional)<input name="discordInvite" placeholder="https://discord.gg/…"></label>
      <label>Discord webhook (optional, receives applications)
        <input name="discordWebhook" type="password" autocomplete="off" placeholder="https://discord.com/api/webhooks/…"></label>
      <button class="btn" type="submit">Create listing</button>
      <p class="muted small" data-status></p>
    </form>`;

  bindForm('[data-form="claim"]', (data) => send('POST', '/api/airlines', data), async (airline, form) => {
    await loadMe();
    form.innerHTML = `
      <h2>${esc(airline.name)} is listed</h2>
      <p class="muted">Verify it to unlock posting and roles. Sign in with the Roblox account that owns the group.</p>
      <div class="hero-actions"><a class="btn" href="${esc(airline.verifyUrl)}">Verify with Roblox</a></div>`;
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
  for (const [pattern, handler] of routes) {
    const match = hash.match(pattern);
    if (match) return handler(match);
  }
  app.innerHTML = errorBox('Page not found.');
  return undefined;
}

// Clicks on buttons with data-action, and tabs with data-tab, are handled in one place.
app.addEventListener('click', async (e) => {
  const tab = e.target.closest('[data-tab]');
  if (tab) {
    homeTab = tab.dataset.tab;
    renderHome();
    return;
  }

  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const { action, id } = btn.dataset;
  try {
    if (action === 'like') {
      const r = await send('POST', `/api/posts/${id}/like`);
      btn.classList.toggle('on', r.liked);
      btn.textContent = `♥ ${r.likeCount}`;
    } else if (action === 'report') {
      if (!confirm('Report this post to the moderators?')) return;
      await send('POST', `/api/posts/${id}/report`, { reason: 'reported from feed' });
      btn.textContent = 'Reported';
      btn.disabled = true;
    } else if (action === 'delete') {
      if (!confirm('Delete this post? This cannot be undone.')) return;
      await send('DELETE', `/api/posts/${id}`);
      const card = btn.closest('[data-post]');
      if (location.hash.startsWith('#/post/')) location.hash = '#/';
      else if (card) card.remove();
    } else if (action === 'delete-comment') {
      if (!confirm('Delete this comment?')) return;
      await send('DELETE', `/api/comments/${id}`);
      btn.closest('.comment')?.remove();
    } else if (action === 'follow') {
      const r = await send('POST', '/api/follows', { targetType: btn.dataset.type, targetId: id });
      btn.textContent = r.following ? 'Following' : 'Follow';
      btn.classList.toggle('ghost', r.following);
      await loadMe();
    } else if (action === 'logout') {
      await send('POST', '/auth/logout');
      await loadMe();
      location.hash = '#/';
      route();
    }
  } catch (err) {
    alert(err.message);
  }
});

// Start the router last, after every view and handler is defined.
window.addEventListener('hashchange', route);
loadMe().then(route);
