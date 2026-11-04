'use strict';
// Synthesises the score and sound design for the 30-second launch film. No samples.
// 120 BPM, C major (C – G – Am – F). Stereo, with a small reverb and a kick-driven sidechain pump.
//
// The sound effects are cued to what happens on screen. The cue times below match film.html:
//   0 hook · 3 reveal · 5 feed · 8 jobs · 11 chat · 14 links · 17 trust · 20 confirm · 23 phones · 26 close
//
//   node launch/music.js <out.wav>

const fs = require('fs');

const SR = 44100;
const DUR = 30;
const N = SR * DUR;
const BEAT = 0.5;
const BAR = 2;
const GROOVE_FROM = 3.0;
const GROOVE_TO = 26.0;

const mkBus = () => ({ L: new Float32Array(N), R: new Float32Array(N) });
const music = mkBus();
const fx = mkBus();
const verb = new Float32Array(N); // reverb send

let seed = 11;
const noise = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return (seed / 4294967296) * 2 - 1;
};
const rand = (a, b) => a + ((noise() + 1) / 2) * (b - a);

// Add a sound at t0. pan -1..1. send is the amount sent to the reverb.
function put(bus, t0, dur, fn, pan = 0, send = 0) {
  const gl = Math.cos(((pan + 1) * Math.PI) / 4);
  const gr = Math.sin(((pan + 1) * Math.PI) / 4);
  const start = Math.round(t0 * SR);
  const len = Math.round(dur * SR);
  for (let i = 0; i < len; i++) {
    const idx = start + i;
    if (idx < 0 || idx >= N) continue;
    const v = fn(i / SR, i);
    bus.L[idx] += v * gl;
    bus.R[idx] += v * gr;
    if (send) verb[idx] += v * send;
  }
}

// ---------- drums ----------
const kickTimes = [];
function kick(t0) {
  kickTimes.push(t0);
  put(music, t0, 0.5, (t) => {
    const phase = 2 * Math.PI * (46 * t + (130 * (1 - Math.exp(-34 * t))) / 34);
    return Math.sin(phase) * Math.exp(-t * 8.5) * 0.9;
  });
}
const clap = (t0) => put(music, t0, 0.3, (t) => noise() * Math.exp(-t * 26) * 0.3 * (t < 0.012 ? 0.5 : 1) + Math.sin(2 * Math.PI * 210 * t) * Math.exp(-t * 24) * 0.12, 0.05, 0.1);
const hat = (t0, open = false) => put(music, t0, open ? 0.25 : 0.08, (t) => noise() * Math.exp(-t * (open ? 18 : 90)) * (open ? 0.06 : 0.07), 0.25);

// ---------- tonal ----------
const CHORDS = [
  { root: 65.41, tones: [130.81, 164.81, 196.0] }, // C
  { root: 49.0, tones: [98.0, 123.47, 146.83] }, // G
  { root: 55.0, tones: [110.0, 130.81, 164.81] }, // Am
  { root: 43.65, tones: [87.31, 110.0, 130.81] }, // F
];
const chordAt = (t) => CHORDS[Math.floor(Math.max(0, t - GROOVE_FROM) / BAR) % 4];

function pad(freqs, t0, dur, amp) {
  freqs.forEach((f, k) => {
    put(music, t0, dur, (t) => {
      const env = Math.min(1, t / 0.5) * Math.min(1, (dur - t) / 0.7);
      const s = Math.sin(2 * Math.PI * f * t) + 0.35 * Math.sin(2 * Math.PI * f * 2.004 * t) + 0.12 * Math.sin(2 * Math.PI * f * 3.01 * t);
      return s * env * amp;
    }, (k - 1) * 0.5, 0.35);
  });
}

function bass(t0, freq, dur) {
  put(music, t0, dur, (t) => {
    let s = 0;
    for (let k = 1; k <= 5; k++) s += Math.sin(2 * Math.PI * freq * k * t) / (k * k * 0.6);
    return s * Math.min(1, t * 120) * Math.exp(-t * 2.2) * 0.3;
  });
}

function pluck(freq, t0, pan) {
  put(music, t0, 0.7, (t) => {
    const tri = (2 / Math.PI) * Math.asin(Math.sin(2 * Math.PI * freq * t));
    return (tri * 0.7 + Math.sin(2 * Math.PI * freq * 2 * t) * 0.3) * Math.exp(-t * 6.5) * 0.085;
  }, pan, 0.5);
}

function bell(t0, freq, amp = 0.12, decay = 3.2) {
  put(fx, t0, 2.0, (t) => (Math.sin(2 * Math.PI * freq * t) + 0.5 * Math.sin(2 * Math.PI * freq * 2.01 * t) + 0.22 * Math.sin(2 * Math.PI * freq * 3.99 * t)) * Math.exp(-t * decay) * amp, 0, 0.6);
}

// ---------- sound design ----------
const tick = (t0) => { const f = rand(1900, 2700); put(fx, t0, 0.025, (t) => (Math.sin(2 * Math.PI * f * t) * 0.6 + noise() * 0.4) * Math.exp(-t * 700) * 0.14, rand(-0.15, 0.15)); };
const click = (t0) => put(fx, t0, 0.06, (t) => (Math.sin(2 * Math.PI * 1500 * t) * 0.5 + noise() * 0.5) * Math.exp(-t * 130) * 0.32);
const thud = (t0, amp = 0.6) => put(fx, t0, 0.7, (t) => Math.sin(2 * Math.PI * (38 + 25 * Math.exp(-t * 20)) * t) * Math.exp(-t * 6) * amp);

function whoosh(t0, dur, amp = 0.28, up = true) {
  let y = 0;
  put(fx, t0, dur, (t) => {
    const p = t / dur;
    const q = up ? p : 1 - p;
    y += (0.03 + 0.45 * q * q) * (noise() - y);
    return y * Math.sin(Math.PI * p) * amp * 2.2;
  }, 0, 0.15);
}

function pop(t0) {
  let ph = 0;
  put(fx, t0, 0.25, (t) => {
    ph += (2 * Math.PI * (320 + 800 * (1 - Math.exp(-t * 45)))) / SR;
    return Math.sin(ph) * Math.exp(-t * 16) * 0.35;
  }, 0.1, 0.2);
  bell(t0 + 0.03, 2093, 0.05, 6);
}

function riser(t0, dur) {
  let y = 0;
  put(fx, t0, dur, (t) => {
    const p = t / dur;
    y += (0.02 + 0.32 * p * p) * (noise() - y);
    return y * Math.pow(p, 1.4) * 0.8;
  }, 0, 0.2);
}

function impact(t0, amp = 0.9) {
  put(fx, t0, 2.0, (t) => Math.sin(2 * Math.PI * (30 + 55 * Math.exp(-t * 2.2)) * t) * Math.exp(-t * 2.0) * amp + noise() * Math.exp(-t * 15) * 0.2, 0, 0.3);
}

// ---------- the score ----------
// Pads under everything, with the chord following the groove bars.
for (let t = 0; t < DUR; t += BAR) {
  const c = chordAt(Math.max(t, GROOVE_FROM));
  const lead = t < GROOVE_FROM ? CHORDS[0] : chordAt(t);
  pad(lead.tones, t, BAR + 0.5, t < GROOVE_FROM ? 0.07 : 0.085);
  void c;
}

// Groove
for (let t = GROOVE_FROM, i = 0; t < GROOVE_TO - 0.01; t += BEAT, i++) {
  kick(t);
  if (i % 4 === 1 || i % 4 === 3) clap(t);
  hat(t + BEAT / 2, i % 8 === 7);
}
for (let t = GROOVE_FROM; t < GROOVE_TO - 0.01; t += BAR) {
  const c = chordAt(t);
  for (let k = 0; k < 8; k++) {
    const when = t + k * 0.25;
    if (when >= GROOVE_TO) break;
    const f = k % 4 === 2 ? c.root * 2 : c.root;
    bass(when, f, 0.22);
  }
}
// Pluck arpeggio, eighth notes from the first feature scene to the end of the groove
for (let t = 5.0, j = 0; t < 26.5; t += 0.25, j++) {
  const c = chordAt(t);
  pluck(c.tones[[0, 1, 2, 1][j % 4]] * 2, t, ((j % 4) - 1.5) * 0.35);
}

// Hook: heartbeat thuds on each line, a riser into the reveal, then the drop
[0.0, 1.0, 2.0].forEach((t) => thud(t, 0.5));
riser(2.0, 1.0);
impact(3.0);
[130.81 * 2, 164.81 * 2, 196 * 2, 261.63 * 2].forEach((f, k) => bell(3.0 + k * 0.02, f, 0.12, 2.4));
[3.05, 3.55, 4.05].forEach((t, k) => bell(t, 1567.98, 0.045 - k * 0.01, 5));

// Cuts: a short whoosh into each cut and a soft thud on it
[5, 8, 11, 14, 17, 20, 23].forEach((t) => { whoosh(t - 0.3, 0.3, 0.22); thud(t, 0.35); });

// Feed
for (let k = 0; k < 30; k++) tick(5.35 + k * 0.04);
click(6.75);
whoosh(6.9, 0.35, 0.2);
pop(7.55);

// Jobs
for (let k = 0; k < 10; k++) tick(8.3 + k * 0.05);
for (let k = 0; k < 22; k++) tick(8.92 + k * 0.027);
click(9.5);
whoosh(9.62, 0.3, 0.2);
bell(10.0, 1318.5, 0.14); bell(10.09, 1975.5, 0.12);

// Chat
click(11.15); bell(11.25, 1760, 0.05, 5);
whoosh(11.45, 0.25, 0.18);
click(12.35);
whoosh(13.05, 0.25, 0.18);

// Links
click(15.22);
whoosh(15.3, 0.4, 0.2);
click(16.1);
bell(16.35, 1046.5, 0.14); bell(16.43, 1318.5, 0.12);

// Trust: four rising bells, one for each badge, each with a burst of air
[[17.3, 523.25], [17.6, 659.25], [17.9, 783.99], [18.2, 1046.5]].forEach(([t, f]) => { bell(t, f, 0.16, 2.6); whoosh(t - 0.12, 0.2, 0.12); });

// Confirm: code typing, press, then the bright chord on the badge
for (let k = 0; k < 9; k++) tick(20.4 + k * 0.09);
click(21.38);
[523.25, 659.25, 783.99, 1046.5].forEach((f, k) => bell(21.55 + k * 0.025, f, 0.15, 2.0));
pop(21.65);
pop(21.95);

// Phones
whoosh(23.1, 0.5, 0.26); whoosh(23.35, 0.5, 0.26);
thud(23.8, 0.4); thud(24.05, 0.4);

// Close
riser(25.2, 0.8);
impact(26.0, 1.0);
[130.81 * 2, 196 * 2, 261.63 * 2, 329.63 * 2].forEach((f, k) => bell(26.0 + k * 0.03, f, 0.14, 1.4));
bell(27.1, 1318.5, 0.09, 3);
bell(27.6, 1975.5, 0.08, 3);

// ---------- sidechain: music ducks on every kick ----------
const duck = new Float32Array(N).fill(1);
for (const kt of kickTimes) {
  const start = Math.round(kt * SR);
  for (let i = 0; i < Math.round(0.3 * SR); i++) {
    const idx = start + i;
    if (idx >= N) break;
    duck[idx] = Math.min(duck[idx], 1 - 0.42 * Math.exp(-(i / SR) * 11));
  }
}

// ---------- reverb (small Schroeder: four combs and two allpasses per side) ----------
function reverb(input, delays, g) {
  const out = new Float32Array(N);
  const combs = delays.map((d) => ({ buf: new Float32Array(d), pos: 0 }));
  for (let n = 0; n < N; n++) {
    let acc = 0;
    for (const c of combs) {
      const y = c.buf[c.pos];
      c.buf[c.pos] = input[n] + y * g;
      c.pos = (c.pos + 1) % c.buf.length;
      acc += y;
    }
    out[n] = acc * 0.25;
  }
  for (const d of [225, 556]) {
    const buf = new Float32Array(d);
    let pos = 0;
    for (let n = 0; n < N; n++) {
      const bufOut = buf[pos];
      const v = out[n] + bufOut * 0.5;
      buf[pos] = v;
      out[n] = bufOut - v * 0.5 + bufOut * 0.5;
      pos = (pos + 1) % d;
    }
  }
  return out;
}
const wetL = reverb(verb, [1557, 1617, 1491, 1422], 0.82);
const wetR = reverb(verb, [1580, 1640, 1510, 1440], 0.82);

// ---------- mix ----------
const L = new Float32Array(N);
const R = new Float32Array(N);
for (let i = 0; i < N; i++) {
  const t = i / SR;
  // Music: duck on kicks for the groove only. Pads, bass and plucks all sit in music.
  const d = t >= GROOVE_FROM && t < GROOVE_TO ? duck[i] : 1;
  const fadeIn = Math.min(1, t / 0.15);
  const fadeOut = Math.min(1, Math.max(0, (DUR - t) / 2.4));
  const musicGain = 0.62;
  L[i] = (music.L[i] * d * musicGain + fx.L[i] + wetL[i] * 0.55) * fadeIn * fadeOut;
  R[i] = (music.R[i] * d * musicGain + fx.R[i] + wetR[i] * 0.55) * fadeIn * fadeOut;
}
let peak = 0;
for (let i = 0; i < N; i++) {
  L[i] = Math.tanh(L[i] * 1.2);
  R[i] = Math.tanh(R[i] * 1.2);
  peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
}
const gain = 0.9 / peak;

function writeWav(file) {
  const dataBytes = N * 4;
  const out = Buffer.alloc(44 + dataBytes);
  out.write('RIFF', 0);
  out.writeUInt32LE(36 + dataBytes, 4);
  out.write('WAVEfmt ', 8);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(2, 22);
  out.writeUInt32LE(SR, 24);
  out.writeUInt32LE(SR * 4, 28);
  out.writeUInt16LE(4, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36);
  out.writeUInt32LE(dataBytes, 40);
  const clamp = (v) => Math.max(-32767, Math.min(32767, Math.round(v * 32767)));
  for (let i = 0; i < N; i++) {
    out.writeInt16LE(clamp(L[i] * gain), 44 + i * 4);
    out.writeInt16LE(clamp(R[i] * gain), 46 + i * 4);
  }
  fs.writeFileSync(file, out);
}

const target = process.argv[2];
if (!target) throw new Error('usage: node launch/music.js <out.wav>');
writeWav(target);
console.log('wrote', target, `${DUR}s stereo, 120 BPM`);
