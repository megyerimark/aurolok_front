// Renders a scripted gameplay video offline, frame by frame at a fixed time
// step (so it is smooth even on a machine that renders at 2 fps), then
// encodes it with ffmpeg. Audio is not captured (WebAudio synth only).
//
// Usage: npm run build && node scripts/capture-video.mjs [out.mp4]
// Env: FPS (default 24), W/H (default 1280x720), MAX_SECONDS (truncate, for previews)
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const OUT = resolve(process.argv[2] ?? 'test-output/the-last-instruction.mp4');
const FPS = Number(process.env.FPS ?? 24);
const W = Number(process.env.W ?? 1280);
const H = Number(process.env.H ?? 720);
const MAX = Number(process.env.MAX_SECONDS ?? Infinity);
const FRAMES = resolve(process.env.FRAMES_DIR ?? 'test-output/frames');
const DT = 1 / FPS;

rmSync(FRAMES, { recursive: true, force: true });
mkdirSync(FRAMES, { recursive: true });

const PORT = 4183;
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'pipe' });
await new Promise((res, rej) => {
  server.stdout.on('data', (d) => String(d).includes('Local') && res());
  setTimeout(() => rej(new Error('vite preview did not start')), 20000);
});

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: W, height: H } });
page.setDefaultTimeout(180000);
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(`http://localhost:${PORT}/?seed=${process.env.SEED ?? 20261110}`);
await page.waitForFunction(() => window.__game, null, { timeout: 30000 });

// In-page director: smooth walking/turning toward targets.
await page.evaluate(() => {
  const g = window.__game;
  const P = g.player;
  const angDiff = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
  window.__dir = {
    /** One frame of walking to (x,z). Returns true when arrived. */
    walk(dt, x, z, speedKeys = []) {
      const p = P.camera.position;
      const dx = x - p.x;
      const dz = z - p.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.25) {
        g.debugFrame(dt, []);
        return true;
      }
      const want = Math.atan2(-dx, -dz);
      const diff = angDiff(want, P.yaw);
      P.yaw += Math.sign(diff) * Math.min(Math.abs(diff), dt * 2.4);
      P.pitch += (-0.06 - P.pitch) * Math.min(1, dt * 3);
      g.debugFrame(dt, Math.abs(diff) < 0.6 ? ['KeyW', ...speedKeys] : []);
      return false;
    },
    /** One frame of turning toward a yaw/pitch (or a point). */
    look(dt, yaw, pitch = -0.05, rate = 1.6) {
      const diff = angDiff(yaw, P.yaw);
      P.yaw += Math.sign(diff) * Math.min(Math.abs(diff), dt * rate);
      P.pitch += (pitch - P.pitch) * Math.min(1, dt * 2.5);
      g.debugFrame(dt, []);
    },
    lookAtPoint(dt, x, z, pitch = -0.08, rate = 1.6) {
      const p = P.camera.position;
      this.look(dt, Math.atan2(-(x - p.x), -(z - p.z)), pitch, rate);
    },
  };
});

let frame = 0;
async function shot() {
  const file = join(FRAMES, `f${String(frame).padStart(5, '0')}.jpg`);
  await page.screenshot({ path: file, type: 'jpeg', quality: 90 });
  frame++;
  if (frame % 24 === 0) console.log(`frame ${frame} (${(frame / FPS).toFixed(1)}s)`);
  if (frame / FPS >= MAX) throw new Error('MAX');
}
/** Run `perFrame` (in page) for `seconds`, or until it returns true. */
async function seq(seconds, perFrame, arg) {
  const n = Math.round(seconds * FPS);
  for (let i = 0; i < n; i++) {
    const done = await page.evaluate(([src, dt, a, i]) => new Function('dt', 'a', 'i', `return (${src})(dt, a, i)`)(dt, a, i), [perFrame.toString(), DT, arg, i]);
    await shot();
    if (done === true) return;
  }
}
const key = (code) => page.evaluate((c) => window.__game.debugKey(c), code);

try {
  // ---- Title card (static)
  await page.evaluate(() => window.__game.debugFrame(1 / 24));
  await shot();
  for (let i = 1; i < 3 * FPS; i++) {
    copyFileSync(join(FRAMES, 'f00000.jpg'), join(FRAMES, `f${String(frame).padStart(5, '0')}.jpg`));
    frame++;
  }

  // ---- Central Control: look over the monitors, radio the team.
  await page.evaluate(() => window.__game.debugBegin());
  await seq(2.2, (dt, a, i) => window.__dir.look(dt, Math.sin(i * dt * 0.9) * 0.35, -0.08, 1));
  await key('KeyR');
  await seq(0.8, (dt) => window.__dir.look(dt, 0, -0.08));
  await key('Digit9'); // "Status report." to all stations
  await seq(6, (dt) => window.__dir.look(dt, 0.05, -0.06, 0.3));

  // ---- The power goes (story beat forced early to keep the video short).
  await page.evaluate(() => (window.__game.sim.story.phaseTime = 30));
  await seq(3.5, (dt) => window.__dir.look(dt, 0.25, 0.15, 0.4));
  await key('KeyF'); // flashlight
  // Channel 3 = Robert, instruction 4 = "Get the power back on."
  await key('KeyQ');
  await key('KeyQ');
  await key('KeyQ');
  await seq(0.6, (dt) => window.__dir.look(dt, 0.1, -0.1));
  await key('Digit4');
  await seq(3.5, (dt) => window.__dir.look(dt, 0, -0.1, 0.5));
  await key('KeyR');

  // ---- Out of the control room, into the dark corridor.
  await seq(6, (dt) => window.__dir.walk(dt, 47, 21));
  await seq(6, (dt) => window.__dir.walk(dt, 47, 17));
  await seq(6, (dt) => window.__dir.walk(dt, 41.2, 17));
  await seq(1, (dt) => window.__dir.look(dt, 0, -0.05, 2.5));
  await key('KeyE'); // open the door
  await seq(1.3, (dt) => window.__dir.look(dt, 0, -0.02));
  await seq(4, (dt) => window.__dir.walk(dt, 41, 13));
  await seq(1.2, (dt) => window.__dir.look(dt, Math.PI / 2, -0.05, 2));
  await seq(10, (dt) => window.__dir.walk(dt, 19.5, 13));

  // ---- Generator room: watch Robert work.
  await seq(3, (dt) => window.__dir.walk(dt, 17, 15.5));
  await seq(3, (dt) => window.__dir.walk(dt, 17.4, 17.3));
  const until = async (pred, max, look) => {
    for (let i = 0; i < max * FPS; i++) {
      await page.evaluate(look, DT);
      await shot();
      if (await page.evaluate(pred)) return;
    }
  };
  const watchRobert = (dt) => {
    const r = window.__game.sim.npc('robert');
    window.__dir.lookAtPoint(dt, r.pos.x, r.pos.z, -0.18, 1.2);
  };
  await page.evaluate(`window.__watch = ${watchRobert.toString()}`);
  await until(() => window.__game.sim.facility.generatorOnline, 28, (dt) => window.__watch(dt));
  await seq(3, (dt) => window.__watch(dt));

  // ---- Then something else comes over the radio.
  await key('KeyR');
  await until(() => window.__game.sim.radio.log.some((m) => m.status === 'unknown'), 12, (dt) => window.__dir.look(dt, Math.PI * 0.75, -0.05, 0.25));
  await seq(5, (dt) => window.__dir.look(dt, Math.PI * 0.8, -0.04, 0.15));
} catch (e) {
  if (e.message !== 'MAX') throw e;
}

await browser.close();
server.kill();
if (errors.length) console.error('Page errors:\n' + errors.join('\n'));

const seconds = frame / FPS;
execFileSync('ffmpeg', [
  '-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', join(FRAMES, 'f%05d.jpg'),
  '-vf', `fade=t=in:st=0:d=1,fade=t=out:st=${Math.max(0, seconds - 1.5)}:d=1.5,format=yuv420p`,
  '-c:v', 'libx264', '-crf', '20', '-preset', 'medium', '-movflags', '+faststart', OUT,
]);
console.log(`wrote ${OUT} (${seconds.toFixed(1)}s, ${frame} frames)`);
