'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { Store } = require('./src/store');
const auth = require('./src/auth');
const { now, sha256, escapeHtml, byNewest, isHttpsUrl, extractTags, rateLimit } = require('./src/util');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const SECURE_COOKIES = PUBLIC_URL.startsWith('https://');
// Dev sign-in lets you test without Roblox credentials. It is off unless explicitly enabled.
const DEV_LOGIN = process.env.ALLOW_DEV_LOGIN === '1' && process.env.NODE_ENV !== 'production';

const ROLES = ['pilot', 'cabin-crew', 'ground'];
const ROLE_LABELS = { pilot: 'Pilot', 'cabin-crew': 'Cabin Crew', ground: 'Ground Ops' };
const LIMITS = { postBody: 500, commentBody: 280, bio: 160, displayName: 40, reportReason: 200, airlinesPerUser: 3 };
const REPORT_HIDE_THRESHOLD = 3;
const STATE_TTL_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;
const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;

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
const robloxConfigured = Boolean(roblox.clientId && roblox.clientSecret);

const store = new Store(path.join(__dirname, 'data', 'db.json'));
const oauthStates = new Map(); // state -> { airlineSlug, expiresAt }

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

const fail = (res, status, error) => res.status(status).json({ error });
const requireUser = (req, res, next) => (req.user ? next() : fail(res, 401, 'Sign in with Roblox first'));

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
  };
}

function authorOf(post) {
  if (post.authorType === 'airline') {
    const airline = findAirlineById(post.airlineId);
    return {
      type: 'airline',
      slug: airline?.slug || null,
      name: airline?.name || 'Unknown airline',
      verified: Boolean(airline?.verified),
    };
  }
  const user = store.data.users.find((u) => u.id === post.authorUserId);
  return {
    type: 'user',
    username: user?.username || 'unknown',
    name: user?.displayName || user?.username || 'unknown',
  };
}

function publicPost(post, viewer) {
  const likes = store.data.likes.filter((l) => l.postId === post.id);
  return {
    id: post.id,
    body: post.body,
    imageUrl: post.imageUrl,
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
    author: { username: user?.username || 'unknown', name: user?.displayName || user?.username || 'unknown' },
    mine: Boolean(viewer) && c.authorUserId === viewer.id,
  };
}

function publicAirline(a, viewer) {
  return {
    id: a.id,
    slug: a.slug,
    name: a.name,
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
    airline: airline ? { slug: airline.slug, name: airline.name, verified: airline.verified } : null,
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

// Shared by the Roblox and dev sign-in paths. Creates or updates the user record.
function upsertRobloxUser(robloxUserId, rawName) {
  const cleanName = USERNAME_RE.test(rawName || '') ? rawName : null;
  let user = store.data.users.find((u) => u.robloxUserId === robloxUserId);
  if (!user) {
    const base = cleanName || `user_${robloxUserId.slice(-6)}`;
    const taken = store.data.users.some((u) => u.username.toLowerCase() === base.toLowerCase());
    user = {
      id: crypto.randomUUID(),
      robloxUserId,
      username: taken ? `${base.slice(0, 15)}_${robloxUserId.slice(-4)}` : base,
      displayName: base,
      bio: '',
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

function devLoginPage(airline) {
  return page(
    'Dev sign-in',
    `<p class="eyebrow">Development only</p>
<h1>Sign in</h1>
<p class="muted">Roblox sign-in is not configured here, so pick any username to test with.</p>
<form method="get" action="/auth/dev" class="form">
  <input type="hidden" name="airline" value="${escapeHtml(airline)}">
  <label>Username
    <input name="username" required minlength="3" maxlength="20" pattern="[A-Za-z0-9_]{3,20}" autocomplete="off">
  </label>
  <button class="btn" type="submit">Continue</button>
</form>`,
  );
}

// ---------- Roblox and dev sign-in ----------

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
  return {
    sub: String(info.sub),
    username: info.preferred_username || info.nickname || info.name || '',
  };
}

async function fetchGroupOwnerId(groupId) {
  const res = await fetch(`${roblox.groupUrl}${encodeURIComponent(groupId)}`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`group lookup failed: ${res.status}`);
  const group = await res.json();
  return group.owner?.userId != null ? String(group.owner.userId) : null;
}

app.get('/auth/login', (req, res) => {
  const airline = String(req.query.airline || '');
  if (robloxConfigured) {
    return res.redirect(`/auth/roblox${airline ? `?airline=${encodeURIComponent(airline)}` : ''}`);
  }
  if (DEV_LOGIN) return res.type('html').send(devLoginPage(airline));
  return sendPage(res, 503, 'Sign-in unavailable', 'Roblox sign-in is not configured on this server.');
});

app.get('/auth/roblox', (req, res) => {
  const airlineSlug = String(req.query.airline || '');
  if (!robloxConfigured) {
    if (DEV_LOGIN) return res.redirect(`/auth/login${airlineSlug ? `?airline=${encodeURIComponent(airlineSlug)}` : ''}`);
    return sendPage(res, 503, 'Sign-in unavailable', 'Roblox sign-in is not configured on this server.');
  }
  if (airlineSlug) {
    const airline = findAirline(airlineSlug);
    if (!airline || airline.verified) {
      return sendPage(res, 404, 'Nothing to verify', 'That airline does not exist or is already verified.');
    }
  }

  const state = crypto.randomBytes(24).toString('base64url');
  oauthStates.set(state, { airlineSlug: airlineSlug || null, expiresAt: Date.now() + STATE_TTL_MS });

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
    return sendPage(res, 400, 'Link expired', 'Start sign-in again from Jumpseat.');
  }
  if (req.query.error) {
    return sendPage(res, 400, 'Sign-in cancelled', 'You did not finish signing in with Roblox.');
  }

  const airline = entry.airlineSlug ? findAirline(entry.airlineSlug) : null;
  if (entry.airlineSlug && (!airline || airline.verified)) {
    return sendPage(res, 404, 'Nothing to verify', 'That airline does not exist or is already verified.');
  }

  try {
    const info = await fetchRobloxUserInfo(String(req.query.code || ''));
    const user = upsertRobloxUser(info.sub, info.username);
    auth.setSessionCookie(res, auth.createSession(store, user.id), SECURE_COOKIES);

    if (!airline) return res.redirect('/#/me');

    const ownerId = await fetchGroupOwnerId(airline.robloxGroupId);
    if (!ownerId || ownerId !== info.sub) {
      return sendPage(
        res,
        403,
        'Not the group owner',
        `You are signed in as @${user.username}, but that account does not own this Roblox group.`,
      );
    }
    Object.assign(airline, { verified: true, ownerUserId: user.id, ownerRobloxId: info.sub });
    store.save();
    return res.redirect(`/#/airline/${encodeURIComponent(airline.slug)}`);
  } catch (err) {
    console.error('sign-in failed:', err.message);
    return sendPage(res, 502, 'Sign-in failed', 'Could not confirm with Roblox. Try again in a moment.');
  }
});

// Development-only sign-in. Refuses to run unless ALLOW_DEV_LOGIN=1 and NODE_ENV is not production.
app.get('/auth/dev', (req, res) => {
  if (!DEV_LOGIN) return sendPage(res, 404, 'Not found', 'Dev sign-in is disabled.');
  const username = String(req.query.username || '').trim();
  if (!USERNAME_RE.test(username)) {
    return sendPage(res, 400, 'Invalid username', 'Use 3–20 letters, numbers or underscores.');
  }
  const user = upsertRobloxUser(devRobloxId(username), username);
  auth.setSessionCookie(res, auth.createSession(store, user.id), SECURE_COOKIES);

  const airlineSlug = String(req.query.airline || '');
  const airline = airlineSlug ? findAirline(airlineSlug) : null;
  if (airline && !airline.verified) {
    // Dev only: skips the group-owner check so the flow can be tested without a real group.
    Object.assign(airline, { verified: true, ownerUserId: user.id, ownerRobloxId: devRobloxId(username) });
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

// ---------- me ----------

app.get('/api/me', (req, res) => {
  if (!req.user) {
    return res.json({ user: null, airlines: [], devLogin: DEV_LOGIN, robloxConfigured });
  }
  const airlines = store.data.airlines
    .filter((a) => a.createdByUserId === req.user.id || a.ownerUserId === req.user.id)
    .map((a) => publicAirline(a, req.user));
  res.json({ user: publicUser(req.user), airlines, following: followingCount(req.user.id) });
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
    .map((a) => ({ slug: a.slug, name: a.name }));
  res.json({
    ...publicUser(u),
    followers: followersOf('user', u.id),
    following: followingCount(u.id),
    isMe: Boolean(req.user) && req.user.id === u.id,
    followedByMe: isFollowing(req.user?.id, 'user', u.id),
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
  const imageUrl = String(req.body?.imageUrl || '').trim();
  const airlineSlug = String(req.body?.airlineSlug || '').trim();

  if (!body || body.length > LIMITS.postBody) return fail(res, 400, `Post must be 1–${LIMITS.postBody} characters`);
  if (imageUrl && (imageUrl.length > 500 || !isHttpsUrl(imageUrl))) {
    return fail(res, 400, 'Image must be an https:// link under 500 characters');
  }

  let airline = null;
  if (airlineSlug) {
    airline = findAirline(airlineSlug);
    if (!airline) return fail(res, 404, 'Airline not found');
    if (!isOwner(req.user, airline)) return fail(res, 403, 'You can only post as an airline you own');
  }

  const post = {
    id: crypto.randomUUID(),
    authorType: airline ? 'airline' : 'user',
    airlineId: airline ? airline.id : null,
    authorUserId: req.user.id,
    body,
    imageUrl: imageUrl || null,
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
  store.data.posts = store.data.posts.filter((p) => p.id !== post.id);
  store.data.comments = store.data.comments.filter((c) => c.postId !== post.id);
  store.data.likes = store.data.likes.filter((l) => l.postId !== post.id);
  store.data.reports = store.data.reports.filter((r) => r.postId !== post.id);
  store.save();
  res.json({ ok: true });
});

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

// Three distinct reporters hide a post automatically, pending review.
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

// ---------- airlines ----------

app.get('/api/airlines', (req, res) => {
  res.json(store.data.airlines.map((a) => publicAirline(a, req.user)));
});

app.get('/api/airlines/:slug', (req, res) => {
  const airline = findAirline(req.params.slug);
  if (!airline) return fail(res, 404, 'Airline not found');
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
  const listed = store.data.airlines.filter((a) => a.createdByUserId === req.user.id).length;
  if (listed >= LIMITS.airlinesPerUser) return fail(res, 400, `You can list up to ${LIMITS.airlinesPerUser} airlines`);

  const name = String(req.body?.name || '').trim();
  const robloxGroupId = String(req.body?.robloxGroupId || '').trim();
  const description = String(req.body?.description || '').trim();
  const discordWebhook = String(req.body?.discordWebhook || '').trim();
  const discordInvite = String(req.body?.discordInvite || '').trim();

  if (name.length < 2 || name.length > 40) return fail(res, 400, 'Airline name must be 2–40 characters');
  if (!/^\d{1,12}$/.test(robloxGroupId)) return fail(res, 400, 'Roblox group ID must be numbers only');
  if (description.length > 500) return fail(res, 400, 'Description must be 500 characters or fewer');
  const webhookError = validateWebhook(discordWebhook);
  if (webhookError) return fail(res, 400, webhookError);
  const inviteError = validateInvite(discordInvite);
  if (inviteError) return fail(res, 400, inviteError);
  if (store.data.airlines.some((a) => a.robloxGroupId === robloxGroupId)) {
    return fail(res, 409, 'That Roblox group is already listed');
  }

  const base = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'airline';
  let slug = base;
  let n = 2;
  while (store.data.airlines.some((a) => a.slug === slug)) slug = `${base}-${n++}`;

  const airline = {
    id: crypto.randomUUID(),
    slug,
    name,
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
  if (!airline) return fail(res, 404, 'Airline not found');
  if (!isOwner(req.user, airline)) return fail(res, 403, 'Only the verified owner can edit this airline');

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
  if (!airline) return fail(res, 404, 'Airline not found');
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
  if (!airline) return fail(res, 404, 'Airline not found');
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
