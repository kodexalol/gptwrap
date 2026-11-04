'use strict';
// Renders launch/film.html frame by frame and encodes an MP4 with ffmpeg.
//
//   node launch/render.js <workDir> <out.mp4>          full film, 30 fps
//   node launch/render.js <workDir> --stills 2,12,30   a few PNG stills, for checking
//
// The film is driven by window.__seek(seconds), so every frame is exact, not timed by the clock.
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');

const FPS = 30;

(async () => {
  const [workDir, third] = process.argv.slice(2);
  if (!workDir) throw new Error('usage: node launch/render.js <workDir> <out.mp4> | --stills t1,t2');
  fs.mkdirSync(workDir, { recursive: true });

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  await page.goto('file://' + path.resolve(__dirname, 'film.html'));
  await page.evaluate(() => window.__ready);
  const duration = await page.evaluate(() => window.FILM_DURATION);

  if (third === '--stills') {
    const times = process.argv[4].split(',').map(Number);
    for (const t of times) {
      await page.evaluate((s) => window.__seek(s), t);
      await page.screenshot({ path: path.join(workDir, `still-${String(t).replace('.', '_')}s.png`) });
    }
    console.log('stills written to', workDir);
    await browser.close();
    return;
  }

  if (!third) throw new Error('give an output .mp4 path');
  const frameDir = path.join(workDir, 'frames');
  fs.rmSync(frameDir, { recursive: true, force: true });
  fs.mkdirSync(frameDir, { recursive: true });

  const total = Math.round(duration * FPS);
  const started = Date.now();
  for (let i = 0; i < total; i++) {
    await page.evaluate((s) => window.__seek(s), i / FPS);
    await page.screenshot({ path: path.join(frameDir, `${String(i).padStart(5, '0')}.jpg`), type: 'jpeg', quality: 93 });
    if (i % 150 === 0) console.log(`frame ${i}/${total} (${((Date.now() - started) / 1000).toFixed(0)}s)`);
  }
  await browser.close();

  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-framerate', String(FPS),
    '-i', path.join(frameDir, '%05d.jpg'),
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart', third,
  ], { stdio: 'inherit' });
  console.log('wrote', third);
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
