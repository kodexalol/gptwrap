'use strict';

const crypto = require('crypto');

const now = () => new Date().toISOString();
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const byNewest = (a, b) => b.createdAt.localeCompare(a.createdAt);

function isHttpsUrl(value) {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

// "#hiring #Pilots" -> ["hiring", "pilots"]
function extractTags(text) {
  const tags = new Set();
  for (const match of String(text).matchAll(/#([A-Za-z0-9_]{2,30})/g)) tags.add(match[1].toLowerCase());
  return [...tags];
}

// Fixed-window rate limiter kept in memory. Good enough for one instance.
const buckets = new Map();
function rateLimit(key, limit, windowMs) {
  const t = Date.now();
  const entry = buckets.get(key);
  if (!entry || entry.resetAt < t) {
    buckets.set(key, { count: 1, resetAt: t + windowMs });
    return true;
  }
  if (entry.count >= limit) return false;
  entry.count += 1;
  return true;
}
setInterval(() => {
  const t = Date.now();
  for (const [key, entry] of buckets) if (entry.resetAt < t) buckets.delete(key);
}, 60 * 1000).unref();

module.exports = { now, sha256, randomToken, escapeHtml, byNewest, isHttpsUrl, extractTags, rateLimit };
