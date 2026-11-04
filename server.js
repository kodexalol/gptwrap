'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { Store } = require('./src/store');
const auth = require('./src/auth');
const { now, sha256, escapeHtml, byNewest, extractTags, parseMedia, rateLimit } = require('./src/util');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const SECURE_COOKIES = PUBLIC_URL.startsWith('https://');
// Dev sign-in lets you test without OAuth credentials. It is off unless explicitly enabled.
const DEV_LOGIN = process.env.ALLOW_DEV_LOGIN === '1' && process.env.NODE_ENV !== 'production';
// Comma-separated Roblox-style usernames that get admin tools, e.g. ADMIN_USERNAMES=alice,bob
const ADMIN_USERNAMES = (process.env.ADMIN_USERNAMES || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

const ROLES = ['pilot', 'cabin-crew', 'ground'];
const ROLE_LABELS = { pilot: 'Pilot', 'cabin-crew': 'Cabin Crew', ground: 'Ground Ops' };
const KINDS = { airline: 'Airline', store: 'Roblox store', other: 'Organisation' };
const LIMITS = { postBody: 500, commentBody: 280, bio: 160, displayName: 40, reportReason: 200, orgsPerUser: 3 };
const REPORT_HIDE_THRESHOLD = 3;
const STATE_TTL_MS = 10 * 60 * 1000;
const CODE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;
const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const roblox = {
  clientId: process.env.ROBLOX_CLIENT_ID || '',
  clientSecret: process.env.ROBLOX_CLIENT_SECRET || '',
  redirectUri: process.env.ROBLOX_REDIRECT_URI || `${PUBLIC_URL}/auth/roblox/callback`,
  // Confirm these against the current Open Cloud and Roblox web API docs before going live.
  authorizeUrl: 'https://apis.roblox.com/oauth/v1/authorize',
  tokenUrl: 'https://apis.roblox.com/oauth/v1/token',
  userinfoUrl: 'https://apis.roblox.com/oauth/v1/userinfo',
  groupUrl: 'https://groups.roblox.com/v1/groups/',
  usernamesUrl: 'https://users.roblox.com/v1/usernames/users',
  userUrl: 'https://users.roblox.com/v1/users/',
};
const robloxConfigured = Boolean(roblox.clientId && roblox.clientSecret);

const discord = {
  clientId: process.env.DISCORD_CLIENT_ID || '',
  clientSecret: process.env.DISCORD_CLIENT_SECRET || '',
  redirectUri: process.env.DISCORD_REDIRECT_URI || `${PUBLIC_URL}/auth/discord/callback`,
  authorizeUrl: 'https://discord.com/oauth2/authorize',
  tokenUrl: 'https://discord.com/api/oauth2/token',
  userUrl: 'https://discord.com/api/users/@me',
};
const discordConfigured = Boolean(discord.clientId && discord.clientSecret);

const store = new Store(path.join(__dirname, 'data', 'db.json'));
const oauthStates = new Map(); // state -> { provider, airlineSlug, expiresAt }

setInterval(() => {
  const t = Date.now();
  for (const [state, entry] of oauthStates) if (entry.expiresAt < t) oauthStates.delete(state);
}, 60 * 1000).unref();

const app = express();
// Behind a reverse proxy, trust the first hop so req.ip is the client address.
app.set('trust proxy', 1);
app.use(express.json({ limit: '16kb' }));
app.use((req, res, next) => {
  req.user = auth.userFromRequest(store, req);
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

// ---------- helpers ----------

const fail = (res, status, error, extra = {}) => res.status(status).json({ error, ...extra });
const requireUser = (req, res, next) => (req.user ? next() : fail(res, 401, 'Sign in first'));
const requireAdmin = (req, res, next) => (req.user && isAdmin(req.user) ? next() : fail(res, 403, 'Admins only'));

const isAdmin = (user) => Boolean(user) && ADMIN_USERNAMES.includes(user.username.toLowerCase());
const badgesOf = (u) => {
  const out = [];
  if (u.confirmed) out.push('confirmed');
  if (u.verifiedMember) out.push('member');
  if (isAdmin(u)) out.push('admin');
  return out;
};

const findAirline = (slug) => store.data.airlines.find((a) => a.slug === slug);
const findAirlineById = (id) => store.data.airlines.find((a) => a.id === id);
const findPost = (id) => store.data.posts.find((p) => p.id === id);
const findUserByUsername = (name) =>
  store.data.users.find((u) => u.username.toLowerCase() === String(name).toLowerCase());
const isOwner = (user, airline) => Boolean(user && airline && airline.verified && airline.ownerUserId === user.id);
const isLive = (job) => {
  const airline = findAirlineById(job.airlineId);
  return Boolean(job.open && airline && airline.verified);
};
const visiblePosts = () => store.data.posts.filter((p) => !p.hidden);
const followersOf = (type, id) => store.data.follows.filter((f) => f.targetType === type && f.targetId === id).length;
const followingCount = (userId) => store.data.follows.filter((f) => f.followerUserId === userId).length;
const isFollowing = (userId, type, id) =>
  Boolean(userId) && store.data.follows.some((f) => f.followerUserId === userId && f.targetType === type && f.targetId === id);

function canManagePost(user, post) {
  if (!user) return false;
  if (post.authorType === 'user') return post.authorUserId === user.id;
  return isOwner(user, findAirlineById(post.airlineId));
}

function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName || u.username,
    bio: u.bio || '',
    createdAt: u.createdAt,
    badges: badgesOf(u),
    confirmedRobloxName: u.confirmed ? u.robloxUsername || null : null,
  };
}

function miniUser(id) {
  const u = store.data.users.find((x) => x.id === id);
  return u
    ? { id: u.id, username: u.username, displayName: u.displayName || u.username, badges: badgesOf(u) }
    : { id, username: 'unknown', displayName: 'unknown', badges: [] };
}

function authorOf(post) {
  if (post.authorType === 'airline') {
    const airline = findAirlineById(post.airlineId);
    return {
      type: 'airline',
      slug: airline?.slug || null,
      name: airline?.name || 'Unknown organisation',
      verified: Boolean(airline?.verified),
      kind: airline?.kind || 'airline',
    };
  }
  const user = store.data.users.find((u) => u.id === post.authorUserId);
  return {
    type: 'user',
    username: user?.username || 'unknown',
    name: user?.displayName || user?.username || 'unknown',
    badges: user ? badgesOf(user) : [],
  };
}

function publicPost(post, viewer) {
  const likes = store.data.likes.filter((l) => l.postId === post.id);
  return {
    id: post.id,
    body: post.body,
    imageUrl: post.imageUrl || null,
    video: post.video || null,
    tags: post.tags,
    createdAt: post.createdAt,
    author: authorOf(post),
    likeCount: likes.length,
    likedByMe: Boolean(viewer) && likes.some((l) => l.userId === viewer.id),
    commentCount: store.data.comments.filter((c) => c.postId === post.id).length,
    canDelete: canManagePost(viewer, post),
  };
}

function publicComment(c, viewer) {
  const user = store.data.users.find((u) => u.id === c.authorUserId);
  return {
    id: c.id,
    body: c.body,
    createdAt: c.createdAt,
    author: {
      username: user?.username || 'unknown',
      name: user?.displayName || user?.username || 'unknown',
      badges: user ? badgesOf(user) : [],
    },
    mine: Boolean(viewer) && c.authorUserId === viewer.id,
  };
}

function publicAirline(a, viewer) {
  return {
    id: a.id,
    slug: a.slug,
    name: a.name,
    kind: a.kind || 'airline',
    kindLabel: KINDS[a.kind || 'airline'],
    description: a.description,
    verified: a.verified,
    sample: Boolean(a.sample),
    robloxGroupId: a.robloxGroupId,
    discordInvite: a.discordInvite,
    hasWebhook: Boolean(a.discordWebhook),
    createdAt: a.createdAt,
    followers: followersOf('airline', a.id),
    following: isFollowing(viewer?.id, 'airline', a.id),
    owner: isOwner(viewer, a),
  };
}

function publicJob(job) {
  const airline = findAirlineById(job.airlineId);
  return {
    id: job.id,
    title: job.title,
    role: job.role,
    roleLabel: ROLE_LABELS[job.role],
    description: job.description,
    open: job.open,
    createdAt: job.createdAt,
    airline: airline ? { slug: airline.slug, name: airline.name, verified: airline.verified, kind: airline.kind || 'airline' } : null,
  };
}

function validateWebhook(value) {
  if (!value) return null;
  return /^https:\/\/(discord|discordapp)\.com\/api\/webhooks\//.test(value)
    ? null
    : 'Discord webhook must be a discord.com webhook URL';
}

function validateInvite(value) {
  if (!value) return null;
  return /^https:\/\/(discord\.gg|discord\.com\/invite)\//.test(value)
    ? null
    : 'Discord invite must be a discord.gg or discord.com/invite link';
}

function validateJobFields(body) {
  const title = String(body?.title || '').trim();
  const role = String(body?.role || '');
  const description = String(body?.description || '').trim();
  if (title.length < 3 || title.length > 80) return { error: 'Title must be 3–80 characters' };
  if (!ROLES.includes(role)) return { error: `Role must be one of: ${ROLES.join(', ')}` };
  if (!description || description.length > 2000) return { error: 'Description must be 1–2000 characters' };
  return { value: { title, role, description } };
}

// Unique Jumpseat username from a provider name, e.g. a Discord handle.
function uniqueUsername(base, suffix) {
  let clean = String(base || '').replace(/[^A-Za-z0-9_]/g, '_').slice(0, 15);
  if (clean.length < 3) clean = `user_${clean}`.slice(0, 15);
  const taken = (name) => store.data.users.some((u) => u.username.toLowerCase() === name.toLowerCase());
  if (!taken(clean)) return clean;
  let candidate = `${clean.slice(0, 11)}_${String(suffix).slice(-4)}`;
  let n = 2;
  while (taken(candidate)) candidate = `${clean.slice(0, 10)}_${n++}`;
  return candidate;
}

function upsertDiscordUser(discordId, discordName, globalName) {
  let user = store.data.users.find((u) => u.discordId === discordId);
  if (!user) {
    const username = uniqueUsername(discordName, discordId);
    user = {
      id: crypto.randomUUID(),
      discordId,
      discordUsername: discordName,
      robloxUserId: null,
      robloxUsername: null,
      confirmed: false,
      pendingRoblox: null,
      username,
      displayName: globalName || username,
      bio: '',
      verifiedMember: false,
      createdAt: now(),
    };
    store.data.users.push(user);
  } else {
    user.discordUsername = discordName;
  }
  return user;
}

// Shared by Roblox sign-in and dev sign-in. Creates or updates the user record.
function upsertRobloxUser(robloxUserId, rawName) {
  const cleanName = USERNAME_RE.test(rawName || '') ? rawName : null;
  let user = store.data.users.find((u) => u.robloxUserId === robloxUserId);
  if (!user) {
    const base = cleanName || `user_${robloxUserId.slice(-6)}`;
    user = {
      id: crypto.randomUUID(),
      robloxUserId,
      robloxUsername: cleanName,
      confirmed: false,
      pendingRoblox: null,
      username: uniqueUsername(base, robloxUserId),
      displayName: base,
      bio: '',
      verifiedMember: false,
      createdAt: now(),
    };
    store.data.users.push(user);
  } else if (cleanName && cleanName.toLowerCase() !== user.username.toLowerCase()) {
    const taken = store.data.users.some((u) => u.id !== user.id && u.username.toLowerCase() === cleanName.toLowerCase());
    if (!taken) user.username = cleanName;
  }
  return user;
}

function devRobloxId(username) {
  return String(1e9 + (parseInt(sha256(username.toLowerCase()).slice(0, 8), 16) % 1e9));
}

function randomCode() {
  let out = 'JS-';
  for (let i = 0; i < 6; i++) out += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return out;
}

// ---------- HTML pages for the auth flow ----------

function page(title, inner) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>${escapeHtml(title)} · Jumpseat</title>
<link rel="stylesheet" href="/styles.css">
</head>
<body class="center">
<main class="card-page">${inner}</main>
</body>
</html>`;
}

function sendPage(res, status, title, body) {
  res
    .status(status)
    .type('html')
    .send(page(title, `<h1>${escapeHtml(title)}</h1><p class="muted">${escapeHtml(body)}</p><a class="btn" href="/">Back to Jumpseat</a>`));
}

function signInPage(airlineSlug) {
  const buttons = [];
  if (discordConfigured) buttons.push('<a class="btn primary wide" href="/auth/discord">Continue with Discord</a>');
  if (robloxConfigured) {
    buttons.push(`<a class="btn secondary wide" href="/auth/roblox${airlineSlug ? `?airline=${encodeURIComponent(airlineSlug)}` : ''}">Continue with Roblox</a>`);
  }
  const devForm = DEV_LOGIN ? `
    <p class="eyebrow" style="margin-top:20px">Development only</p>
    <form method="get" action="/auth/dev">
      <input type="hidden" name="airline" value="${escapeHtml(airlineSlug || '')}">
      <label>Username<input name="username" required minlength="3" maxlength="20" pattern="[A-Za-z0-9_]{3,20}" autocomplete="off"></label>
      <button class="btn secondary" type="submit">Sign in as this username</button>
    </form>` : '';
  const body = buttons.length ? buttons.join('') : '<p class="muted">No sign-in method is configured on this server.</p>';
  return page('Sign in', `
    <p class="eyebrow">Jumpseat</p>
    <h1>Sign in</h1>
    <p class="muted">Sign in with the account you already use. To post as an organisation you will also confirm a Roblox account with a short code.</p>
    <div class="stack-btn">${body}</div>
    ${devForm}`);
}

// ---------- sign-in: Discord, Roblox, dev ----------

app.get('/auth/login', (req, res) => {
  const airline = String(req.query.airline || '');
  if (!discordConfigured && !robloxConfigured && !DEV_LOGIN) {
    return sendPage(res, 503, 'Sign-in unavailable', 'No sign-in provider is configured on this server.');
  }
  return res.type('html').send(signInPage(airline));
});

app.get('/auth/discord', (req, res) => {
  if (!discordConfigured) {
    if (DEV_LOGIN) return res.redirect('/auth/login');
    return sendPage(res, 503, 'Discord sign-in unavailable', 'Discord sign-in is not configured on this server.');
  }
  const state = crypto.randomBytes(24).toString('base64url');
  oauthStates.set(state, { provider: 'discord', airlineSlug: null, expiresAt: Date.now() + STATE_TTL_MS });
  const url = new URL(discord.authorizeUrl);
  url.search = new URLSearchParams({
    client_id: discord.clientId,
    redirect_uri: discord.redirectUri,
    response_type: 'code',
    scope: 'identify',
    state,
  }).toString();
  res.redirect(url.toString());
});

app.get('/auth/discord/callback', async (req, res) => {
  const state = String(req.query.state || '');
  const entry = oauthStates.get(state);
  oauthStates.delete(state);
  if (!entry || entry.provider !== 'discord' || entry.expiresAt < Date.now()) {
    return sendPage(res, 400, 'Link expired', 'Start sign-in again from Jumpseat.');
  }
  if (req.query.error) return sendPage(res, 400, 'Sign-in cancelled', 'You did not finish signing in with Discord.');

  try {
    const tokenRes = await fetch(discord.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: discord.clientId,
        client_secret: discord.clientSecret,
        grant_type: 'authorization_code',
        code: String(req.query.code || ''),
        redirect_uri: discord.redirectUri,
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!tokenRes.ok) throw new Error(`discord token exchange failed: ${tokenRes.status}`);
    const { access_token: accessToken } = await tokenRes.json();

    const userRes = await fetch(discord.userUrl, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!userRes.ok) throw new Error(`discord user lookup failed: ${userRes.status}`);
    const me = await userRes.json();
    if (!me.id) throw new Error('discord user had no id');

    const user = upsertDiscordUser(String(me.id), me.username || '', me.global_name || '');
    store.save();
    auth.setSessionCookie(res, auth.createSession(store, user.id), SECURE_COOKIES);
    return res.redirect('/#/');
  } catch (err) {
    console.error('discord sign-in failed:', err.message);
    return sendPage(res, 502, 'Sign-in failed', 'Could not confirm with Discord. Try again in a moment.');
  }
});

app.get('/auth/roblox', (req, res) => {
  const airlineSlug = String(req.query.airline || '');
  if (!robloxConfigured) {
    if (DEV_LOGIN) return res.redirect(`/auth/login${airlineSlug ? `?airline=${encodeURIComponent(airlineSlug)}` : ''}`);
    return sendPage(res, 503, 'Roblox sign-in unavailable', 'Roblox sign-in is not configured on this server.');
  }
  if (airlineSlug) {
    const airline = findAirline(airlineSlug);
    if (!airline || airline.verified) {
      return sendPage(res, 404, 'Nothing to verify', 'That organisation does not exist or is already verified.');
    }
  }
  const state = crypto.randomBytes(24).toString('base64url');
  oauthStates.set(state, { provider: 'roblox', airlineSlug: airlineSlug || null, expiresAt: Date.now() + STATE_TTL_MS });

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

async function fetchRobloxUserInfo(code) {
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
  return { sub: String(info.sub), username: info.preferred_username || info.nickname || info.name || '' };
}

async function fetchGroupOwnerId(groupId) {
  const res = await fetch(`${roblox.groupUrl}${encodeURIComponent(groupId)}`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`group lookup failed: ${res.status}`);
  const group = await res.json();
  return group.owner?.userId != null ? String(group.owner.userId) : null;
}

app.get('/auth/roblox/callback', async (req, res) => {
  const state = String(req.query.state || '');
  const entry = oauthStates.get(state);
  oauthStates.delete(state);
  if (!entry || entry.provider !== 'roblox' || entry.expiresAt < Date.now()) {
    return sendPage(res, 400, 'Link expired', 'Start sign-in again from Jumpseat.');
  }
  if (req.query.error) return sendPage(res, 400, 'Sign-in cancelled', 'You did not finish signing in with Roblox.');

  const airline = entry.airlineSlug ? findAirline(entry.airlineSlug) : null;
  if (entry.airlineSlug && (!airline || airline.verified)) {
    return sendPage(res, 404, 'Nothing to verify', 'That organisation does not exist or is already verified.');
  }

  try {
    const info = await fetchRobloxUserInfo(String(req.query.code || ''));

    if (airline) {
      // Group verification: the signed-in Jumpseat account must be confirmed, and must be the group owner.
      if (!req.user) return sendPage(res, 401, 'Sign in first', 'Sign in to Jumpseat, then verify the organisation again.');
      if (!req.user.confirmed || req.user.robloxUserId !== info.sub) {
        return sendPage(res, 403, 'Confirm your Roblox account first', 'The Roblox account you sign in with must be the one you confirmed on your Jumpseat profile.');
      }
      const ownerId = await fetchGroupOwnerId(airline.robloxGroupId);
      if (!ownerId || ownerId !== info.sub) {
        return sendPage(res, 403, 'Not the group owner', 'Verification needs the Roblox account that owns this group.');
      }
      Object.assign(airline, { verified: true, ownerUserId: req.user.id, ownerRobloxId: info.sub });
      store.save();
      return res.redirect(`/#/airline/${encodeURIComponent(airline.slug)}`);
    }

    const user = upsertRobloxUser(info.sub, info.username);
    store.save();
    auth.setSessionCookie(res, auth.createSession(store, user.id), SECURE_COOKIES);
    return res.redirect('/#/');
  } catch (err) {
    console.error('roblox sign-in failed:', err.message);
    return sendPage(res, 502, 'Sign-in failed', 'Could not confirm with Roblox. Try again in a moment.');
  }
});

// Development-only sign-in. Refuses to run unless ALLOW_DEV_LOGIN=1 and NODE_ENV is not production.
app.get('/auth/dev', (req, res) => {
  if (!DEV_LOGIN) return sendPage(res, 404, 'Not found', 'Dev sign-in is disabled.');
  const username = String(req.query.username || '').trim();
  if (!USERNAME_RE.test(username)) return sendPage(res, 400, 'Invalid username', 'Use 3–20 letters, numbers or underscores.');

  const user = upsertRobloxUser(devRobloxId(username), username);
  // Dev only: treat the account as confirmed so the organisation flow can be tested offline.
  Object.assign(user, { confirmed: true, robloxUserId: devRobloxId(username), robloxUsername: username });
  store.save();
  auth.setSessionCookie(res, auth.createSession(store, user.id), SECURE_COOKIES);

  const airlineSlug = String(req.query.airline || '');
  const airline = airlineSlug ? findAirline(airlineSlug) : null;
  if (airline && !airline.verified) {
    // Dev only: skips the group-owner check.
    Object.assign(airline, { verified: true, ownerUserId: user.id, ownerRobloxId: user.robloxUserId });
    store.save();
    return res.redirect(`/#/airline/${encodeURIComponent(airline.slug)}`);
  }
  return res.redirect('/#/me');
});

app.post('/auth/logout', (req, res) => {
  auth.deleteSession(store, req);
  auth.clearSessionCookie(res);
  res.json({ ok: true });
});

// ---------- me, Roblox confirmation ----------

app.get('/api/me', (req, res) => {
  if (!req.user) {
    return res.json({ user: null, airlines: [], devLogin: DEV_LOGIN, robloxConfigured, discordConfigured });
  }
  const airlines = store.data.airlines
    .filter((a) => a.createdByUserId === req.user.id || a.ownerUserId === req.user.id)
    .map((a) => publicAirline(a, req.user));
  const pending = req.user.pendingRoblox && req.user.pendingRoblox.expiresAt > now()
    ? { code: req.user.pendingRoblox.code, robloxUsername: req.user.pendingRoblox.robloxUsername, expiresAt: req.user.pendingRoblox.expiresAt }
    : null;
  res.json({
    user: {
      ...publicUser(req.user),
      confirmed: Boolean(req.user.confirmed),
      robloxUsername: req.user.robloxUsername || null,
      hasDiscord: Boolean(req.user.discordId),
      hasRoblox: Boolean(req.user.robloxUserId),
    },
    isAdmin: isAdmin(req.user),
    pendingRoblox: pending,
    airlines,
    following: followingCount(req.user.id),
    devLogin: DEV_LOGIN,
  });
});

app.patch('/api/me', requireUser, (req, res) => {
  const u = req.user;
  if (req.body?.displayName !== undefined) {
    const value = String(req.body.displayName).trim();
    if (!value || value.length > LIMITS.displayName) return fail(res, 400, `Display name must be 1–${LIMITS.displayName} characters`);
    u.displayName = value;
  }
  if (req.body?.bio !== undefined) {
    const value = String(req.body.bio).trim();
    if (value.length > LIMITS.bio) return fail(res, 400, `Bio must be ${LIMITS.bio} characters or fewer`);
    u.bio = value;
  }
  store.save();
  res.json(publicUser(u));
});

// Step 1: look up the Roblox account and issue a one-time code to paste into its About section.
app.post('/api/me/roblox/start', requireUser, async (req, res) => {
  if (req.user.confirmed) return fail(res, 400, 'Your Roblox account is already confirmed');
  if (!rateLimit(`rbx-start:${req.user.id}`, 6, 60 * 60 * 1000)) return fail(res, 429, 'Too many attempts. Try again later.');
  const username = String(req.body?.username || '').trim();
  if (!USERNAME_RE.test(username)) return fail(res, 400, 'Roblox usernames are 3–20 letters, numbers or underscores');

  try {
    const lookup = await fetch(roblox.usernamesUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ usernames: [username], excludeBannedUsers: false }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!lookup.ok) return fail(res, 502, 'Could not reach Roblox. Try again in a moment.');
    const hit = (await lookup.json()).data?.[0];
    if (!hit) return fail(res, 404, 'No Roblox account with that username');

    const robloxUserId = String(hit.id);
    const linked = store.data.users.find((u) => u.id !== req.user.id && u.confirmed && u.robloxUserId === robloxUserId);
    if (linked) return fail(res, 409, 'That Roblox account is already confirmed on another Jumpseat account');

    const code = randomCode();
    req.user.pendingRoblox = { robloxUserId, robloxUsername: hit.name, code, expiresAt: new Date(Date.now() + CODE_TTL_MS).toISOString() };
    store.save();
    res.json({ code, robloxUsername: hit.name, expiresAt: req.user.pendingRoblox.expiresAt });
  } catch (err) {
    console.error('roblox lookup failed:', err.message);
    return fail(res, 502, 'Could not reach Roblox. Try again in a moment.');
  }
});

// Step 2: read the Roblox About text and confirm if the code is there.
app.post('/api/me/roblox/check', requireUser, async (req, res) => {
  const pending = req.user.pendingRoblox;
  if (!pending || pending.expiresAt < now()) return fail(res, 400, 'Your code expired or was not started. Get a new code.');
  if (!rateLimit(`rbx-check:${req.user.id}`, 20, 10 * 60 * 1000)) return fail(res, 429, 'Too many checks. Wait a few minutes.');

  try {
    const r = await fetch(`${roblox.userUrl}${encodeURIComponent(pending.robloxUserId)}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!r.ok) return fail(res, 502, 'Could not reach Roblox. Try again in a moment.');
    const profile = await r.json();
    if (!String(profile.description || '').includes(pending.code)) {
      return fail(res, 400, 'Code not found in your About yet. Paste it, save your profile, then check again.');
    }
    const linked = store.data.users.find((u) => u.id !== req.user.id && u.confirmed && u.robloxUserId === pending.robloxUserId);
    if (linked) return fail(res, 409, 'That Roblox account is already confirmed on another Jumpseat account');

    Object.assign(req.user, {
      confirmed: true,
      confirmedAt: now(),
      robloxUserId: pending.robloxUserId,
      robloxUsername: profile.name || pending.robloxUsername,
      pendingRoblox: null,
    });
    store.save();
    res.json({ ok: true, confirmed: true, robloxUsername: req.user.robloxUsername });
  } catch (err) {
    console.error('roblox profile check failed:', err.message);
    return fail(res, 502, 'Could not reach Roblox. Try again in a moment.');
  }
});

app.post('/api/me/roblox/cancel', requireUser, (req, res) => {
  req.user.pendingRoblox = null;
  store.save();
  res.json({ ok: true });
});

// Dev only: confirms without a Roblox lookup so the flow can be tested offline.
app.post('/api/me/roblox/dev-confirm', requireUser, (req, res) => {
  if (!DEV_LOGIN) return fail(res, 404, 'Not found');
  Object.assign(req.user, {
    confirmed: true,
    confirmedAt: now(),
    robloxUserId: devRobloxId(req.user.username),
    robloxUsername: req.user.username,
    pendingRoblox: null,
  });
  store.save();
  res.json({ ok: true, confirmed: true });
});

// ---------- users ----------

app.get('/api/users/:username', (req, res) => {
  const u = findUserByUsername(req.params.username);
  if (!u) return fail(res, 404, 'User not found');
  const posts = visiblePosts()
    .filter((p) => p.authorType === 'user' && p.authorUserId === u.id)
    .sort(byNewest)
    .slice(0, 50)
    .map((p) => publicPost(p, req.user));
  const airlines = store.data.airlines
    .filter((a) => a.verified && a.ownerUserId === u.id)
    .map((a) => ({ slug: a.slug, name: a.name, kind: a.kind || 'airline' }));
  res.json({
    ...publicUser(u),
    followers: followersOf('user', u.id),
    following: followingCount(u.id),
    isMe: Boolean(req.user) && req.user.id === u.id,
    followedByMe: isFollowing(req.user?.id, 'user', u.id),
    blockedByMe: Boolean(req.user) && blockedBy(req.user.id, u.id),
    canMessage: Boolean(req.user) && req.user.id !== u.id && !isBlocked(req.user.id, u.id),
    airlines,
    posts,
  });
});

// ---------- follows ----------

app.post('/api/follows', requireUser, (req, res) => {
  const targetType = String(req.body?.targetType || '');
  const targetId = String(req.body?.targetId || '');
  if (!['airline', 'user'].includes(targetType)) return fail(res, 400, 'targetType must be airline or user');

  const target = targetType === 'airline'
    ? store.data.airlines.find((a) => a.id === targetId)
    : store.data.users.find((u) => u.id === targetId);
  if (!target) return fail(res, 404, 'Not found');
  if (targetType === 'user' && target.id === req.user.id) return fail(res, 400, "You can't follow yourself");

  const idx = store.data.follows.findIndex(
    (f) => f.followerUserId === req.user.id && f.targetType === targetType && f.targetId === targetId,
  );
  let following;
  if (idx >= 0) {
    store.data.follows.splice(idx, 1);
    following = false;
  } else {
    store.data.follows.push({ followerUserId: req.user.id, targetType, targetId, createdAt: now() });
    following = true;
  }
  store.save();
  res.json({ following, followers: followersOf(targetType, targetId) });
});

// ---------- posts, likes, comments, reports ----------

app.get('/api/feed', requireUser, (req, res) => {
  const me = req.user;
  const followedAirlines = new Set(
    store.data.follows.filter((f) => f.followerUserId === me.id && f.targetType === 'airline').map((f) => f.targetId),
  );
  const followedUsers = new Set(
    store.data.follows.filter((f) => f.followerUserId === me.id && f.targetType === 'user').map((f) => f.targetId),
  );
  followedUsers.add(me.id);
  const ownedAirlines = new Set(store.data.airlines.filter((a) => isOwner(me, a)).map((a) => a.id));

  const posts = visiblePosts()
    .filter((p) => (p.authorType === 'airline'
      ? followedAirlines.has(p.airlineId) || ownedAirlines.has(p.airlineId)
      : followedUsers.has(p.authorUserId)))
    .sort(byNewest)
    .slice(0, 50)
    .map((p) => publicPost(p, me));
  res.json(posts);
});

app.get('/api/posts', (req, res) => {
  const sort = req.query.sort === 'top' ? 'top' : 'new';
  const tag = req.query.tag ? String(req.query.tag).toLowerCase() : null;
  const airlineSlug = req.query.airline ? String(req.query.airline) : null;

  let posts = visiblePosts();
  if (tag) posts = posts.filter((p) => p.tags.includes(tag));
  if (airlineSlug) {
    const airline = findAirline(airlineSlug);
    posts = airline ? posts.filter((p) => p.authorType === 'airline' && p.airlineId === airline.id) : [];
  }

  const shaped = posts.map((p) => publicPost(p, req.user));
  shaped.sort(sort === 'top'
    ? (a, b) => b.likeCount - a.likeCount || b.createdAt.localeCompare(a.createdAt)
    : byNewest);
  res.json(shaped.slice(0, 50));
});

app.get('/api/posts/:id', (req, res) => {
  const post = findPost(req.params.id);
  if (!post || post.hidden) return fail(res, 404, 'Post not found');
  const comments = store.data.comments
    .filter((c) => c.postId === post.id)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((c) => publicComment(c, req.user));
  res.json({ ...publicPost(post, req.user), comments });
});

app.post('/api/posts', requireUser, (req, res) => {
  if (!rateLimit(`post:${req.user.id}`, 10, 10 * 60 * 1000)) {
    return fail(res, 429, 'Slow down. Try again in a few minutes.');
  }
  const body = String(req.body?.body || '').trim();
  const mediaInput = String(req.body?.media || req.body?.imageUrl || '').trim();
  const airlineSlug = String(req.body?.airlineSlug || '').trim();

  if (!body || body.length > LIMITS.postBody) return fail(res, 400, `Post must be 1–${LIMITS.postBody} characters`);
  const parsed = parseMedia(mediaInput);
  if (parsed.error) return fail(res, 400, parsed.error);
  const media = parsed.media;

  let airline = null;
  if (airlineSlug) {
    airline = findAirline(airlineSlug);
    if (!airline) return fail(res, 404, 'Organisation not found');
    if (!isOwner(req.user, airline)) return fail(res, 403, 'You can only post as an organisation you own');
  }

  const post = {
    id: crypto.randomUUID(),
    authorType: airline ? 'airline' : 'user',
    airlineId: airline ? airline.id : null,
    authorUserId: req.user.id,
    body,
    imageUrl: media?.type === 'image' ? media.imageUrl : null,
    video: media?.type === 'video' ? media.video : null,
    tags: extractTags(body),
    hidden: false,
    createdAt: now(),
  };
  store.data.posts.push(post);
  store.save();
  res.status(201).json(publicPost(post, req.user));
});

app.delete('/api/posts/:id', requireUser, (req, res) => {
  const post = findPost(req.params.id);
  if (!post) return fail(res, 404, 'Post not found');
  if (!canManagePost(req.user, post)) return fail(res, 403, 'You can only delete your own posts');
  removePost(post.id);
  store.save();
  res.json({ ok: true });
});

function removePost(postId) {
  store.data.posts = store.data.posts.filter((p) => p.id !== postId);
  store.data.comments = store.data.comments.filter((c) => c.postId !== postId);
  store.data.likes = store.data.likes.filter((l) => l.postId !== postId);
  store.data.reports = store.data.reports.filter((r) => r.postId !== postId);
}

app.post('/api/posts/:id/like', requireUser, (req, res) => {
  const post = findPost(req.params.id);
  if (!post || post.hidden) return fail(res, 404, 'Post not found');
  const idx = store.data.likes.findIndex((l) => l.postId === post.id && l.userId === req.user.id);
  let liked;
  if (idx >= 0) {
    store.data.likes.splice(idx, 1);
    liked = false;
  } else {
    store.data.likes.push({ postId: post.id, userId: req.user.id, createdAt: now() });
    liked = true;
  }
  store.save();
  res.json({ liked, likeCount: store.data.likes.filter((l) => l.postId === post.id).length });
});

app.post('/api/posts/:id/comments', requireUser, (req, res) => {
  const post = findPost(req.params.id);
  if (!post || post.hidden) return fail(res, 404, 'Post not found');
  if (!rateLimit(`comment:${req.user.id}`, 20, 10 * 60 * 1000)) {
    return fail(res, 429, 'Slow down. Try again in a few minutes.');
  }
  const body = String(req.body?.body || '').trim();
  if (!body || body.length > LIMITS.commentBody) return fail(res, 400, `Comment must be 1–${LIMITS.commentBody} characters`);

  const comment = { id: crypto.randomUUID(), postId: post.id, authorUserId: req.user.id, body, createdAt: now() };
  store.data.comments.push(comment);
  store.save();
  res.status(201).json(publicComment(comment, req.user));
});

app.delete('/api/comments/:id', requireUser, (req, res) => {
  const idx = store.data.comments.findIndex((c) => c.id === req.params.id);
  if (idx < 0) return fail(res, 404, 'Comment not found');
  if (store.data.comments[idx].authorUserId !== req.user.id) return fail(res, 403, 'You can only delete your own comments');
  store.data.comments.splice(idx, 1);
  store.save();
  res.json({ ok: true });
});

// Three distinct reporters hide a post automatically, pending review by an admin.
app.post('/api/posts/:id/report', requireUser, (req, res) => {
  const post = findPost(req.params.id);
  if (!post || post.hidden) return fail(res, 404, 'Post not found');
  const reason = String(req.body?.reason || '').trim().slice(0, LIMITS.reportReason) || 'unspecified';
  if (!store.data.reports.some((r) => r.postId === post.id && r.reporterUserId === req.user.id)) {
    store.data.reports.push({ id: crypto.randomUUID(), postId: post.id, reporterUserId: req.user.id, reason, createdAt: now() });
  }
  const reporters = new Set(store.data.reports.filter((r) => r.postId === post.id).map((r) => r.reporterUserId)).size;
  if (reporters >= REPORT_HIDE_THRESHOLD) post.hidden = true;
  store.save();
  res.json({ ok: true, hidden: post.hidden });
});

// ---------- discovery ----------

app.get('/api/tags', (req, res) => {
  const counts = new Map();
  for (const p of visiblePosts()) {
    for (const t of p.tags) counts.set(t, (counts.get(t) || 0) + 1);
  }
  res.json([...counts].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([tag, count]) => ({ tag, count })));
});

app.get('/api/discover', (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  if (!q) return res.json({ airlines: [], users: [], posts: [], jobs: [] });
  const match = (...fields) => fields.some((f) => String(f || '').toLowerCase().includes(q));

  res.json({
    airlines: store.data.airlines
      .filter((a) => match(a.name, a.description))
      .slice(0, 10)
      .map((a) => publicAirline(a, req.user)),
    users: store.data.users
      .filter((u) => match(u.username, u.displayName))
      .slice(0, 10)
      .map(publicUser),
    posts: visiblePosts()
      .filter((p) => match(p.body))
      .sort(byNewest)
      .slice(0, 10)
      .map((p) => publicPost(p, req.user)),
    jobs: store.data.jobs
      .filter((j) => isLive(j) && match(j.title, j.description))
      .slice(0, 10)
      .map(publicJob),
  });
});

// ---------- organisations (airlines, Roblox stores, other) ----------

app.get('/api/airlines', (req, res) => {
  res.json(store.data.airlines.map((a) => publicAirline(a, req.user)));
});

app.get('/api/airlines/:slug', (req, res) => {
  const airline = findAirline(req.params.slug);
  if (!airline) return fail(res, 404, 'Organisation not found');
  const jobs = store.data.jobs
    .filter((j) => j.airlineId === airline.id && isLive(j))
    .sort(byNewest)
    .map(publicJob);
  const posts = visiblePosts()
    .filter((p) => p.authorType === 'airline' && p.airlineId === airline.id)
    .sort(byNewest)
    .slice(0, 50)
    .map((p) => publicPost(p, req.user));
  res.json({ ...publicAirline(airline, req.user), jobs, posts });
});

app.post('/api/airlines', requireUser, (req, res) => {
  // Gate: an organisation needs a confirmed Roblox account first.
  if (!req.user.confirmed) {
    return fail(res, 403, 'Confirm your Roblox account before setting up an organisation', { code: 'confirm_required' });
  }
  const listed = store.data.airlines.filter((a) => a.createdByUserId === req.user.id).length;
  if (listed >= LIMITS.orgsPerUser) return fail(res, 400, `You can list up to ${LIMITS.orgsPerUser} organisations`);

  const name = String(req.body?.name || '').trim();
  const kind = String(req.body?.kind || 'airline');
  const robloxGroupId = String(req.body?.robloxGroupId || '').trim();
  const description = String(req.body?.description || '').trim();
  const discordWebhook = String(req.body?.discordWebhook || '').trim();
  const discordInvite = String(req.body?.discordInvite || '').trim();

  if (!KINDS[kind]) return fail(res, 400, 'Type must be airline, store or other');
  if (name.length < 2 || name.length > 40) return fail(res, 400, 'Name must be 2–40 characters');
  if (!/^\d{1,12}$/.test(robloxGroupId)) return fail(res, 400, 'Roblox group ID must be numbers only');
  if (description.length > 500) return fail(res, 400, 'Description must be 500 characters or fewer');
  const webhookError = validateWebhook(discordWebhook);
  if (webhookError) return fail(res, 400, webhookError);
  const inviteError = validateInvite(discordInvite);
  if (inviteError) return fail(res, 400, inviteError);
  if (store.data.airlines.some((a) => a.robloxGroupId === robloxGroupId)) {
    return fail(res, 409, 'That Roblox group is already listed');
  }

  const base = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'org';
  let slug = base;
  let n = 2;
  while (store.data.airlines.some((a) => a.slug === slug)) slug = `${base}-${n++}`;

  const airline = {
    id: crypto.randomUUID(),
    slug,
    name,
    kind,
    description,
    robloxGroupId,
    verified: false,
    ownerUserId: null,
    ownerRobloxId: null,
    createdByUserId: req.user.id,
    discordInvite: discordInvite || null,
    discordWebhook: discordWebhook || null,
    sample: false,
    createdAt: now(),
  };
  store.data.airlines.push(airline);
  store.save();
  res.status(201).json({
    ...publicAirline(airline, req.user),
    verifyUrl: `/auth/roblox?airline=${encodeURIComponent(slug)}`,
  });
});

// Owner settings. Only the verified owner can change them.
app.patch('/api/airlines/:slug', requireUser, (req, res) => {
  const airline = findAirline(req.params.slug);
  if (!airline) return fail(res, 404, 'Organisation not found');
  if (!isOwner(req.user, airline)) return fail(res, 403, 'Only the verified owner can edit this organisation');

  if (req.body?.description !== undefined) {
    const value = String(req.body.description).trim();
    if (value.length > 500) return fail(res, 400, 'Description must be 500 characters or fewer');
    airline.description = value;
  }
  if (req.body?.discordInvite !== undefined) {
    const value = String(req.body.discordInvite).trim();
    const error = validateInvite(value);
    if (error) return fail(res, 400, error);
    airline.discordInvite = value || null;
  }
  if (req.body?.discordWebhook !== undefined) {
    const value = String(req.body.discordWebhook).trim();
    const error = validateWebhook(value);
    if (error) return fail(res, 400, error);
    airline.discordWebhook = value || null;
  }
  store.save();
  res.json(publicAirline(airline, req.user));
});

app.post('/api/airlines/:slug/jobs', requireUser, (req, res) => {
  const airline = findAirline(req.params.slug);
  if (!airline) return fail(res, 404, 'Organisation not found');
  if (!isOwner(req.user, airline)) return fail(res, 403, 'Only the verified owner can post roles');
  const { value, error } = validateJobFields(req.body);
  if (error) return fail(res, 400, error);

  const job = { id: crypto.randomUUID(), airlineId: airline.id, ...value, open: true, createdAt: now() };
  store.data.jobs.push(job);
  store.save();
  res.status(201).json(publicJob(job));
});

app.post('/api/airlines/:slug/jobs/:jobId/close', requireUser, (req, res) => {
  const airline = findAirline(req.params.slug);
  if (!airline) return fail(res, 404, 'Organisation not found');
  if (!isOwner(req.user, airline)) return fail(res, 403, 'Only the verified owner can close roles');
  const job = store.data.jobs.find((j) => j.id === req.params.jobId && j.airlineId === airline.id);
  if (!job) return fail(res, 404, 'Job not found');
  job.open = false;
  store.save();
  res.json(publicJob(job));
});

// ---------- jobs ----------

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

app.post('/api/jobs/:id/applications', async (req, res) => {
  const job = store.data.jobs.find((j) => j.id === req.params.id);
  if (!job || !isLive(job)) return fail(res, 404, 'Job not found or closed');
  if (!rateLimit(`apply:${req.ip}`, 5, 10 * 60 * 1000)) {
    return fail(res, 429, 'Too many applications. Try again later.');
  }

  const robloxUsername = String(req.body?.robloxUsername || req.user?.username || '').trim();
  const message = String(req.body?.message || '').trim();
  if (!USERNAME_RE.test(robloxUsername)) {
    return fail(res, 400, 'Roblox username must be 3–20 letters, numbers or underscores');
  }
  if (message.length > 1000) return fail(res, 400, 'Message must be 1000 characters or fewer');

  const airline = findAirlineById(job.airlineId);
  const application = {
    id: crypto.randomUUID(),
    jobId: job.id,
    airlineId: job.airlineId,
    applicantUserId: req.user?.id || null,
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

// ---------- direct messages ----------
//
// Rules, enforced here and not in the browser:
//  - Starting a conversation creates a *request*. The recipient must accept before they can reply.
//  - Until accepted, the sender may send one message and then has to wait.
//  - Either side can block, which stops all messages both ways. Either side can decline or report.
//  - Only participants can read a conversation. Non-participants get a 404.

const DM_TEXT_MAX = 1000;
const DM_REASONS = {
  'you-blocked': 'You blocked this account. Unblock to message again.',
  'they-blocked': 'You cannot message this account.',
  waiting: 'Wait for them to accept your request before sending more.',
  request: 'Accept the request to reply.',
};

const blockedBy = (blockerId, blockedId) =>
  store.data.blocks.some((b) => b.blockerId === blockerId && b.blockedId === blockedId);
const isBlocked = (a, b) => blockedBy(a, b) || blockedBy(b, a);
const findConversation = (a, b) =>
  store.data.conversations.find((c) => c.participantIds.includes(a) && c.participantIds.includes(b));
const findConversationFor = (id, user) => {
  const conv = store.data.conversations.find((c) => c.id === id);
  return conv && conv.participantIds.includes(user.id) ? conv : null;
};
const otherParticipant = (conv, userId) => conv.participantIds.find((id) => id !== userId);
const messagesIn = (convId) =>
  store.data.messages
    .filter((m) => m.conversationId === convId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

function unreadFor(conv, userId) {
  const readAt = conv.readAt?.[userId] || '';
  return store.data.messages.filter(
    (m) => m.conversationId === conv.id && m.senderUserId !== userId && m.createdAt > readAt,
  ).length;
}

// What this user may do in this conversation right now, decided on the server.
function sendState(conv, user) {
  const other = otherParticipant(conv, user.id);
  if (blockedBy(user.id, other)) return { canSend: false, reason: 'you-blocked' };
  if (blockedBy(other, user.id)) return { canSend: false, reason: 'they-blocked' };
  if (conv.status === 'accepted') return { canSend: true, reason: null };
  if (conv.status === 'pending') {
    if (conv.initiatorUserId === user.id) {
      const sentOne = store.data.messages.some((m) => m.conversationId === conv.id && m.senderUserId === user.id);
      return sentOne ? { canSend: false, reason: 'waiting' } : { canSend: true, reason: null };
    }
    return { canSend: false, reason: 'request' };
  }
  return { canSend: false, reason: 'declined' };
}

function publicConversation(conv, user) {
  const msgs = messagesIn(conv.id);
  const last = msgs[msgs.length - 1];
  return {
    id: conv.id,
    status: conv.status,
    role: conv.initiatorUserId === user.id ? 'initiator' : 'recipient',
    other: miniUser(otherParticipant(conv, user.id)),
    lastMessage: last ? { body: last.body, createdAt: last.createdAt, mine: last.senderUserId === user.id } : null,
    unread: unreadFor(conv, user.id),
    updatedAt: conv.updatedAt,
  };
}

app.get('/api/conversations', requireUser, (req, res) => {
  const me = req.user;
  const conversations = store.data.conversations
    .filter((c) => c.participantIds.includes(me.id) && c.status !== 'declined' && !isBlocked(me.id, otherParticipant(c, me.id)))
    .map((c) => ({
      ...publicConversation(c, me),
      kind: c.status === 'pending' && c.initiatorUserId !== me.id ? 'request' : 'inbox',
    }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const totalUnread = conversations.reduce((sum, c) => sum + c.unread, 0);
  res.json({ conversations, totalUnread });
});

app.post('/api/conversations', requireUser, (req, res) => {
  if (!rateLimit(`dm-start:${req.user.id}`, 10, 10 * 60 * 1000)) {
    return fail(res, 429, 'Too many new conversations. Try again later.');
  }
  const target = findUserByUsername(String(req.body?.username || '').trim());
  if (!target) return fail(res, 404, 'No Jumpseat account with that username');
  if (target.id === req.user.id) return fail(res, 400, "You can't message yourself");
  if (isBlocked(req.user.id, target.id)) return fail(res, 403, 'You cannot message this account');

  const existing = findConversation(req.user.id, target.id);
  if (existing) {
    if (existing.status === 'declined') {
      return fail(res, 403, existing.initiatorUserId === req.user.id
        ? 'This account is not accepting messages from you'
        : 'You declined this conversation');
    }
    return res.json(publicConversation(existing, req.user));
  }

  const conv = {
    id: crypto.randomUUID(),
    participantIds: [req.user.id, target.id],
    initiatorUserId: req.user.id,
    status: 'pending',
    readAt: {},
    createdAt: now(),
    updatedAt: now(),
  };
  store.data.conversations.push(conv);
  store.save();
  res.status(201).json(publicConversation(conv, req.user));
});

app.get('/api/conversations/:id', requireUser, (req, res) => {
  const conv = findConversationFor(req.params.id, req.user);
  if (!conv || conv.status === 'declined') return fail(res, 404, 'Conversation not found');

  const other = miniUser(otherParticipant(conv, req.user.id));
  const state = sendState(conv, req.user);
  const messages = messagesIn(conv.id)
    .slice(-200)
    .map((m) => ({ id: m.id, body: m.body, createdAt: m.createdAt, mine: m.senderUserId === req.user.id }));

  if (unreadFor(conv, req.user.id) > 0) {
    conv.readAt = { ...(conv.readAt || {}), [req.user.id]: now() };
    store.save();
  }
  res.json({
    id: conv.id,
    status: conv.status,
    role: conv.initiatorUserId === req.user.id ? 'initiator' : 'recipient',
    other,
    canSend: state.canSend,
    reason: state.reason,
    reasonText: state.reason ? DM_REASONS[state.reason] || 'You cannot send messages here' : null,
    messages,
  });
});

app.post('/api/conversations/:id/messages', requireUser, (req, res) => {
  const conv = findConversationFor(req.params.id, req.user);
  if (!conv || conv.status === 'declined') return fail(res, 404, 'Conversation not found');

  const state = sendState(conv, req.user);
  if (!state.canSend) return fail(res, 403, DM_REASONS[state.reason] || 'You cannot send messages here');
  if (!rateLimit(`dm:${req.user.id}`, 30, 10 * 60 * 1000)) return fail(res, 429, 'Slow down. Try again in a few minutes.');

  const body = String(req.body?.body || '').trim();
  if (!body || body.length > DM_TEXT_MAX) return fail(res, 400, `Message must be 1–${DM_TEXT_MAX} characters`);

  const message = { id: crypto.randomUUID(), conversationId: conv.id, senderUserId: req.user.id, body, createdAt: now() };
  store.data.messages.push(message);
  conv.updatedAt = message.createdAt;
  store.save();
  res.status(201).json({ id: message.id, body, createdAt: message.createdAt, mine: true });
});

app.post('/api/conversations/:id/accept', requireUser, (req, res) => {
  const conv = findConversationFor(req.params.id, req.user);
  if (!conv) return fail(res, 404, 'Conversation not found');
  if (conv.status !== 'pending' || conv.initiatorUserId === req.user.id) return fail(res, 400, 'Nothing to accept');
  conv.status = 'accepted';
  conv.updatedAt = now();
  store.save();
  res.json(publicConversation(conv, req.user));
});

app.post('/api/conversations/:id/decline', requireUser, (req, res) => {
  const conv = findConversationFor(req.params.id, req.user);
  if (!conv) return fail(res, 404, 'Conversation not found');
  if (conv.status !== 'pending' || conv.initiatorUserId === req.user.id) return fail(res, 400, 'Nothing to decline');
  conv.status = 'declined';
  conv.updatedAt = now();
  store.save();
  res.json({ ok: true });
});

app.post('/api/conversations/:id/report', requireUser, (req, res) => {
  const conv = findConversationFor(req.params.id, req.user);
  if (!conv) return fail(res, 404, 'Conversation not found');
  const reason = String(req.body?.reason || '').trim().slice(0, LIMITS.reportReason) || 'unspecified';
  store.data.reports.push({
    id: crypto.randomUUID(),
    conversationId: conv.id,
    reporterUserId: req.user.id,
    reason,
    createdAt: now(),
  });
  store.save();
  res.json({ ok: true });
});

// Toggle a block. Blocking stops messages both ways. It does not hide public posts.
app.post('/api/users/:id/block', requireUser, (req, res) => {
  const target = store.data.users.find((u) => u.id === req.params.id);
  if (!target) return fail(res, 404, 'User not found');
  if (target.id === req.user.id) return fail(res, 400, "You can't block yourself");
  const idx = store.data.blocks.findIndex((b) => b.blockerId === req.user.id && b.blockedId === target.id);
  let blocked;
  if (idx >= 0) {
    store.data.blocks.splice(idx, 1);
    blocked = false;
  } else {
    store.data.blocks.push({ blockerId: req.user.id, blockedId: target.id, createdAt: now() });
    blocked = true;
  }
  store.save();
  res.json({ blocked });
});

// ---------- admin ----------

app.get('/api/admin/reports', requireUser, requireAdmin, (req, res) => {
  const byPost = new Map();
  for (const r of store.data.reports) {
    if (!r.postId) continue;
    const entry = byPost.get(r.postId) || { reporters: new Set(), reasons: [] };
    entry.reporters.add(r.reporterUserId);
    entry.reasons.push(r.reason);
    byPost.set(r.postId, entry);
  }
  const posts = [...byPost.entries()]
    .map(([postId, entry]) => {
      const post = findPost(postId);
      return post
        ? { post: publicPost(post, req.user), reportCount: entry.reporters.size, reasons: entry.reasons.slice(0, 5), hidden: post.hidden }
        : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.reportCount - a.reportCount);

  const conversations = store.data.reports
    .filter((r) => r.conversationId)
    .map((r) => ({ id: r.id, conversationId: r.conversationId, reason: r.reason, createdAt: r.createdAt, reporter: miniUser(r.reporterUserId) }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  res.json({ posts, conversations });
});

app.post('/api/admin/posts/:id/restore', requireUser, requireAdmin, (req, res) => {
  const post = findPost(req.params.id);
  if (!post) return fail(res, 404, 'Post not found');
  post.hidden = false;
  store.data.reports = store.data.reports.filter((r) => r.postId !== post.id);
  store.save();
  res.json({ ok: true });
});

app.post('/api/admin/posts/:id/remove', requireUser, requireAdmin, (req, res) => {
  const post = findPost(req.params.id);
  if (!post) return fail(res, 404, 'Post not found');
  removePost(post.id);
  store.save();
  res.json({ ok: true });
});

app.get('/api/admin/users', requireUser, requireAdmin, (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  const users = store.data.users
    .filter((u) => !q || u.username.toLowerCase().includes(q) || (u.displayName || '').toLowerCase().includes(q))
    .slice(0, 25)
    .map((u) => ({ ...publicUser(u), id: u.id, verifiedMember: Boolean(u.verifiedMember), confirmed: Boolean(u.confirmed) }));
  res.json(users);
});

app.post('/api/admin/users/:id/member', requireUser, requireAdmin, (req, res) => {
  const target = store.data.users.find((u) => u.id === req.params.id);
  if (!target) return fail(res, 404, 'User not found');
  target.verifiedMember = Boolean(req.body?.verified);
  store.save();
  res.json({ ok: true, badges: badgesOf(target) });
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
  if (DEV_LOGIN) console.warn('WARNING: ALLOW_DEV_LOGIN=1 is set. Dev sign-in is enabled. Never run this in production.');
});
