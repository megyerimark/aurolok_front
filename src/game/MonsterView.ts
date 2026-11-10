import * as THREE from 'three';
import { timers } from '../core/Timers';

/**
 * THE LISTENER's body. Built from primitives (no creature model exists yet):
 * a too-tall, too-thin figure in the remains of a lab coat, arms reaching past
 * its knees, head tilted at a wrong angle. The face is a perforated surface,
 * like a microphone grille, with a mouth hole. It listens; it does not look.
 *
 * Motion is never smooth: it holds still, then twitches.
 */
export class MonsterView {
  /** Head position relative to the root (torso pitched forward 0.28 rad). */
  static readonly HEAD_HEIGHT = 1.3 + Math.cos(0.28) * 1.1 - Math.sin(0.28) * 0.12;
  static readonly HEAD_FORWARD = Math.sin(0.28) * 1.1 + Math.cos(0.28) * 0.12;
  readonly root = new THREE.Group();
  private head: THREE.Group;
  private arms: THREE.Group[] = [];
  private body: THREE.Group;
  private twitchUntil = 0;
  private twitchTarget = new THREE.Euler();
  /** Face glow, used for the jumpscare. */
  private mouthLight: THREE.PointLight;

  constructor() {
    const skin = new THREE.MeshStandardMaterial({ color: 0x9a978c, roughness: 0.65, metalness: 0 });
    const coat = new THREE.MeshStandardMaterial({ color: 0x4a4740, roughness: 0.95, side: THREE.DoubleSide });
    const dark = new THREE.MeshStandardMaterial({ color: 0x050403, roughness: 1 });

    const capsule = (r: number, len: number, mat: THREE.Material) => {
      const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, len, 4, 10), mat);
      m.castShadow = true;
      return m;
    };

    this.body = new THREE.Group();
    this.root.add(this.body);

    // Legs: long, thin, slightly bent backwards.
    for (const side of [-1, 1]) {
      const leg = new THREE.Group();
      leg.position.set(side * 0.11, 1.25, 0);
      const thigh = capsule(0.06, 0.6, skin);
      thigh.position.y = -0.35;
      const shin = capsule(0.045, 0.6, skin);
      shin.position.set(0, -0.98, -0.08);
      shin.rotation.x = 0.12;
      leg.add(thigh, shin);
      leg.rotation.x = -0.05;
      this.body.add(leg);
    }

    // Torso: narrow, ribbed, hunched forward.
    const torso = new THREE.Group();
    torso.position.y = 1.3;
    torso.rotation.x = 0.28;
    this.body.add(torso);
    const chest = capsule(0.15, 0.6, skin);
    chest.scale.set(1, 1, 0.6);
    chest.position.y = 0.42;
    torso.add(chest);
    for (let i = 0; i < 5; i++) {
      const rib = new THREE.Mesh(new THREE.TorusGeometry(0.15, 0.012, 6, 16, Math.PI), skin);
      rib.position.set(0, 0.3 + i * 0.075, 0.02);
      rib.rotation.set(Math.PI / 2, 0, 0);
      rib.scale.set(1, 0.6, 1);
      torso.add(rib);
    }
    // Torn lab coat: two flat, ragged panels hanging off the shoulders.
    for (const side of [-1, 1]) {
      const g = new THREE.PlaneGeometry(0.32, 1.1, 4, 8);
      const pos = g.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < pos.count; i++) {
        const y = pos.getY(i);
        if (y < -0.3) pos.setY(i, y - Math.abs(Math.sin(i * 2.7)) * 0.25); // ragged hem
        pos.setZ(i, Math.sin(i * 1.3) * 0.02);
      }
      g.computeVertexNormals();
      const panel = new THREE.Mesh(g, coat);
      panel.position.set(side * 0.1, 0.25, -0.1);
      panel.rotation.y = side * 0.5;
      panel.castShadow = true;
      torso.add(panel);
    }

    // Arms: far too long, hanging to the knees, fingers like wires.
    for (const side of [-1, 1]) {
      const arm = new THREE.Group();
      arm.position.set(side * 0.2, 0.72, 0);
      const upper = capsule(0.04, 0.55, skin);
      upper.position.y = -0.3;
      const fore = capsule(0.035, 0.6, skin);
      fore.position.set(0, -0.92, 0.06);
      arm.add(upper, fore);
      for (let f = 0; f < 4; f++) {
        const finger = capsule(0.008, 0.26, skin);
        finger.position.set((f - 1.5) * 0.02, -1.38, 0.08);
        finger.rotation.x = 0.15 + f * 0.04;
        arm.add(finger);
      }
      arm.rotation.z = side * 0.06;
      torso.add(arm);
      this.arms.push(arm);
    }

    // Neck too long; head tilted ninety degrees.
    const neck = capsule(0.035, 0.28, skin);
    neck.position.set(0, 0.92, 0.05);
    neck.rotation.x = 0.4;
    torso.add(neck);
    this.head = new THREE.Group();
    this.head.position.set(0, 1.1, 0.12);
    this.head.rotation.z = 1.35;
    torso.add(this.head);
    const skull = new THREE.Mesh(new THREE.SphereGeometry(0.13, 24, 18), new THREE.MeshStandardMaterial({ map: grilleTexture(), color: 0xb8b4a8, roughness: 0.7 }));
    skull.scale.set(0.95, 1.25, 0.85);
    skull.rotation.y = -Math.PI / 2; // perforated side of the texture faces forward
    skull.castShadow = true;
    this.head.add(skull);
    const mouth = new THREE.Mesh(new THREE.SphereGeometry(0.05, 12, 8), dark);
    mouth.scale.set(0.7, 1.6, 0.4);
    mouth.position.set(0, -0.07, 0.115);
    this.head.add(mouth);

    this.mouthLight = new THREE.PointLight(0xdfe6ff, 0, 1.5, 2);
    this.mouthLight.position.set(0, 0, 0.4);
    this.head.add(this.mouthLight);

    this.root.visible = false;
  }

  /** Places the figure on the floor at (x,z), facing a point. */
  place(x: number, z: number, faceX: number, faceZ: number): void {
    this.root.position.set(x, 0, z);
    this.root.rotation.set(0, Math.atan2(faceX - x, faceZ - z), 0);
    this.root.scale.setScalar(1);
    this.root.visible = true;
  }

  hide(): void {
    this.root.visible = false;
    this.mouthLight.intensity = 0;
  }

  get visible(): boolean {
    return this.root.visible;
  }

  /** Jumpscare pose: arms raised toward the camera, mouth lit. */
  set lunging(on: boolean) {
    for (const [i, arm] of this.arms.entries()) arm.rotation.x = on ? -1.3 - i * 0.2 : 0;
    this.mouthLight.intensity = on ? 0.7 : 0;
  }

  update(): void {
    if (!this.root.visible) return;
    const now = timers.now();
    // Still, then a sudden twitch to a new pose.
    if (now > this.twitchUntil) {
      this.twitchUntil = now + 250 + Math.random() * 1400;
      this.twitchTarget.set((Math.random() - 0.5) * 0.4, (Math.random() - 0.5) * 0.7, 1.35 + (Math.random() - 0.5) * 0.6);
    }
    this.head.rotation.x += (this.twitchTarget.x - this.head.rotation.x) * 0.5;
    this.head.rotation.y += (this.twitchTarget.y - this.head.rotation.y) * 0.5;
    this.head.rotation.z += (this.twitchTarget.z - this.head.rotation.z) * 0.5;
    this.body.position.x = Math.random() < 0.05 ? (Math.random() - 0.5) * 0.04 : this.body.position.x * 0.8;
    // Slow breathing that is a little too deep.
    this.body.scale.y = 1 + Math.sin(now * 0.0021) * 0.012;
  }
}

/** Pale skin perforated with dark holes, like a microphone grille. */
function grilleTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#c9c4b6';
  ctx.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 2600; i++) {
    ctx.fillStyle = `rgba(90,80,70,${Math.random() * 0.15})`;
    ctx.fillRect(Math.random() * 256, Math.random() * 256, 2, 2);
  }
  // Front half (u 0.25..0.75): perforations, denser toward the middle.
  for (let y = 40; y < 216; y += 9) {
    for (let x = 70; x < 186; x += 9) {
      const off = (y / 9) % 2 ? 4.5 : 0;
      const d = Math.hypot(x + off - 128, y - 128) / 90;
      if (Math.random() > 1.05 - d) continue;
      ctx.fillStyle = '#0a0806';
      ctx.beginPath();
      ctx.arc(x + off, y, 2.6 * (1.2 - d * 0.5), 0, Math.PI * 2);
      ctx.fill();
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
