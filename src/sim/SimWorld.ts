import { EventBus } from '../core/EventBus';
import { EventHistory } from '../core/EventHistory';
import { Rng } from '../core/Rng';
import { CELL, cellToWorld, FacilityMap, type RoomId } from './facility/FacilityMap';
import { FacilityState } from './facility/FacilityState';
import { PointsOfInterest } from './facility/PointsOfInterest';
import { command, type CommandId } from './npc/Commands';
import { DialogueSelector } from './npc/Dialogue';
import { NpcAgent, type NpcWorld } from './npc/NpcAgent';
import { PERSONALITIES } from './npc/Personality';
import { PlayerState } from './PlayerState';
import { RadioSystem } from './radio/RadioSystem';
import type { SimEvents } from './SimEvents';
import { StoryDirector } from './story/StoryDirector';
import { Listener } from './entity/Listener';

export interface SimOptions {
  seed?: number;
  /** Disable the scripted story beats (tests, sandbox). */
  story?: boolean;
  /** Disable random facility noises (tests). */
  ambientNoise?: boolean;
  /** Disable THE LISTENER's scares (tests). Dread is still tracked. */
  listener?: boolean;
}

const DOOR_AUTO_CLOSE = 7;

/**
 * The whole simulation, renderer-free. The game layer feeds it the player's
 * position and input and reads everything else back. Tests drive it directly.
 */
export class SimWorld implements NpcWorld {
  readonly bus = new EventBus<SimEvents>();
  readonly history = new EventHistory();
  readonly rng: Rng;
  readonly map = new FacilityMap();
  readonly poi = new PointsOfInterest(this.map);
  readonly facility: FacilityState;
  readonly radio: RadioSystem;
  readonly dialogue: DialogueSelector;
  readonly npcs: NpcAgent[];
  readonly player = new PlayerState();
  readonly story: StoryDirector;
  readonly listener: Listener;
  readonly seed: number;
  time = 0;

  private readonly storyEnabled: boolean;
  private readonly ambientEnabled: boolean;
  private nextAmbient: number;
  private doorOpenSince = new Map<string, number>();
  private wasInRestricted = false;

  constructor(opts: SimOptions = {}) {
    this.seed = opts.seed ?? (Date.now() & 0xffffffff);
    this.rng = new Rng(this.seed);
    this.facility = new FacilityState(this.map, this.bus, this.history);
    this.radio = new RadioSystem(this.bus, this.rng);
    this.dialogue = new DialogueSelector(this.rng);
    this.player.pos = { ...this.poi.playerStart };
    this.player.room = 'control';
    this.npcs = PERSONALITIES.map((p) => new NpcAgent(p, this, this.startPosFor(p.startRoom)));
    this.story = new StoryDirector(this);
    this.listener = new Listener(this, opts.listener ?? true);
    this.storyEnabled = opts.story ?? true;
    this.ambientEnabled = opts.ambientNoise ?? true;
    this.nextAmbient = this.rng.range(20, 35);
    this.bus.on('doorChanged', (e) => {
      if (e.open) this.doorOpenSince.set(e.doorId, this.time);
      else this.doorOpenSince.delete(e.doorId);
    });
    if (this.storyEnabled) this.story.start();
  }

  npc(id: string): NpcAgent {
    const n = this.npcs.find((a) => a.id === id);
    if (!n) throw new Error(`Unknown NPC ${id}`);
    return n;
  }

  /** The player keys the radio. `to` is an npc id or 'all'. */
  transmit(to: string, cmdId: CommandId): void {
    const cmd = command(cmdId);
    const signal = this.radio.signalFor(this.player.room);
    this.radio.post({ from: 'player', to, original: cmd.phrase, text: cmd.phrase, status: 'sent', authentic: true, signal });
    const targets = to === 'all' ? this.npcs : [this.npc(to)];
    this.history.record({
      time: this.time,
      category: 'command',
      actor: 'player',
      text: `You told ${to === 'all' ? 'everyone' : this.npc(to).name}: "${cmd.phrase}"`,
      tags: [cmdId],
    });
    for (const npc of targets) {
      if (!npc.alive) continue;
      this.radio.later(this.radio.latency(), () => npc.receive(cmdId, Math.min(signal, npc.signal())));
    }
    if (this.storyEnabled) this.story.onTransmit(cmdId === 'status');
  }

  /**
   * An instruction given in person. No radio: perfect clarity, and nobody can
   * fake it. Only works within earshot.
   */
  speak(npcId: string, cmdId: CommandId): boolean {
    const npc = this.npc(npcId);
    if (!npc.alive || Math.hypot(npc.pos.x - this.player.pos.x, npc.pos.z - this.player.pos.z) > 3.5) return false;
    const cmd = command(cmdId);
    this.history.record({ time: this.time, category: 'command', actor: 'player', text: `You told ${npc.name} in person: "${cmd.phrase}"`, tags: [cmdId, 'in_person'] });
    npc.receive(cmdId, 1);
    return true;
  }

  /** A transmission nobody on the team sent. The first trace of THE LISTENER. */
  unknownTransmission(text: string, signal: number): void {
    this.radio.post({ from: 'unknown', to: 'all', original: text, status: 'unknown', authentic: false, signal });
    this.bus.emit('radioStatic', { intensity: 0.9, duration: 2.2 });
    this.history.record({ time: this.time, category: 'entity', actor: 'listener', text: `An unidentified voice came over the radio: "${text}"`, danger: 0.55, tags: ['unknown'] });
  }

  /** Player works the generator panel by hand (slower than a technician). */
  playerRepair(dt: number): boolean {
    return this.facility.addRepair(0.06 * dt, 'player');
  }

  update(dt: number): void {
    this.time += dt;
    this.facility.update(dt);
    this.radio.update(dt);
    this.player.update(dt);
    for (const n of this.npcs) n.update(dt);
    this.listener.update(dt);
    this.autoCloseDoors();
    if (this.ambientEnabled) this.ambient();
    if (this.storyEnabled) {
      this.story.update(dt);
      const inRestricted = this.player.room === 'restricted';
      if (inRestricted && !this.wasInRestricted) this.story.onEnterRestricted();
      this.wasInRestricted = inRestricted;
    }
  }

  private autoCloseDoors(): void {
    for (const [id, since] of this.doorOpenSince) {
      if (this.time - since < DOOR_AUTO_CLOSE) continue;
      const cell = this.facility.doors.get(id)!.def.cell;
      const occupied = [this.player.pos, ...this.npcs.map((n) => n.pos)].some((p) => nearDoor(p, cell));
      if (occupied) continue;
      this.facility.setDoor(id, false, 'facility');
    }
  }

  /** The facility is never quiet: pipes knock, metal settles. These are real sim noises NPCs react to. */
  private ambient(): void {
    if (this.time < this.nextAmbient) return;
    this.nextAmbient = this.time + this.rng.range(25, 55);
    const rooms: RoomId[] = ['storage', 'lab', 'generator', 'medical', 'corridor', 'restricted'];
    const room = this.rng.pick(rooms);
    const cells = this.map.cellsOfRoom(room).filter((c) => !this.map.isBlocked(c.col, c.row));
    const pos = cellToWorld(this.rng.pick(cells));
    this.facility.makeNoise(pos, this.rng.range(0.45, 0.85), this.rng.pick(['facility:pipes', 'facility:metal', 'facility:vent']));
  }

  private startPosFor(room: RoomId) {
    return this.map.standSpot(room);
  }
}

function nearDoor(p: { x: number; z: number }, cell: { col: number; row: number }): boolean {
  const cx = (cell.col + 0.5) * CELL;
  const cz = (cell.row + 0.5) * CELL;
  return Math.hypot(p.x - cx, p.z - cz) < 1.6;
}
