import * as THREE from 'three';
import type { ScareEvent } from '../sim/entity/Listener';
import type { SimWorld } from '../sim/SimWorld';
import type { Hud } from '../ui/Hud';
import type { AudioManager } from './AudioManager';
import { MonsterView } from './MonsterView';
import type { PlayerController } from './PlayerController';

type Active =
  | { kind: 'apparition'; t: number; until: number; lit: number }
  | { kind: 'whisper'; t: number; until: number }
  | { kind: 'lunge'; t: number };

/**
 * Turns THE LISTENER's scare events into what the player sees and hears.
 * The simulation decides *when* and *what*; this decides *how*, and reacts
 * to the player: walk up to the figure and it comes for you; turn around fast
 * enough after the whisper and it is there.
 */
export class ScareController {
  readonly monster = new MonsterView();
  /** 0..1 camera shake, decays. */
  shake = 0;
  /** Seconds of flashlight failure left. */
  flashlightFail = 0;
  /** Set by the controller; Game feeds it into the renderer. */
  interferencePulse = 0;
  private active: Active | null = null;
  private fwd = new THREE.Vector3();

  constructor(
    scene: THREE.Scene,
    private readonly sim: SimWorld,
    private readonly player: PlayerController,
    private readonly audio: AudioManager,
    private readonly hud: Hud,
  ) {
    scene.add(this.monster.root);
    sim.bus.on('scare', (e) => this.onScare(e));
  }

  private onScare(e: ScareEvent): void {
    const a = this.audio;
    switch (e.kind) {
      case 'footsteps':
        a.play('scare.footsteps', { pos: e.pos, y: 0.2, gain: 1.4 });
        break;
      case 'whisper':
        if (this.active) return;
        a.play('scare.whisper', { pos: e.pos, y: 1.7, gain: 1.6, duration: 2.6 });
        this.place(e.pos!);
        this.monster.root.visible = false; // only there if you turn around
        this.active = { kind: 'whisper', t: 0, until: 3 };
        break;
      case 'apparition':
        if (this.active) return;
        this.place(e.pos!);
        a.play('scare.presence', { pos: e.pos, y: 2 });
        this.active = { kind: 'apparition', t: 0, until: e.duration, lit: 0 };
        break;
      case 'lunge':
        this.lunge();
        break;
      case 'blackout':
        a.play('scare.lights_burst', { pos: e.pos, y: 3, gain: 1.3 });
        this.flashlightFail = 1.4;
        this.interferencePulse = 0.7;
        this.shake = Math.max(this.shake, 0.3);
        break;
      case 'door_slam':
        a.play('sfx.impact_metal', { pos: e.pos, y: 1.2, gain: 1.6 });
        this.shake = Math.max(this.shake, 0.35);
        break;
      case 'false_voice':
      case 'false_order':
        this.interferencePulse = 0.45;
        break;
    }
  }

  private place(pos: { x: number; z: number }): void {
    const cam = this.player.camera.position;
    this.monster.place(pos.x, pos.z, cam.x, cam.z);
    this.monster.lunging = false;
  }

  /** It is right in front of you. */
  private lunge(): void {
    this.active = { kind: 'lunge', t: 0 };
    this.audio.play('scare.stinger', { gain: 1.3 });
    this.audio.play('scare.scream', { gain: 1.1, duration: 1.1 });
    this.hud.flash('#ffffff', 60, 0.85);
    this.shake = 1;
    this.flashlightFail = 0.9;
    this.interferencePulse = 1;
    this.monster.lunging = true;
    this.sim.listener.dread = Math.min(1, this.sim.listener.dread + 0.25);
  }

  update(dt: number, flashlightOn: boolean): void {
    this.shake = Math.max(0, this.shake - dt * 1.4);
    this.flashlightFail = Math.max(0, this.flashlightFail - dt);
    this.interferencePulse = Math.max(0, this.interferencePulse - dt * 0.8);
    this.monster.update();
    const act = this.active;
    if (!act) return;
    act.t += dt;
    const cam = this.player.camera;
    this.player.camera.getWorldDirection(this.fwd);
    const m = this.monster.root.position;
    const toM = new THREE.Vector3(m.x - cam.position.x, 0, m.z - cam.position.z);
    const d = toM.length();
    const facing = toM.normalize().dot(new THREE.Vector3(this.fwd.x, 0, this.fwd.z).normalize());

    switch (act.kind) {
      case 'whisper':
        if (facing > 0.6 && act.t > 0.25) {
          // You turned around. It was there.
          this.monster.root.visible = true;
          this.lunge();
        } else if (act.t > act.until) this.end();
        break;
      case 'apparition': {
        // It flickers out of existence for single frames.
        this.monster.root.visible = Math.random() > 0.04;
        if (d < 3.2) {
          this.lunge();
          break;
        }
        if (flashlightOn && facing > 0.92) act.lit += dt;
        if (act.lit > 1.3 || act.t > act.until) {
          // Held in the light too long, it is simply gone.
          this.interferencePulse = 0.8;
          this.audio.play('radio.static', { intensity: 0.8, duration: 0.5 });
          this.end();
        }
        break;
      }
      case 'lunge': {
        // Pin it to the camera, rushing in for ~0.9 s.
        // The face rushes from ~1.2 m to ~0.4 m in front of the eyes.
        const k = Math.min(1, act.t / 0.18);
        const scale = 1.05 + k * 0.1;
        const faceDist = 1.2 - k * 0.8;
        const flat = new THREE.Vector3(this.fwd.x, 0, this.fwd.z).normalize();
        const p = cam.position.clone().addScaledVector(flat, faceDist + MonsterView.HEAD_FORWARD * scale);
        this.monster.place(p.x, p.z, cam.position.x, cam.position.z);
        this.monster.root.position.y = cam.position.y - MonsterView.HEAD_HEIGHT * scale + 0.06;
        this.monster.root.scale.setScalar(scale);
        this.monster.lunging = true;
        if (act.t > 0.9) {
          this.hud.flash('#000000', 260, 1);
          this.end();
        }
        break;
      }
    }
  }

  private end(): void {
    this.active = null;
    this.monster.hide();
    this.monster.root.position.y = 0;
  }

  /** Debug/capture: trigger a scare right now. */
  force(kind: ScareEvent['kind']): void {
    this.sim.listener.fire([kind]);
  }
}
