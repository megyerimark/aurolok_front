// Smoke test: boots the built game in headless Chromium, fails on any console
// error, and captures screenshots from fixed viewpoints into test-output/.
// Usage: npm run build && npm run smoke
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const PORT = 4179;
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'pipe' });
await new Promise((res, rej) => {
  server.stdout.on('data', (d) => String(d).includes('Local') && res());
  server.on('exit', (code) => rej(new Error(`vite preview exited (${code})`)));
  setTimeout(() => rej(new Error('vite preview did not start')), 20000);
});
console.log('server up');

const errors = [];
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
page.setDefaultTimeout(90000);
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(`http://localhost:${PORT}/?seed=1234`);
await page.waitForFunction(() => window.__game, null, { timeout: 30000 });
mkdirSync('test-output', { recursive: true });
await page.screenshot({ path: 'test-output/00-title.png' });

await page.evaluate(() => window.__game.debugBegin());
const shots = JSON.parse(process.env.SHOTS ?? 'null') ?? [
  ['01-control', 20, 10, 0, -0.05],
  ['02-corridor', 2, 6, -Math.PI / 2, 0],
  ['03-lab', 12, 4, 0, 0],
  ['04-generator', 9, 8, Math.PI / 2 + 0.4, -0.1],
  ['05-storage', 4, 4, 0.3, 0],
  ['06-medical', 22, 4, 0.2, 0],
];
for (const [name, col, row, yaw, pitch] of shots) {
  await page.evaluate(([c, r, y, p]) => window.__game.debugPlace(c, r, y, p), [col, row, yaw, pitch]);
  await page.waitForTimeout(700);
  await page.screenshot({ path: `test-output/${name}.png` });
  console.log('shot', name);
}

// Radio: open and transmit a status request to everyone, check replies arrive.
await page.keyboard.press('KeyR');
await page.keyboard.press('Digit9');
await page.evaluate(() => window.__game.debugAdvance(4));
await page.waitForTimeout(1500);
await page.screenshot({ path: 'test-output/07-radio.png' });
await page.keyboard.press('KeyR');

// Power failure: emergency lighting + flashlight.
await page.evaluate(() => {
  const g = window.__game;
  g.sim.facility.tripGenerator('smoke test');
  g.sim.player.flashlightOn = true;
  g.debugPlace(26, 6, Math.PI / 2, 0);
  g.debugAdvance(2);
});
await page.waitForTimeout(2500);
await page.screenshot({ path: 'test-output/08-outage-corridor.png' });
await page.evaluate(() => window.__game.debugPlace(31, 6, -Math.PI / 2 + 0.3, -0.1));
await page.waitForTimeout(1200);
await page.screenshot({ path: 'test-output/09-restricted-door.png' });
const replies = await page.evaluate(() => window.__game.sim.radio.log.filter((m) => m.from !== 'player').length);

await browser.close();
server.kill();
console.log(`radio replies: ${replies}`);
if (errors.length) {
  console.error('Console errors:\n' + errors.join('\n'));
  process.exit(1);
}
if (replies < 3) {
  console.error('Expected radio replies from the team');
  process.exit(1);
}
console.log('SMOKE OK');
