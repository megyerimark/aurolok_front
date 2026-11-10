import * as THREE from 'three';
import { CELL, type FacilityMap } from '../sim/facility/FacilityMap';

const RADIUS = 0.32;
const EYE_STAND = 1.62;
const EYE_CROUCH = 1.0;
const WALK = 2.3;
const SPRINT = 4.3;
const CROUCH = 1.15;
const STAMINA_SECONDS = 6;

export interface MoveInput {
  forward: number; // -1..1
  right: number; // -1..1
  sprint: boolean;
  crouch: boolean;
}

/**
 * First-person movement against the facility grid. Walls, furniture cells and
 * closed doors are solid; collision is resolved per axis so the player slides
 * along walls instead of sticking.
 */
export class PlayerController {
  readonly camera: THREE.PerspectiveCamera;
  yaw = 0;
  pitch = 0;
  stamina = 1;
  /** Horizontal speed this frame (m/s). */
  speed = 0;
  crouched = false;
  /** Fires once per footstep with the step intensity (0..1). */
  onStep: (intensity: number) => void = () => {};

  private eye = EYE_STAND;
  private bobPhase = 0;
  private lastStepPhase = 0;
  private exhausted = false;

  constructor(
    private readonly map: FacilityMap,
    private readonly isDoorClosed: (col: number, row: number) => boolean,
    start: { x: number; z: number },
    aspect: number,
  ) {
    this.camera = new THREE.PerspectiveCamera(72, aspect, 0.05, 80);
    this.camera.position.set(start.x, EYE_STAND, start.z);
  }

  look(dx: number, dy: number, sensitivity = 0.0022): void {
    this.yaw -= dx * sensitivity;
    this.pitch = THREE.MathUtils.clamp(this.pitch - dy * sensitivity, -1.45, 1.45);
  }

  get position(): { x: number; z: number } {
    return { x: this.camera.position.x, z: this.camera.position.z };
  }

  update(dt: number, input: MoveInput): void {
    this.crouched = input.crouch;
    const len = Math.hypot(input.forward, input.right);
    const moving = len > 0.01;
    const canSprint = input.sprint && !input.crouch && !this.exhausted && input.forward > 0;
    const target = !moving ? 0 : input.crouch ? CROUCH : canSprint ? SPRINT : WALK;

    if (canSprint && moving) this.stamina = Math.max(0, this.stamina - dt / STAMINA_SECONDS);
    else this.stamina = Math.min(1, this.stamina + dt / (STAMINA_SECONDS * 1.6));
    if (this.stamina === 0) this.exhausted = true;
    if (this.exhausted && this.stamina > 0.35) this.exhausted = false;

    // Smooth acceleration: weight, not floatiness.
    this.speed += (target - this.speed) * Math.min(1, dt * (target > this.speed ? 7 : 10));

    if (moving) {
      const fx = input.forward / len;
      const rx = input.right / len;
      const sin = Math.sin(this.yaw);
      const cos = Math.cos(this.yaw);
      const dx = (-sin * fx + cos * rx) * this.speed * dt;
      const dz = (-cos * fx - sin * rx) * this.speed * dt;
      this.moveAxis(dx, 0);
      this.moveAxis(0, dz);
    }

    // Crouch height and head bob.
    const eyeTarget = input.crouch ? EYE_CROUCH : EYE_STAND;
    this.eye += (eyeTarget - this.eye) * Math.min(1, dt * 8);
    const bobAmount = this.speed / SPRINT;
    this.bobPhase += dt * (4.2 + this.speed * 1.6) * (this.speed > 0.2 ? 1 : 0);
    const bob = Math.sin(this.bobPhase * 2) * 0.045 * bobAmount;
    const sway = Math.cos(this.bobPhase) * 0.025 * bobAmount;
    this.camera.position.y = this.eye + bob;

    const stepIndex = Math.floor(this.bobPhase / Math.PI);
    if (stepIndex !== this.lastStepPhase && this.speed > 0.4) {
      this.lastStepPhase = stepIndex;
      this.onStep(Math.min(1, this.speed / SPRINT + (input.crouch ? -0.3 : 0.2)));
    }

    this.camera.rotation.set(this.pitch, this.yaw, sway * 0.4, 'YXZ');
  }

  private moveAxis(dx: number, dz: number): void {
    const p = this.camera.position;
    const nx = p.x + dx;
    const nz = p.z + dz;
    if (!this.collides(nx, nz)) {
      p.x = nx;
      p.z = nz;
    }
  }

  private collides(x: number, z: number): boolean {
    const minC = Math.floor((x - RADIUS) / CELL);
    const maxC = Math.floor((x + RADIUS) / CELL);
    const minR = Math.floor((z - RADIUS) / CELL);
    const maxR = Math.floor((z + RADIUS) / CELL);
    for (let r = minR; r <= maxR; r++) {
      for (let c = minC; c <= maxC; c++) {
        const solid = this.map.isSolid(c, r) || (this.map.isDoor(c, r) && this.isDoorClosed(c, r));
        if (!solid) continue;
        // circle vs cell AABB
        const cx = THREE.MathUtils.clamp(x, c * CELL, (c + 1) * CELL);
        const cz = THREE.MathUtils.clamp(z, r * CELL, (r + 1) * CELL);
        if ((x - cx) ** 2 + (z - cz) ** 2 < RADIUS * RADIUS) return true;
      }
    }
    return false;
  }
}
