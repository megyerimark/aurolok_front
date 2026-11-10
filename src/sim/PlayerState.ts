import type { RoomId, Vec2 } from './facility/FacilityMap';

/** Player data the simulation cares about. The game layer writes pos/room each frame. */
export class PlayerState {
  pos: Vec2 = { x: 0, z: 0 };
  room: RoomId | undefined;
  hasKeycard = false;
  batteries = 0;
  /** Flashlight charge, 0..1. */
  charge = 1;
  flashlightOn = false;
  /** Camera yaw (radians). 0 = facing -Z. */
  yaw = 0;

  /** Seconds of light per full battery. Tuned so batteries matter during the outage. */
  static readonly DRAIN_SECONDS = 240;

  update(dt: number): void {
    if (!this.flashlightOn) return;
    this.charge = Math.max(0, this.charge - dt / PlayerState.DRAIN_SECONDS);
    if (this.charge === 0) this.flashlightOn = false;
  }

  /** Swaps in a fresh battery. Returns false if there are none. */
  reload(): boolean {
    if (this.batteries <= 0) return false;
    this.batteries--;
    this.charge = 1;
    return true;
  }
}
