'use strict';

const $ = (selector, root = document) => root.querySelector(selector);
const app = $('#app');

const ROLE_FILTERS = { '': 'All roles', pilot: 'Pilots', 'cabin-crew': 'Cabin crew', ground: 'Ground ops' };
const ROLE_OPTIONS = { pilot: 'Pilot', 'cabin-crew': 'Cabin crew', ground: 'Ground ops' };

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const loading = '<p class="muted">Loading…</p>';
const errorBox = (message) => `<div class="glass panel"><p class="error">${esc(message)}</p></div>`;

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ---------- router ----------

const routes = [
  [/^#\/?$/, () => renderJobs()],
  [/^#\/job\/([\w-]+)$/, (m) => renderJob(m[1])],
  [/^#\/airlines$/, () => renderAirlines()],
  [/^#\/airline\/([\w-]+)$/, (m) => renderAirline(m[1])],
  [/^#\/claim$/, () => renderClaim()],
  [/^#\/post$/, () => renderPost()],
];

function route() {
  const hash = location.hash || '#/';
  window.scrollTo(0, 0);
  for (const [pattern, handler] of routes) {
    const match = hash.match(pattern);
    if (match) return handler(match);
  }
  app.innerHTML = errorBox('Page not found.');
}

// ---------- components ----------

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

function airlineBadge(verified) {
  return verified ? '<span class="verified">✓ Verified</span>' : '<span class="muted">Unverified</span>';
}

// ---------- views ----------

let jobFilter = { role: '', q: '' };

function renderJobs() {
  app.innerHTML = `
    <section class="hero glass">
      <p class="eyebrow">Roblox airline careers</p>
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
    list.innerHTML = jobs.length
      ? jobs.map(jobCard).join('')
      : '<p class="muted">No open roles match that yet.</p>';
  } catch (err) {
    list.innerHTML = errorBox(err.message);
  }
}

async function renderJob(id) {
  app.innerHTML = loading;
  try {
    const job = await api(`/api/jobs/${encodeURIComponent(id)}`);
    app.innerHTML = `
      <a class="back" href="#/">← All jobs</a>
      <div class="layout">
        <article class="glass panel">
          <span class="pill">${esc(job.roleLabel)}</span>
          <h1>${esc(job.title)}</h1>
          <p class="muted">at <a href="#/airline/${esc(job.airline.slug)}">${esc(job.airline.name)}</a> ${job.airline.verified ? '· <span class="verified">✓ Verified</span>' : ''}</p>
          <p class="body">${esc(job.description)}</p>
        </article>
        <form id="apply" class="glass panel form">
          <h2>Apply</h2>
          <label>Roblox username
            <input name="robloxUsername" required minlength="3" maxlength="20" pattern="[A-Za-z0-9_]{3,20}" autocomplete="off">
          </label>
          <label>Why you?
            <textarea name="message" rows="5" maxlength="1000"></textarea>
          </label>
          <button class="btn" type="submit">Send application</button>
          <p id="apply-status" class="muted" role="status"></p>
        </form>
      </div>`;

    $('#apply').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.currentTarget;
      const button = form.querySelector('button');
      const status = $('#apply-status');
      button.disabled = true;
      status.textContent = 'Sending…';
      try {
        const payload = Object.fromEntries(new FormData(form));
        const result = await api(`/api/jobs/${encodeURIComponent(id)}/applications`, {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        form.innerHTML = `
          <h2>Application sent</h2>
          <p class="muted">${result.delivered
            ? 'The airline received it in their Discord.'
            : 'Saved. This airline has not connected a Discord yet, so it will not be forwarded.'}</p>
          <a class="btn ghost" href="#/">Back to jobs</a>`;
      } catch (err) {
        status.textContent = err.message;
        button.disabled = false;
      }
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
      <p class="lede">Every airline listed on Jumpseat. Verified means the Roblox group owner has signed in.</p>
    </section>
    <div id="list" class="grid">${loading}</div>`;
  try {
    const airlines = await api('/api/airlines');
    $('#list').innerHTML = airlines.length
      ? airlines
          .map((a) => `
            <a class="card glass" href="#/airline/${esc(a.slug)}">
              <div class="job-top">
                <span class="pill">${a.sample ? 'Sample' : 'Airline'}</span>
                ${airlineBadge(a.verified)}
              </div>
              <h3>${esc(a.name)}</h3>
              <p class="muted">${esc(a.description)}</p>
            </a>`)
          .join('')
      : '<p class="muted">No airlines yet.</p>';
  } catch (err) {
    $('#list').innerHTML = errorBox(err.message);
  }
}

async function renderAirline(slug) {
  app.innerHTML = loading;
  try {
    const a = await api(`/api/airlines/${encodeURIComponent(slug)}`);
    const jobs = a.jobs.map((j) => jobCard({ ...j, airline: { slug: a.slug, name: a.name, verified: a.verified } }));
    app.innerHTML = `
      <a class="back" href="#/airlines">← Airlines</a>
      <section class="hero glass">
        <div class="job-top">
          <span class="pill">${a.sample ? 'Sample' : 'Airline'}</span>
          ${airlineBadge(a.verified)}
        </div>
        <h1>${esc(a.name)}</h1>
        <p class="lede">${esc(a.description)}</p>
        ${a.discordInvite ? `<a class="btn" href="${esc(a.discordInvite)}" target="_blank" rel="noopener">Join the Discord</a>` : ''}
      </section>
      <h2>Open roles</h2>
      <div class="grid">${jobs.length ? jobs.join('') : '<p class="muted">No open roles right now.</p>'}</div>`;
  } catch (err) {
    app.innerHTML = errorBox(err.message);
  }
}

function renderClaim() {
  app.innerHTML = `
    <section class="hero glass">
      <p class="eyebrow">For airlines</p>
      <h1>List your airline</h1>
      <p class="lede">Add your airline, then verify it by signing in with the Roblox account that owns the group.</p>
    </section>
    <form id="claim" class="glass panel form">
      <label>Airline name
        <input name="name" required maxlength="40">
      </label>
      <label>Roblox group ID
        <input name="robloxGroupId" required inputmode="numeric" pattern="\\d{1,12}" placeholder="e.g. 1234567">
      </label>
      <label>Description
        <textarea name="description" rows="3" maxlength="500"></textarea>
      </label>
      <label>Discord webhook (optional, to receive applications)
        <input name="discordWebhook" type="password" autocomplete="off" placeholder="https://discord.com/api/webhooks/…">
      </label>
      <label>Discord invite (optional)
        <input name="discordInvite" placeholder="https://discord.gg/…">
      </label>
      <button class="btn" type="submit">Create listing</button>
      <p id="status" class="muted" role="status"></p>
    </form>`;

  $('#claim').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const button = form.querySelector('button');
    const status = $('#status');
    button.disabled = true;
    status.textContent = 'Creating…';
    try {
      const data = await api('/api/airlines', {
        method: 'POST',
        body: JSON.stringify(Object.fromEntries(new FormData(form))),
      });
      form.innerHTML = `
        <h2>${esc(data.name)} is listed</h2>
        <p class="muted">Verify it to unlock posting. Sign in with the Roblox account that owns the group.</p>
        <a class="btn" href="${esc(data.verifyUrl)}">Verify with Roblox</a>`;
    } catch (err) {
      status.textContent = err.message;
      button.disabled = false;
    }
  });
}

function renderPost() {
  app.innerHTML = `
    <section class="hero glass">
      <p class="eyebrow">For airlines</p>
      <h1>Post a role</h1>
      <p class="lede">You need the manage token you received when you verified your airline.</p>
    </section>
    <form id="post" class="glass panel form">
      <label>Airline slug
        <input name="slug" required autocomplete="off" placeholder="northwind-air">
      </label>
      <label>Manage token
        <input name="token" type="password" required autocomplete="off">
      </label>
      <label>Role title
        <input name="title" required minlength="3" maxlength="80" placeholder="First Officer">
      </label>
      <label>Category
        <select name="role">
          ${Object.entries(ROLE_OPTIONS).map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}
        </select>
      </label>
      <label>Description
        <textarea name="description" rows="6" required maxlength="2000"></textarea>
      </label>
      <button class="btn" type="submit">Publish role</button>
      <p id="status" class="muted" role="status"></p>
    </form>`;

  $('#post').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const button = form.querySelector('button');
    const { slug, token, ...body } = Object.fromEntries(new FormData(form));
    const status = $('#status');
    button.disabled = true;
    status.textContent = 'Publishing…';
    try {
      const job = await api(`/api/airlines/${encodeURIComponent(slug.trim())}/jobs`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token.trim()}` },
        body: JSON.stringify(body),
      });
      status.innerHTML = `Published. <a class="verified" href="#/job/${esc(job.id)}">View it →</a>`;
      form.reset();
    } catch (err) {
      status.textContent = err.message;
    } finally {
      button.disabled = false;
    }
  });
}

// Start the router last, after every view and filter binding is initialized.
window.addEventListener('hashchange', route);
route();
