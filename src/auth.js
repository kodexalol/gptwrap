'use strict';

const { now, sha256, randomToken } = require('./util');

const COOKIE = 'jumpseat_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    const i = trimmed.indexOf('=');
    if (i > 0) out[decodeURIComponent(trimmed.slice(0, i))] = decodeURIComponent(trimmed.slice(i + 1));
  }
  return out;
}

// Sessions are random tokens. Only their SHA-256 hash is stored.
function createSession(store, userId) {
  const token = randomToken();
  const nowIso = now();
  store.data.sessions = store.data.sessions.filter((s) => s.expiresAt > nowIso);
  store.data.sessions.push({
    tokenHash: sha256(token),
    userId,
    createdAt: nowIso,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
  });
  store.save();
  return token;
}

function userFromRequest(store, req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return null;
  const hash = sha256(token);
  const nowIso = now();
  const session = store.data.sessions.find((s) => s.tokenHash === hash && s.expiresAt > nowIso);
  if (!session) return null;
  return store.data.users.find((u) => u.id === session.userId) || null;
}

function deleteSession(store, req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return;
  const hash = sha256(token);
  store.data.sessions = store.data.sessions.filter((s) => s.tokenHash !== hash);
  store.save();
}

function setSessionCookie(res, token, secure) {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  res.append('Set-Cookie', `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`);
}

function clearSessionCookie(res) {
  res.append('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

module.exports = { createSession, userFromRequest, deleteSession, setSessionCookie, clearSessionCookie };
