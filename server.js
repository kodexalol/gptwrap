'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { Store } = require('./src/store');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const ROLES = ['pilot', 'cabin-crew', 'ground'];
const ROLE_LABELS = { pilot: 'Pilot', 'cabin-crew': 'Cabin Crew', ground: 'Ground Ops' };
const STATE_TTL_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;

const roblox = {
  clientId: process.env.ROBLOX_CLIENT_ID || '',
  clientSecret: process.env.ROBLOX_CLIENT_SECRET || '',
  redirectUri: process.env.ROBLOX_REDIRECT_URI || `${PUBLIC_URL}/auth/roblox/callback`,
  // Confirm these against the current Open Cloud OAuth 2.0 reference before going live.
  authorizeUrl: 'https://apis.roblox.com/oauth/v1/authorize',
  tokenUrl: 'https://apis.roblox.com/oauth/v1/token',
  userinfoUrl: 'https://apis.roblox.com/oauth/v1/userinfo',
  groupUrl: 'https://groups.roblox.com/v1/groups/',
};

const store = new Store(path.join(__dirname, 'data', 'db.json'));
const oauthStates = new Map(); // state -> { airlineSlug, expiresAt }

setInterval(() => {
  const now = Date.now();
  for (const [state, entry] of oauthStates) {
    if (entry.expiresAt < now) oauthStates.delete(state);
  }
}, 60 * 1000).unref();

const app = express();
app.use(express.json({ limit: '16kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- helpers ----------

const now = () => new Date().toISOString();
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const fail = (res, status, error) => res.status(status).json({ error });

const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function findAirline(slug) {
  return store.data.airlines.find((a) => a.slug === slug);
}

function slugify(name) {
  const base =
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'airline';
  let slug = base;
  let n = 2;
  while (store.data.airlines.some((a) => a.slug === slug)) slug = `${base}-${n++}`;
  return slug;
}

// Jobs are only public when the airline is verified and the role is open.
function isLive(job) {
  const airline = store.data.airlines.find((a) => a.id === job.airlineId);
  return job.open && Boolean(airline && airline.verified);
}

// Never expose ownerRobloxId, manageTokenHash or discordWebhook.
function publicAirline(a) {
  return {
    id: a.id,
    slug: a.slug,
    name: a.name,
    description: a.description,
    verified: a.verified,
    discordInvite: a.discordInvite,
    robloxGroupId: a.robloxGroupId,
    sample: Boolean(a.sample),
    createdAt: a.createdAt,
  };
}

function publicJob(job) {
  const airline = store.data.airlines.find((a) => a.id === job.airlineId);
  return {
    id: job.id,
    title: job.title,
    role: job.role,
    roleLabel: ROLE_LABELS[job.role],
    description: job.description,
    open: job.open,
    createdAt: job.createdAt,
    airline: airline ? { slug: airline.slug, name: airline.name, verified: airline.verified } : null,
  };
}

function authorizeManage(req, airline) {
  const token = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token || !airline.manageTokenHash) return false;
  const given = Buffer.from(sha256(token));
  const expected = Buffer.from(airline.manageTokenHash);
  return crypto.timingSafeEqual(given, expected);
}

async function postToDiscord(webhookUrl, embed) {
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'Jumpseat', embeds: [embed] }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function sendPage(res, status, title, body, token) {
  const tokenBlock = token ? `<pre class="token">${escapeHtml(token)}</pre>` : '';
  res
    .status(status)
    .type('html')
    .send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>${escapeHtml(title)} · Jumpseat</title>
<link rel="stylesheet" href="/styles.css">
</head>
<body class="center">
<main class="glass card-page">
<h1>${escapeHtml(title)}</h1>
<p class="muted">${escapeHtml(body)}</p>
${tokenBlock}
<a class="btn" href="/">Back to Jumpseat</a>
</main>
</body>
</html>`);
}

// Exchange the OAuth code for an access token, then ask Roblox who the user is.
async function resolveRobloxUserId(code) {
  const tokenRes = await fetch(roblox.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: roblox.redirectUri,
      client_id: roblox.clientId,
      client_secret: roblox.clientSecret,
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!tokenRes.ok) throw new Error(`token exchange failed: ${tokenRes.status}`);
  const { access_token: accessToken } = await tokenRes.json();

  const infoRes = await fetch(roblox.userinfoUrl, {
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!infoRes.ok) throw new Error(`userinfo failed: ${infoRes.status}`);
  const info = await infoRes.json();
  if (!info.sub) throw new Error('userinfo response had no sub');
  return String(info.sub);
}

async function fetchGroupOwnerId(groupId) {
  const res = await fetch(`${roblox.groupUrl}${encodeURIComponent(groupId)}`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`group lookup failed: ${res.status}`);
  const group = await res.json();
  return group.owner?.userId != null ? String(group.owner.userId) : null;
}

// ---------- public API ----------

app.get('/api/airlines', (req, res) => {
  res.json(store.data.airlines.map(publicAirline));
});

app.get('/api/airlines/:slug', (req, res) => {
  const airline = findAirline(req.params.slug);
  if (!airline) return fail(res, 404, 'Airline not found');
  const jobs = store.data.jobs
    .filter((j) => j.airlineId === airline.id && isLive(j))
    .map(publicJob);
  res.json({ ...publicAirline(airline), jobs });
});

app.get('/api/jobs', (req, res) => {
  const role = String(req.query.role || '');
  const q = String(req.query.q || '').trim().toLowerCase();
  const jobs = store.data.jobs
    .filter(isLive)
    .map(publicJob)
    .filter((j) => !role || j.role === role)
    .filter((j) => !q || `${j.title} ${j.airline?.name || ''}`.toLowerCase().includes(q))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.json(jobs);
});

app.get('/api/jobs/:id', (req, res) => {
  const job = store.data.jobs.find((j) => j.id === req.params.id);
  if (!job || !isLive(job)) return fail(res, 404, 'Job not found');
  res.json(publicJob(job));
});

app.post('/api/jobs/:id/applications', async (req, res) => {
  const job = store.data.jobs.find((j) => j.id === req.params.id);
  if (!job || !isLive(job)) return fail(res, 404, 'Job not found or closed');

  const robloxUsername = String(req.body?.robloxUsername || '').trim();
  const message = String(req.body?.message || '').trim();
  if (!/^[A-Za-z0-9_]{3,20}$/.test(robloxUsername)) {
    return fail(res, 400, 'Roblox username must be 3–20 letters, numbers or underscores');
  }
  if (message.length > 1000) return fail(res, 400, 'Message must be 1000 characters or fewer');

  const airline = store.data.airlines.find((a) => a.id === job.airlineId);
  const application = {
    id: crypto.randomUUID(),
    jobId: job.id,
    airlineId: job.airlineId,
    robloxUsername,
    message,
    delivered: false,
    createdAt: now(),
  };
  store.data.applications.push(application);

  if (airline.discordWebhook) {
    application.delivered = await postToDiscord(airline.discordWebhook, {
      title: `New application: ${job.title}`,
      description: `**Roblox:** ${robloxUsername}\n\n${message || '_No message_'}`,
      color: 0x0a84ff,
      timestamp: application.createdAt,
    });
  }
  store.save();
  res.status(201).json({ ok: true, delivered: application.delivered });
});

app.post('/api/airlines', (req, res) => {
  const name = String(req.body?.name || '').trim();
  const robloxGroupId = String(req.body?.robloxGroupId || '').trim();
  const description = String(req.body?.description || '').trim();
  const discordWebhook = String(req.body?.discordWebhook || '').trim();
  const discordInvite = String(req.body?.discordInvite || '').trim();

  if (name.length < 2 || name.length > 40) return fail(res, 400, 'Airline name must be 2–40 characters');
  if (!/^\d{1,12}$/.test(robloxGroupId)) return fail(res, 400, 'Roblox group ID must be numbers only');
  if (description.length > 500) return fail(res, 400, 'Description must be 500 characters or fewer');
  if (discordWebhook && !/^https:\/\/(discord|discordapp)\.com\/api\/webhooks\//.test(discordWebhook)) {
    return fail(res, 400, 'Discord webhook must be a discord.com webhook URL');
  }
  if (discordInvite && !/^https:\/\/(discord\.gg|discord\.com\/invite)\//.test(discordInvite)) {
    return fail(res, 400, 'Discord invite must be a discord.gg or discord.com/invite link');
  }
  if (store.data.airlines.some((a) => a.robloxGroupId === robloxGroupId)) {
    return fail(res, 409, 'That Roblox group is already listed');
  }

  const airline = {
    id: crypto.randomUUID(),
    slug: slugify(name),
    name,
    description,
    robloxGroupId,
    verified: false,
    ownerRobloxId: null,
    manageTokenHash: null,
    discordInvite: discordInvite || null,
    discordWebhook: discordWebhook || null,
    sample: false,
    createdAt: now(),
  };
  store.data.airlines.push(airline);
  store.save();
  res.status(201).json({ ...publicAirline(airline), verifyUrl: `/auth/roblox?airline=${encodeURIComponent(airline.slug)}` });
});

// Owner posts a role. Requires the manage token issued at verification.
app.post('/api/airlines/:slug/jobs', (req, res) => {
  const airline = findAirline(req.params.slug);
  if (!airline || !airline.verified) return fail(res, 404, 'Verified airline not found');
  if (!authorizeManage(req, airline)) return fail(res, 401, 'Invalid manage token');

  const title = String(req.body?.title || '').trim();
  const role = String(req.body?.role || '');
  const description = String(req.body?.description || '').trim();
  if (title.length < 3 || title.length > 80) return fail(res, 400, 'Title must be 3–80 characters');
  if (!ROLES.includes(role)) return fail(res, 400, `Role must be one of: ${ROLES.join(', ')}`);
  if (!description || description.length > 2000) return fail(res, 400, 'Description must be 1–2000 characters');

  const job = {
    id: crypto.randomUUID(),
    airlineId: airline.id,
    title,
    role,
    description,
    open: true,
    createdAt: now(),
  };
  store.data.jobs.push(job);
  store.save();
  res.status(201).json(publicJob(job));
});

// Owner closes a role.
app.post('/api/airlines/:slug/jobs/:jobId/close', (req, res) => {
  const airline = findAirline(req.params.slug);
  if (!airline || !airline.verified) return fail(res, 404, 'Verified airline not found');
  if (!authorizeManage(req, airline)) return fail(res, 401, 'Invalid manage token');

  const job = store.data.jobs.find((j) => j.id === req.params.jobId && j.airlineId === airline.id);
  if (!job) return fail(res, 404, 'Job not found');
  job.open = false;
  store.save();
  res.json(publicJob(job));
});

// ---------- Roblox verification ----------

app.get('/auth/roblox', (req, res) => {
  if (!roblox.clientId || !roblox.clientSecret) {
    return sendPage(res, 503, 'Verification unavailable', 'Roblox OAuth is not configured on this server.');
  }
  const airline = findAirline(String(req.query.airline || ''));
  if (!airline || airline.verified) {
    return sendPage(res, 404, 'Nothing to verify', 'That airline does not exist or is already verified.');
  }

  const state = crypto.randomBytes(24).toString('base64url');
  oauthStates.set(state, { airlineSlug: airline.slug, expiresAt: Date.now() + STATE_TTL_MS });

  const url = new URL(roblox.authorizeUrl);
  url.search = new URLSearchParams({
    client_id: roblox.clientId,
    redirect_uri: roblox.redirectUri,
    response_type: 'code',
    scope: 'openid profile',
    state,
  }).toString();
  res.redirect(url.toString());
});

app.get('/auth/roblox/callback', async (req, res) => {
  const state = String(req.query.state || '');
  const entry = oauthStates.get(state);
  oauthStates.delete(state);
  if (!entry || entry.expiresAt < Date.now()) {
    return sendPage(res, 400, 'Link expired', 'Start verification again from Jumpseat.');
  }
  if (req.query.error) {
    return sendPage(res, 400, 'Verification cancelled', 'You did not finish signing in with Roblox.');
  }

  const airline = findAirline(entry.airlineSlug);
  if (!airline || airline.verified) {
    return sendPage(res, 404, 'Nothing to verify', 'That airline does not exist or is already verified.');
  }

  try {
    const userId = await resolveRobloxUserId(String(req.query.code || ''));
    const ownerId = await fetchGroupOwnerId(airline.robloxGroupId);
    if (!ownerId || userId !== ownerId) {
      return sendPage(res, 403, 'Not the group owner', 'Verification needs the Roblox account that owns this group.');
    }

    const manageToken = crypto.randomBytes(32).toString('base64url');
    Object.assign(airline, {
      verified: true,
      ownerRobloxId: userId,
      manageTokenHash: sha256(manageToken),
    });
    store.save();
    return sendPage(
      res,
      200,
      `${airline.name} is verified`,
      'Save this manage token. You will need it to post roles. It is shown only once.',
      manageToken,
    );
  } catch (err) {
    console.error('verification failed:', err.message);
    return sendPage(res, 502, 'Verification failed', 'Could not confirm with Roblox. Try again in a moment.');
  }
});

// ---------- errors ----------

app.use('/api', (req, res) => fail(res, 404, 'Not found'));

app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return fail(res, 400, 'Invalid JSON body');
  console.error(err);
  return fail(res, 500, 'Server error');
});

app.listen(PORT, () => {
  console.log(`Jumpseat running at ${PUBLIC_URL}`);
});
