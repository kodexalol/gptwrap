'use strict';

const crypto = require('crypto');

const now = () => new Date().toISOString();
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const byNewest = (a, b) => b.createdAt.localeCompare(a.createdAt);

// "#hiring #Pilots" -> ["hiring", "pilots"]
function extractTags(text) {
  const tags = new Set();
  for (const match of String(text).matchAll(/#([A-Za-z0-9_]{2,30})/g)) tags.add(match[1].toLowerCase());
  return [...tags];
}

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const VIMEO_ID = /^\d{5,12}$/;

// Accepts one media link and classifies it.
//  - image:  https link ending in .png/.jpg/.jpeg/.gif/.webp
//  - video:  https link to a .mp4/.webm file, or a YouTube or Vimeo video
// Anything else is rejected. We never host media, so only these forms are allowed.
function parseMedia(raw) {
  const value = String(raw || '').trim();
  if (!value) return { media: null };
  if (value.length > 500) return { error: 'Media link must be 500 characters or fewer' };

  let url;
  try {
    url = new URL(value);
  } catch {
    return { error: 'Media must be a valid https:// link' };
  }
  if (url.protocol !== 'https:') return { error: 'Media links must start with https://' };

  const host = url.hostname.toLowerCase().replace(/^www\./, '').replace(/^m\./, '');
  const path = url.pathname;

  if (/\.(mp4|webm)$/i.test(path)) {
    return { media: { type: 'video', video: { kind: 'file', src: url.href } } };
  }
  if (/\.(png|jpe?g|gif|webp)$/i.test(path)) {
    return { media: { type: 'image', imageUrl: url.href } };
  }
  if (host === 'youtube.com') {
    const parts = path.split('/').filter(Boolean);
    const id = url.searchParams.get('v') || (['shorts', 'embed'].includes(parts[0]) ? parts[1] : null);
    if (id && YOUTUBE_ID.test(id)) return { media: { type: 'video', video: { kind: 'youtube', id } } };
  }
  if (host === 'youtu.be') {
    const id = path.split('/').filter(Boolean)[0];
    if (id && YOUTUBE_ID.test(id)) return { media: { type: 'video', video: { kind: 'youtube', id } } };
  }
  if (host === 'vimeo.com') {
    const id = path.split('/').filter(Boolean)[0];
    if (id && VIMEO_ID.test(id)) return { media: { type: 'video', video: { kind: 'vimeo', id } } };
  }
  return { error: 'Use an image (.png, .jpg, .gif, .webp), a video (.mp4, .webm), or a YouTube or Vimeo link' };
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

module.exports = { now, sha256, randomToken, escapeHtml, byNewest, extractTags, parseMedia, rateLimit };
