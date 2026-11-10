import * as THREE from 'three';

/**
 * Procedural surface textures generated at load time. These are deliberate
 * stand-ins for authored PBR texture sets (see docs/ARCHITECTURE.md, "Assets").
 * Each returns colour + a matching bump map so lights and the flashlight pick
 * out grime, seams and panel edges.
 */

type Painter = (ctx: CanvasRenderingContext2D, size: number, rnd: () => number) => void;

function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function canvas(size: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return [c, c.getContext('2d')!];
}

/** Value-noise speckle + blotches; the base of every surface. */
function grime(ctx: CanvasRenderingContext2D, size: number, rnd: () => number, base: [number, number, number], spread: number, blotches: number): void {
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    const n = (rnd() - 0.5) * spread;
    img.data[i * 4] = base[0] + n;
    img.data[i * 4 + 1] = base[1] + n;
    img.data[i * 4 + 2] = base[2] + n;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  for (let i = 0; i < blotches; i++) {
    const x = rnd() * size;
    const y = rnd() * size;
    const r = 8 + rnd() * size * 0.18;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    const dark = rnd() < 0.7;
    g.addColorStop(0, dark ? `rgba(20,16,12,${0.08 + rnd() * 0.14})` : `rgba(255,255,255,${0.03 + rnd() * 0.05})`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
}

function make(size: number, seed: number, paint: Painter, bumpFrom = true): { map: THREE.CanvasTexture; bump?: THREE.CanvasTexture } {
  const rnd = seeded(seed);
  const [c, ctx] = canvas(size);
  paint(ctx, size, rnd);
  const map = new THREE.CanvasTexture(c);
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.anisotropy = 8;
  if (!bumpFrom) return { map };
  const bump = new THREE.CanvasTexture(c);
  bump.wrapS = bump.wrapT = THREE.RepeatWrapping;
  return { map, bump };
}

/** Painted concrete block wall with a darker lower band and vertical streaks. */
export function concreteWall() {
  return make(512, 11, (ctx, s, rnd) => {
    grime(ctx, s, rnd, [118, 120, 116], 26, 40);
    // lower painted band (industrial two-tone)
    ctx.fillStyle = 'rgba(40,52,50,0.55)';
    ctx.fillRect(0, s * 0.68, s, s * 0.32);
    ctx.fillStyle = 'rgba(15,15,15,0.5)';
    ctx.fillRect(0, s * 0.68, s, 3);
    // block seams
    ctx.strokeStyle = 'rgba(30,30,30,0.35)';
    ctx.lineWidth = 2;
    for (let y = 0; y < s; y += s / 8) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(s, y);
      ctx.stroke();
      const off = (y / (s / 8)) % 2 ? s / 4 : 0;
      for (let x = off; x < s; x += s / 2) {
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x, y + s / 8);
        ctx.stroke();
      }
    }
    // water streaks
    for (let i = 0; i < 14; i++) {
      const x = rnd() * s;
      const g = ctx.createLinearGradient(0, 0, 0, s * (0.3 + rnd() * 0.6));
      g.addColorStop(0, 'rgba(25,20,15,0.25)');
      g.addColorStop(1, 'rgba(25,20,15,0)');
      ctx.fillStyle = g;
      ctx.fillRect(x, 0, 2 + rnd() * 5, s);
    }
  });
}

/** Worn vinyl/epoxy floor tiles. */
export function floorTiles() {
  return make(512, 23, (ctx, s, rnd) => {
    grime(ctx, s, rnd, [70, 72, 70], 20, 50);
    ctx.strokeStyle = 'rgba(10,10,10,0.6)';
    ctx.lineWidth = 3;
    for (let i = 0; i <= 4; i++) {
      ctx.beginPath();
      ctx.moveTo((i * s) / 4, 0);
      ctx.lineTo((i * s) / 4, s);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, (i * s) / 4);
      ctx.lineTo(s, (i * s) / 4);
      ctx.stroke();
    }
    // scuffs
    ctx.strokeStyle = 'rgba(20,18,15,0.25)';
    for (let i = 0; i < 60; i++) {
      ctx.lineWidth = 1 + rnd() * 2;
      const x = rnd() * s;
      const y = rnd() * s;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + (rnd() - 0.5) * 60, y + (rnd() - 0.5) * 20);
      ctx.stroke();
    }
  });
}

/** Suspended ceiling panels. */
export function ceilingPanels() {
  return make(256, 31, (ctx, s, rnd) => {
    grime(ctx, s, rnd, [92, 92, 88], 14, 12);
    ctx.strokeStyle = 'rgba(20,20,20,0.7)';
    ctx.lineWidth = 4;
    ctx.strokeRect(0, 0, s, s);
    ctx.beginPath();
    ctx.moveTo(s / 2, 0);
    ctx.lineTo(s / 2, s);
    ctx.stroke();
  });
}

/** Brushed, slightly rusted steel for doors, machinery and shelves. */
export function brushedMetal(seed = 41, tint: [number, number, number] = [96, 100, 104]) {
  return make(256, seed, (ctx, s, rnd) => {
    grime(ctx, s, rnd, tint, 12, 18);
    for (let y = 0; y < s; y++) {
      ctx.fillStyle = `rgba(255,255,255,${rnd() * 0.04})`;
      ctx.fillRect(0, y, s, 1);
    }
    for (let i = 0; i < 6; i++) {
      const x = rnd() * s;
      const y = rnd() * s;
      const g = ctx.createRadialGradient(x, y, 0, x, y, 10 + rnd() * 30);
      g.addColorStop(0, 'rgba(90,50,25,0.35)');
      g.addColorStop(1, 'rgba(90,50,25,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, s, s);
    }
  });
}

/** Sliding door: steel with hazard stripe and stencilled sector label. */
export function doorTexture(label: string, restricted: boolean) {
  return make(512, label.length * 7 + 3, (ctx, s, rnd) => {
    grime(ctx, s, rnd, restricted ? [92, 70, 62] : [84, 90, 92], 14, 20);
    ctx.strokeStyle = 'rgba(15,15,15,0.7)';
    ctx.lineWidth = 6;
    ctx.strokeRect(12, 12, s - 24, s - 24);
    // hazard band
    const y = s * 0.78;
    for (let x = -s; x < s * 2; x += 40) {
      ctx.fillStyle = 'rgba(200,160,40,0.75)';
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + 20, y);
      ctx.lineTo(x + 50, y + 40);
      ctx.lineTo(x + 30, y + 40);
      ctx.fill();
    }
    ctx.fillStyle = 'rgba(20,20,20,0.8)';
    ctx.fillRect(0, y - 2, s, 3);
    ctx.fillRect(0, y + 40, s, 3);
    ctx.fillStyle = restricted ? 'rgba(170,30,25,0.85)' : 'rgba(230,230,220,0.7)';
    ctx.font = 'bold 44px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(label.toUpperCase(), s / 2, s * 0.3);
    if (restricted) {
      ctx.font = 'bold 26px monospace';
      ctx.fillText('AUTHORISED PERSONNEL ONLY', s / 2, s * 0.4);
    }
  });
}

/** A text surface: whiteboards, notices, monitor screens. */
export function textPanel(lines: string[], opts: { bg: string; fg: string; font?: string; size?: number; glow?: boolean }) {
  const size = opts.size ?? 512;
  const [c, ctx] = canvas(size);
  ctx.fillStyle = opts.bg;
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = opts.fg;
  ctx.font = opts.font ?? '28px monospace';
  if (opts.glow) {
    ctx.shadowColor = opts.fg;
    ctx.shadowBlur = 8;
  }
  lines.forEach((l, i) => ctx.fillText(l, 24, 48 + i * 40));
  if (opts.glow) {
    // scanlines
    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    for (let y = 0; y < size; y += 4) ctx.fillRect(0, y, size, 2);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Soft round sprite for dust motes. */
export function dustSprite(): THREE.CanvasTexture {
  const [c, ctx] = canvas(64);
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,0.9)');
  g.addColorStop(0.4, 'rgba(255,255,255,0.25)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}
