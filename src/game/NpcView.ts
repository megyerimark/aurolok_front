import * as THREE from 'three';
import type { NpcAgent } from '../sim/npc/NpcAgent';

/**
 * Visual stand-in for an employee: a proportioned, articulated figure built
 * from primitives (no character models are available yet). Limbs swing with
 * movement speed; posture changes with state (crouched when hiding, hunched
 * when afraid). Swap `build()` for a rigged model later; `sync()` stays.
 */
export class NpcView {
  readonly root = new THREE.Group();
  private hips = new THREE.Group();
  private torso = new THREE.Group();
  private legs: THREE.Group[] = [];
  private arms: THREE.Group[] = [];
  private head: THREE.Mesh;
  private phase = Math.random() * 10;
  private torch: THREE.SpotLight;

  constructor(readonly agent: NpcAgent) {
    const color = new THREE.Color(agent.p.color);
    const uniform = new THREE.MeshStandardMaterial({ color: agent.id === 'daniel' ? 0x23262c : agent.id === 'emily' ? 0xc9ccc8 : agent.id === 'robert' ? 0x3d4636 : 0x30363c, roughness: 0.85 });
    const trim = new THREE.MeshStandardMaterial({ color, roughness: 0.6, emissive: color, emissiveIntensity: 0.05 });
    const skin = new THREE.MeshStandardMaterial({ color: 0xb08a72, roughness: 0.7 });
    const trousers = new THREE.MeshStandardMaterial({ color: 0x1e2024, roughness: 0.9 });
    const boots = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.6 });

    const limb = (len: number, r: number, mat: THREE.Material) => {
      const g = new THREE.Group();
      const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, len - r * 2, 4, 10), mat);
      m.position.y = -len / 2;
      m.castShadow = true;
      g.add(m);
      return g;
    };

    this.hips.position.y = 0.95;
    this.root.add(this.hips);
    for (const side of [-1, 1]) {
      const leg = limb(0.9, 0.088, trousers);
      leg.position.set(side * 0.1, 0, 0);
      const boot = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.08, 0.26), boots);
      boot.position.set(0, -0.9, 0.05);
      boot.castShadow = true;
      leg.add(boot);
      this.hips.add(leg);
      this.legs.push(leg);
    }
    const pelvis = new THREE.Mesh(new THREE.CapsuleGeometry(0.15, 0.06, 4, 10), trousers);
    pelvis.rotation.z = Math.PI / 2;
    pelvis.scale.set(1, 1, 0.75);
    pelvis.position.y = 0.02;
    pelvis.castShadow = true;
    this.hips.add(pelvis);
    this.hips.add(this.torso);
    const chest = new THREE.Mesh(new THREE.CapsuleGeometry(0.17, 0.34, 4, 12), uniform);
    chest.scale.set(1.05, 1, 0.7);
    chest.position.y = 0.3;
    chest.castShadow = true;
    this.torso.add(chest);
    const band = new THREE.Mesh(new THREE.CylinderGeometry(0.185, 0.185, 0.06, 16), trim);
    band.scale.set(1.05, 1, 0.72);
    band.position.y = 0.42;
    this.torso.add(band);
    const radio = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.12, 0.04), new THREE.MeshStandardMaterial({ color: 0x111111 }));
    radio.position.set(0.14, 0.52, 0.11);
    this.torso.add(radio);
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.055, 0.1, 10), skin);
    neck.position.y = 0.66;
    this.torso.add(neck);
    this.head = new THREE.Mesh(new THREE.SphereGeometry(0.11, 18, 14), skin);
    this.head.scale.set(0.9, 1.1, 1);
    this.head.position.y = 0.8;
    this.head.castShadow = true;
    this.torso.add(this.head);
    const hair = new THREE.Mesh(new THREE.SphereGeometry(0.115, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x2a2018, roughness: 0.9 }));
    hair.position.y = 0.015;
    this.head.add(hair);
    for (const side of [-1, 1]) {
      const arm = limb(0.62, 0.055, uniform);
      arm.position.set(side * 0.23, 0.6, 0);
      this.torso.add(arm);
      this.arms.push(arm);
    }
    // Each employee carries a torch; it comes on when it is dark around them.
    this.torch = new THREE.SpotLight(0xfff2dd, 0, 9, 0.5, 0.6, 1.8);
    this.torch.position.set(0.15, 0.45, 0.2);
    this.torch.target.position.set(0.15, -0.2, 3);
    this.torso.add(this.torch, this.torch.target);
  }

  sync(dt: number, darkness: number): void {
    const a = this.agent;
    this.root.position.set(a.pos.x, 0, a.pos.z);
    this.root.rotation.y = a.heading;
    const dead = a.state === 'Dead';
    this.root.visible = !dead;
    if (dead) return;

    const speed = a.speed;
    this.phase += dt * (speed > 0.1 ? 2.2 + speed * 1.7 : 0);
    const swing = Math.min(0.7, speed * 0.32);
    this.legs[0].rotation.x = Math.sin(this.phase) * swing;
    this.legs[1].rotation.x = -Math.sin(this.phase) * swing;
    this.arms[0].rotation.x = -Math.sin(this.phase) * swing * 0.8;
    this.arms[1].rotation.x = Math.sin(this.phase) * swing * 0.8;

    // Posture: hiding = crouched; fear = hunched, head down; breathing idle.
    const hiding = a.state === 'Hiding';
    const crouch = hiding ? 0.45 : 0;
    this.hips.position.y += (0.95 - crouch - this.hips.position.y) * Math.min(1, dt * 5);
    for (const leg of this.legs) leg.rotation.x += hiding ? -1.1 : 0;
    const hunch = Math.min(0.5, a.fear * 0.45) + (hiding ? 0.4 : 0) + (a.state === 'PerformingTask' ? 0.35 : 0);
    this.torso.rotation.x += (hunch - this.torso.rotation.x) * Math.min(1, dt * 4);
    const breathe = Math.sin(performance.now() * 0.002 * (1 + a.fear * 2)) * 0.008;
    this.torso.position.y = breathe;
    if (a.state === 'PerformingTask') {
      this.arms[0].rotation.x = -1.1 + Math.sin(this.phase + performance.now() * 0.006) * 0.15;
      this.arms[1].rotation.x = -1.0;
    }
    if (a.state === 'Investigating' || a.state === 'Suspicious') this.head.rotation.y = Math.sin(performance.now() * 0.0012) * 0.6;
    else this.head.rotation.y *= 0.9;

    const torchOn = darkness > 0.6 && !hiding;
    this.torch.intensity += ((torchOn ? 9 : 0) - this.torch.intensity) * Math.min(1, dt * 6);
  }
}
