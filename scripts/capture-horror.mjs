// Renders a scripted horror sequence (THE LISTENER) WITH SOUND.
// Video: frame by frame at a fixed time step. Audio: the same cues scheduled
// on the game clock into an OfflineAudioContext, rendered to WAV, then muxed.
// Usage: npm run build && node scripts/capture-horror.mjs [out.mp4]
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, copyFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const OUT = resolve(process.argv[2] ?? 'test-output/the-last-instruction-horror.mp4');
const FPS = 24;
const DT = 1 / FPS;
const W = 1280;
const H = 720;
const FRAMES = resolve('test-output/frames-horror');
const AUDIO_SECONDS = 110;
const TITLE_FRAMES = 3 * FPS;

rmSync(FRAMES, { recursive: true, force: true });
mkdirSync(FRAMES, { recursive: true });

const PORT = 4187;
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'pipe' });
await new Promise((res, rej) => {
  server.stdout.on('data', (d) => String(d).includes('Local') && res());
  server.on('exit', (c) => rej(new Error(`vite preview exited ${c}`)));
  setTimeout(() => rej(new Error('vite preview did not start')), 20000);
});

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: W, height: H } });
page.setDefaultTimeout(1800000);
page.on('pageerror', (e) => console.error('PAGE ERROR', String(e)));
await page.goto(`http://localhost:${PORT}/?seed=4242`);
await page.waitForFunction(() => window.__game, null, { timeout: 60000 });

await page.evaluate((secs) => {
  const g = window.__game;
  const P = g.player;
  const off = new OfflineAudioContext(2, 44100 * secs, 44100);
  const am = new window.__audio.AudioManager(off);
  am.now = () => g.time; // schedule every cue on the game clock
  window.__off = off;
  g.debugUseAudio(am);
  const angDiff = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
  window.__dir = {
    walk(dt, x, z, slow) {
      const p = P.camera.position;
      const dx = x - p.x;
      const dz = z - p.z;
      if (Math.hypot(dx, dz) < 0.25) {
        g.debugFrame(dt, []);
        return true;
      }
      const want = Math.atan2(-dx, -dz);
      const diff = angDiff(want, P.yaw);
      P.yaw += Math.sign(diff) * Math.min(Math.abs(diff), dt * 2.4);
      P.pitch += (-0.05 - P.pitch) * Math.min(1, dt * 3);
      g.debugFrame(dt, Math.abs(diff) < 0.6 ? (slow ? ['KeyW', 'KeyC'] : ['KeyW']) : []);
      return false;
    },
    look(dt, yaw, pitch = -0.05, rate = 1.6) {
      const diff = angDiff(yaw, P.yaw);
      P.yaw += Math.sign(diff) * Math.min(Math.abs(diff), dt * rate);
      P.pitch += (pitch - P.pitch) * Math.min(1, dt * 2.5);
      g.debugFrame(dt, []);
    },
    /** Fire a specific scare now and keep the director from firing its own. */
    scare(kind) {
      g.sim.listener.dread = Math.max(g.sim.listener.dread, 0.7);
      const ev = g.sim.listener.fire([kind]);
      g.sim.listener.nextAllowed = 1e9;
      return ev;
    },
  };
  g.sim.listener.nextAllowed = 1e9; // this video is choreographed
}, AUDIO_SECONDS);

let frame = 0;
async function shot() {
  await page.screenshot({ path: join(FRAMES, `f${String(frame).padStart(5, '0')}.jpg`), type: 'jpeg', quality: 90 });
  frame++;
  if (frame % 48 === 0) console.log(`frame ${frame} (${(frame / FPS).toFixed(1)}s)`);
}
async function seq(seconds, fn, arg) {
  const n = Math.round(seconds * FPS);
  for (let i = 0; i < n; i++) {
    const done = await page.evaluate(([src, dt, a, i]) => new Function('dt', 'a', 'i', `return (${src})(dt, a, i)`)(dt, a, i), [fn.toString(), DT, arg, i]);
    await shot();
    if (done === true) return;
  }
}
const key = (code) => page.evaluate((c) => window.__game.debugKey(c), code);
const scare = (kind) => page.evaluate((k) => window.__dir.scare(k)?.kind ?? null, kind);

// ---- Title
await page.evaluate(() => window.__game.debugFrame(1 / 24));
await shot();
for (let i = 1; i < TITLE_FRAMES; i++) {
  copyFileSync(join(FRAMES, 'f00000.jpg'), join(FRAMES, `f${String(frame).padStart(5, '0')}.jpg`));
  frame++;
}
const audioOffset = (TITLE_FRAMES - 1) / FPS; // game clock 0 = this point in the video

// ---- Control room. Check in.
await page.evaluate(() => window.__game.debugBegin());
await seq(2, (dt, a, i) => window.__dir.look(dt, Math.sin(i * dt * 0.9) * 0.3, -0.08, 1));
await key('KeyR');
await seq(0.6, (dt) => window.__dir.look(dt, 0, -0.08));
await key('Digit9');
await seq(5, (dt) => window.__dir.look(dt, 0.05, -0.06, 0.3));
await key('KeyR');

// ---- The power dies. Silence.
await page.evaluate(() => (window.__game.sim.story.phaseTime = 30));
await seq(4, (dt) => window.__dir.look(dt, 0.2, 0.2, 0.35));
await key('KeyF');
await key('KeyR');
await key('KeyQ');
await key('KeyQ');
await key('KeyQ');
await seq(0.5, (dt) => window.__dir.look(dt, 0.1, -0.1));
await key('Digit4');
await seq(2.5, (dt) => window.__dir.look(dt, 0, -0.1, 0.5));
await key('KeyR');

// ---- Something walks past, out of sight.
console.log('scare:', await scare('footsteps'));
await seq(4, (dt) => window.__dir.look(dt, -1.2, -0.02, 0.9));

// ---- Out into the corridor.
await seq(5, (dt) => window.__dir.walk(dt, 47, 21));
await seq(5, (dt) => window.__dir.walk(dt, 47, 17));
await seq(5, (dt) => window.__dir.walk(dt, 41.2, 17));
await seq(0.8, (dt) => window.__dir.look(dt, 0, -0.05, 2.5));
await key('KeyE');
await seq(1.3, (dt) => window.__dir.look(dt, 0, -0.02));
await seq(4, (dt) => window.__dir.walk(dt, 41, 13));
await seq(1.4, (dt) => window.__dir.look(dt, Math.PI / 2, -0.04, 2));
await seq(1.5, (dt) => window.__dir.look(dt, Math.PI / 2, -0.04, 1));

// ---- A figure at the end of the light. Walk toward it...
console.log('scare:', await scare('apparition'));
await page.evaluate(() => {
  const s = window.__game.scares;
  if (s.active) Object.assign(s.active, { lit: -999, until: 999 }); // let it stand there for the shot
});
await seq(3.5, (dt) => window.__dir.look(dt, Math.PI / 2, -0.03, 0.2));
await seq(9, (dt) => {
  const m = window.__game.scares.monster.root.position;
  if (!window.__game.scares.active) {
    window.__dir.look(dt, Math.PI / 2, -0.03, 0.2);
    return true;
  }
  return window.__dir.walk(dt, m.x, m.z, true) && false;
});
await seq(3, (dt) => window.__dir.look(dt, Math.PI / 2, -0.02, 0.3));

// ---- A voice that is not who it says it is.
console.log('scare:', await scare('false_voice'));
await seq(4.5, (dt) => window.__dir.look(dt, Math.PI / 2 + 0.3, -0.02, 0.15));

// ---- Breathing, right behind you. Turn around.
console.log('scare:', await scare('whisper'));
await seq(1.2, (dt) => window.__dir.look(dt, Math.PI / 2 + 0.3, -0.02, 0.1));
await seq(2.5, (dt) => window.__dir.look(dt, -Math.PI / 2, -0.02, 4.5));
await seq(4, (dt) => window.__dir.look(dt, -Math.PI / 2, -0.02, 0.2));

// ---- Audio
const gameSeconds = (frame - TITLE_FRAMES + 1) / FPS;
console.log('rendering audio...');
const wav = await page.evaluate(() => window.__audio.renderWavBase64(window.__off));
const wavPath = join(FRAMES, 'audio.wav');
writeFileSync(wavPath, Buffer.from(wav, 'base64'));
await browser.close();
server.kill();

const seconds = frame / FPS;
execFileSync('ffmpeg', [
  '-y', '-loglevel', 'error',
  '-framerate', String(FPS), '-i', join(FRAMES, 'f%05d.jpg'),
  '-i', wavPath,
  '-filter_complex',
  `[0:v]fade=t=in:st=0:d=1,fade=t=out:st=${(seconds - 1.5).toFixed(2)}:d=1.5,format=yuv420p[v];` +
    `[1:a]atrim=0:${gameSeconds.toFixed(3)},adelay=${Math.round(audioOffset * 1000)}|${Math.round(audioOffset * 1000)},apad,` +
    `afade=t=out:st=${(seconds - 1.5).toFixed(2)}:d=1.5,alimiter=limit=0.95[a]`,
  '-map', '[v]', '-map', '[a]', '-t', seconds.toFixed(3),
  '-c:v', 'libx264', '-crf', '20', '-preset', 'medium', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', OUT,
]);
console.log(`wrote ${OUT} (${seconds.toFixed(1)}s)`);
