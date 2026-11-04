'use strict';
// Synthesises the 30-second launch track for the film. No samples, no external sources.
// 120 BPM. Drums start on beat 0 of the first bar, pads and bass follow a four-chord loop,
// and impacts and risers land on the film's cut points.
//
//   node launch/music.js <out.wav>

const fs = require('fs');

const SR = 44100;
const DUR = 30;
const N = SR * DUR;
const buf = new Float32Array(N);
const BPM = 120;
const BEAT = 60 / BPM; // 0.5 s
const BAR = BEAT * 4; // 2 s
const DRUMS_FROM = 2.0;
const DRUMS_TO = 27.0;

let seed = 7;
const noise = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return (seed / 4294967296) * 2 - 1;
};

// Adds a sound starting at t0 (seconds). fn(t, i) returns the sample for time t since the start.
function add(t0, dur, fn) {
  const start = Math.round(t0 * SR);
  const len = Math.round(dur * SR);
  for (let i = 0; i < len; i++) {
    const idx = start + i;
    if (idx < 0 || idx >= N) continue;
    buf[idx] += fn(i / SR, i);
  }
}

function kick(t0) {
  add(t0, 0.5, (t) => {
    const f0 = 46;
    const f1 = 120;
    const k = 36;
    const phase = 2 * Math.PI * (f0 * t + (f1 * (1 - Math.exp(-k * t))) / k);
    return Math.sin(phase) * Math.exp(-t * 9) * 0.85;
  });
}

function snare(t0) {
  add(t0, 0.3, (t) => (noise() * Math.exp(-t * 28) * 0.28) + Math.sin(2 * Math.PI * 185 * t) * Math.exp(-t * 22) * 0.3);
}

function hat(t0) {
  add(t0, 0.08, (t) => noise() * Math.exp(-t * 85) * 0.07);
}

function bass(t0, freq, dur) {
  add(t0, dur, (t) => {
    let s = 0;
    for (let k = 1; k <= 6; k++) s += Math.sin(2 * Math.PI * freq * k * t) / k;
    const env = Math.min(1, t * 150) * Math.exp(-t * 2.6);
    return s * (2 / Math.PI) * env * 0.2;
  });
}

function pad(freqs, t0, dur, amp) {
  add(t0, dur, (t) => {
    let s = 0;
    for (const f of freqs) s += Math.sin(2 * Math.PI * f * t) + 0.3 * Math.sin(2 * Math.PI * f * 2.003 * t);
    const env = Math.min(1, t / 0.35) * Math.min(1, (dur - t) / 0.6);
    return (s / freqs.length) * env * amp;
  });
}

function pluck(freq, t0) {
  add(t0, 0.5, (t) => {
    const tri = (2 / Math.PI) * Math.asin(Math.sin(2 * Math.PI * freq * t));
    return tri * Math.exp(-t * 7) * 0.07;
  });
}

function impact(t0) {
  add(t0, 1.8, (t) => {
    const f = 30 + 50 * Math.exp(-t * 2);
    return Math.sin(2 * Math.PI * f * t) * Math.exp(-t * 2.1) * 0.85 + noise() * Math.exp(-t * 16) * 0.22;
  });
}

function riser(t0, dur) {
  let y = 0;
  add(t0, dur, (t, i) => {
    const p = t / dur;
    const alpha = 0.02 + 0.32 * p * p;
    y += alpha * (noise() - y);
    return y * Math.pow(p, 1.5) * 0.7;
  });
}

// Harmony: A minor, F, C, G (two bars each, eight-bar loop is four chords).
const CHORDS = [
  { root: 55, tones: [110, 130.81, 164.81] },
  { root: 43.65, tones: [87.31, 110, 130.81] },
  { root: 65.41, tones: [130.81, 164.81, 196] },
  { root: 49, tones: [98, 123.47, 146.83] },
];

// Pads for the whole film, one chord per bar.
for (let bar = 0; bar * BAR < DUR; bar++) {
  const c = CHORDS[bar % CHORDS.length];
  pad(c.tones, bar * BAR, BAR + 0.4, 0.085);
}

// Drums and bass from DRUMS_FROM to DRUMS_TO.
for (let t = DRUMS_FROM; t < DRUMS_TO - 0.01; t += BEAT) {
  const beatIndex = Math.round((t - DRUMS_FROM) / BEAT);
  kick(t);
  if (beatIndex % 4 === 1 || beatIndex % 4 === 3) snare(t);
  hat(t + BEAT / 2);
}
for (let bar = 0; DRUMS_FROM + bar * BAR < DRUMS_TO; bar++) {
  const c = CHORDS[bar % CHORDS.length];
  const bt = DRUMS_FROM + bar * BAR;
  for (let k = 0; k < 8; k++) {
    const f = k % 4 === 2 ? c.root * 2 : c.root;
    if (bt + k * BEAT / 2 < DRUMS_TO) bass(bt + k * BEAT / 2, f, BEAT / 2 * 0.95);
  }
}

// Arpeggio from bar 2 (t = 4.0) to the organisations scene.
for (let t = 4.0, j = 0; t < 23; t += BEAT / 2, j++) {
  const c = CHORDS[Math.floor((t - DRUMS_FROM) / BAR + 0.0001) % CHORDS.length];
  pluck(c.tones[j % 3] * 2, t);
}

// Impacts on the cuts, risers into the big moves.
[0, 2, 4, 8, 11, 14, 17, 20, 23, 27].forEach((t) => impact(t));
[3.0, 7.0, 13.0, 19.0, 26.0].forEach((t) => riser(t, 1.0));

// Master: fade in and out, soft clip, normalise.
let peak = 0;
for (let i = 0; i < N; i++) {
  const t = i / SR;
  const fadeIn = Math.min(1, t / 0.15);
  const fadeOut = Math.min(1, Math.max(0, (DUR - t) / 2.6));
  buf[i] = Math.tanh(buf[i] * 1.25) * fadeIn * fadeOut;
  peak = Math.max(peak, Math.abs(buf[i]));
}
const gain = 0.88 / peak;
for (let i = 0; i < N; i++) buf[i] *= gain;

function writeWav(file, samples) {
  const dataBytes = samples.length * 2;
  const out = Buffer.alloc(44 + dataBytes);
  out.write('RIFF', 0);
  out.writeUInt32LE(36 + dataBytes, 4);
  out.write('WAVE', 8);
  out.write('fmt ', 12);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20); // PCM
  out.writeUInt16LE(1, 22); // mono
  out.writeUInt32LE(SR, 24);
  out.writeUInt32LE(SR * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36);
  out.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i++) {
    out.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(samples[i] * 32767))), 44 + i * 2);
  }
  fs.writeFileSync(file, out);
}

const target = process.argv[2];
if (!target) throw new Error('usage: node launch/music.js <out.wav>');
writeWav(target, buf);
console.log('wrote', target, `${DUR}s, ${BPM} BPM, peak ${(0.88).toFixed(2)}`);
