import type { EventBus } from '../../core/EventBus';
import type { EventHistory } from '../../core/EventHistory';
import type { SimEvents } from '../SimEvents';
import { CELL, FacilityMap, ROOMS, type DoorDef, type RoomId, type Vec2 } from './FacilityMap';

export interface DoorState {
  def: DoorDef;
  open: boolean;
  /** Keycard doors start locked; a locked door cannot be opened at all. */
  locked: boolean;
}

export interface Noise {
  pos: Vec2;
  loudness: number; // 0..1, ~1 = a slammed metal door
  time: number;
  source: string;
}

/** Rooms that keep battery-backed emergency lighting during a power failure. */
const EMERGENCY_LIT: ReadonlySet<RoomId> = new Set(['corridor', 'control']);

/**
 * Mutable facility state: power, lighting, doors and recent noises.
 * Pure simulation: no rendering, no audio. Changes are published on the bus.
 */
export class FacilityState {
  readonly doors = new Map<string, DoorState>();
  readonly lightSwitch = new Map<RoomId, boolean>();
  readonly noises: Noise[] = [];
  generatorOnline = true;
  /** 0..1 progress of an in-flight generator repair. */
  repairProgress = 0;
  time = 0;

  constructor(
    readonly map: FacilityMap,
    private readonly bus: EventBus<SimEvents>,
    private readonly history: EventHistory,
  ) {
    for (const def of map.doors) this.doors.set(def.id, { def, open: false, locked: def.kind === 'keycard' });
    for (const r of ROOMS) this.lightSwitch.set(r.id, true);
  }

  /**
   * Effective light level of a room: 1 = normal lighting, ~0.3 = emergency
   * lighting, 0 = dark. NPC fear and THE LISTENER both read this.
   */
  lightLevel(room: RoomId | undefined): number {
    if (!room) return 0.3;
    if (!this.generatorOnline) return EMERGENCY_LIT.has(room) ? 0.3 : 0;
    return this.lightSwitch.get(room) ? 1 : 0;
  }

  lightMode(room: RoomId): 'on' | 'emergency' | 'off' {
    const l = this.lightLevel(room);
    return l >= 1 ? 'on' : l > 0 ? 'emergency' : 'off';
  }

  setLights(room: RoomId, on: boolean, by: string): void {
    if (this.lightSwitch.get(room) === on) return;
    this.lightSwitch.set(room, on);
    this.bus.emit('lightsChanged', { room });
    this.history.record({ time: this.time, category: 'facility', actor: by, text: `${label(by)} switched the ${roomName(room)} lights ${on ? 'on' : 'off'}.` });
  }

  /** Attempts to open/close a door. Returns false if the door refused. */
  setDoor(doorId: string, open: boolean, by: string, hasKeycard = false): boolean {
    const d = this.doors.get(doorId);
    if (!d) return false;
    if (open && d.locked) {
      if (d.def.kind === 'keycard' && hasKeycard) {
        d.locked = false;
        this.history.record({ time: this.time, category: 'facility', actor: by, text: `${label(by)} unlocked the restricted sector with a keycard.`, danger: 0.4, tags: ['restricted'] });
      } else {
        this.bus.emit('doorDenied', { doorId, by, reason: d.def.kind === 'keycard' ? 'keycard' : 'locked' });
        return false;
      }
    }
    if (d.open === open) return true;
    d.open = open;
    this.bus.emit('doorChanged', { doorId, open, by });
    this.makeNoise(doorCenter(d.def), 0.45, `door:${by}`);
    return true;
  }

  isDoorOpen(doorId: string): boolean {
    return this.doors.get(doorId)?.open ?? false;
  }

  tripGenerator(reason: string): void {
    if (!this.generatorOnline) return;
    this.generatorOnline = false;
    this.repairProgress = 0;
    for (const r of ROOMS) this.bus.emit('lightsChanged', { room: r.id });
    this.bus.emit('powerChanged', { online: false, reason });
    this.makeNoise(this.map.roomCenter('generator'), 1, 'generator');
    this.history.record({ time: this.time, category: 'facility', actor: 'facility', text: `Power failure: ${reason}`, danger: 0.5, tags: ['power'] });
  }

  /** Adds repair work. Returns true on the tick the generator comes back. */
  addRepair(amount: number, by: string): boolean {
    if (this.generatorOnline) return false;
    this.repairProgress = Math.min(1, this.repairProgress + amount);
    if (this.repairProgress < 1) return false;
    this.generatorOnline = true;
    for (const r of ROOMS) this.bus.emit('lightsChanged', { room: r.id });
    this.bus.emit('powerChanged', { online: true, reason: `restored by ${label(by)}` });
    this.history.record({ time: this.time, category: 'facility', actor: by, text: `${label(by)} restored facility power.`, tags: ['power'] });
    return true;
  }

  makeNoise(pos: Vec2, loudness: number, source: string): void {
    const n: Noise = { pos: { ...pos }, loudness, time: this.time, source };
    this.noises.push(n);
    if (this.noises.length > 40) this.noises.shift();
    this.bus.emit('noise', n);
  }

  /** Most recent noise not made by `excludeSource`, within `maxAge` seconds. */
  recentNoise(maxAge: number, exclude?: (n: Noise) => boolean): Noise | undefined {
    for (let i = this.noises.length - 1; i >= 0; i--) {
      const n = this.noises[i];
      if (this.time - n.time > maxAge) return undefined;
      if (!exclude?.(n)) return n;
    }
    return undefined;
  }

  update(dt: number): void {
    this.time += dt;
  }
}

export function doorCenter(def: DoorDef): Vec2 {
  return { x: (def.cell.col + 0.5) * CELL, z: (def.cell.row + 0.5) * CELL };
}

export function roomName(room: RoomId): string {
  return ROOMS.find((r) => r.id === room)!.name;
}

function label(actor: string): string {
  return actor === 'player' ? 'You' : actor.charAt(0).toUpperCase() + actor.slice(1);
}
