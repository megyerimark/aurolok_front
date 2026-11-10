import { CELL, cellToWorld, dist, worldToCell, type Vec2 } from '../facility/FacilityMap';
import { doorCenter } from '../facility/FacilityState';
import { command, type CommandId } from '../npc/Commands';
import type { SimWorld } from '../SimWorld';

/**
 * THE LISTENER — the entity, and the scare director that decides when it shows itself.
 *
 * Scares are never on a timeline. The entity builds up *attention* from what the
 * player does: radio use, loud noises, NPC panic, power loss. The player's
 * *dread* rises with darkness and attention, and falls in the light. When a
 * cooldown has passed, every second carries a chance of a scare that scales
 * with dread. The scare type is then picked from the ones the current
 * situation allows, so it is unpredictable without being random:
 *
 *  - footsteps    heavy, uneven steps somewhere close, out of sight
 *  - whisper      a breath right behind you; turn around fast enough and it is there
 *  - apparition   a figure at the edge of the flashlight, down a corridor
 *  - lunge        it is suddenly in your face (needs darkness + high dread, rare)
 *  - blackout     the lights in your room blow out (they stay off until switched back on)
 *  - door_slam    an open door near you slams shut
 *  - false_voice  a teammate's voice says something they never said
 *  - false_order  your own voice repeats an earlier order to someone. They may obey.
 */
export type ScareKind = 'footsteps' | 'whisper' | 'apparition' | 'lunge' | 'blackout' | 'door_slam' | 'false_voice' | 'false_order';

export interface ScareEvent {
  kind: ScareKind;
  /** Where it happens (for positional sound / the figure). */
  pos?: Vec2;
  /** Seconds the presentation should keep it alive (figure visibility, sound length). */
  duration: number;
  /** 0..1: how hard the presentation should hit. */
  intensity: number;
}

const FALSE_VOICE_LINES = [
  'Control... I\'m right behind you.',
  'Open the door. It\'s me. Open the door.',
  'Why did you send me here? You said it was safe.',
  'Don\'t turn around.',
  'I can hear you breathing on the channel.',
  'Come to the storage room. Quickly. Alone.',
];

/** Scares allowed per story phase. Nothing before the team has checked in. */
const PHASE_KINDS: Record<string, ScareKind[]> = {
  checkin: [],
  calm: ['footsteps', 'door_slam', 'whisper'],
  outage: ['footsteps', 'whisper', 'apparition', 'lunge', 'blackout', 'door_slam', 'false_voice', 'false_order'],
  signal: ['footsteps', 'whisper', 'apparition', 'lunge', 'blackout', 'door_slam', 'false_voice', 'false_order'],
  ended: [],
};

export class Listener {
  /** 0..1 how frightened the player should be right now. Drives the dread soundscape. */
  dread = 0;
  /** 0..1 how much the entity is paying attention to the player. */
  attention = 0;
  readonly log: { time: number; kind: ScareKind }[] = [];

  private nextAllowed: number;
  private lastLunge = -999;
  private lastKind: ScareKind | null = null;
  /** Player's earlier orders, which the entity has "heard". */
  private heard: CommandId[] = [];

  constructor(private readonly w: SimWorld, private readonly enabled = true) {
    this.nextAllowed = 45;
    w.bus.on('radioMessage', (m) => {
      if (m.from === 'player' && m.authentic) {
        this.attention = Math.min(1, this.attention + 0.12);
        const cmd = (['follow', 'stay', 'goto_generator', 'repair_power', 'dont_open_door', 'lights_off', 'investigate_noise', 'return_control'] as CommandId[]).find(
          (c) => command(c).phrase === m.original,
        );
        if (cmd) this.heard.push(cmd);
      }
    });
    w.bus.on('noise', (n) => {
      if (n.loudness > 0.6 && !n.source.startsWith('listener')) this.attention = Math.min(1, this.attention + 0.05);
    });
    w.bus.on('npcStateChanged', (e) => {
      if (e.to === 'Panicking') this.attention = Math.min(1, this.attention + 0.15);
    });
    w.bus.on('powerChanged', (e) => {
      if (!e.online) {
        this.attention = Math.min(1, this.attention + 0.3);
        // The dark is its time: allow the first scare soon after the lights go.
        this.nextAllowed = Math.min(this.nextAllowed, w.time + 8);
      }
    });
  }

  update(dt: number): void {
    const w = this.w;
    const dark = 1 - w.facility.lightLevel(w.player.room);
    const lit = 1 - dark;
    this.attention = Math.max(0, this.attention - 0.008 * dt);
    this.dread = clamp01(this.dread + (dark * 0.016 + this.attention * 0.008 - lit * 0.01) * dt);
    if (!this.enabled || w.time < this.nextAllowed) return;

    const allowed = PHASE_KINDS[w.story.phase] ?? [];
    if (allowed.length === 0) return;
    // Hazard rate: roughly one scare every 15-40 s of eligible time, more when dreading.
    const rate = 0.025 + this.dread * 0.05 + this.attention * 0.02;
    if (!w.rng.chance(rate * dt)) return;
    this.fire(allowed);
  }

  /** Picks and triggers a scare that the situation allows. Exposed for tests/debug. */
  fire(allowed: ScareKind[] = PHASE_KINDS.outage): ScareEvent | null {
    const w = this.w;
    const dark = 1 - w.facility.lightLevel(w.player.room);
    const options: { kind: ScareKind; weight: number; make: () => ScareEvent | null }[] = [];
    const add = (kind: ScareKind, weight: number, make: () => ScareEvent | null) => {
      if (allowed.includes(kind) && weight > 0 && kind !== this.lastKind) options.push({ kind, weight, make });
    };

    add('footsteps', 1.4, () => {
      const p = this.spotNear(4, 9, false);
      return p ? { kind: 'footsteps', pos: p, duration: 3, intensity: 0.6 } : null;
    });
    add('whisper', 1.2, () => {
      const p = this.spotBehind();
      return p ? { kind: 'whisper', pos: p, duration: 3.2, intensity: 0.8 } : null;
    });
    add('apparition', 1.6 + dark, () => {
      const p = this.spotNear(6, 13, true);
      return p ? { kind: 'apparition', pos: p, duration: 6, intensity: 0.8 } : null;
    });
    if (dark > 0.6 && this.dread > 0.45 && w.time - this.lastLunge > 120) {
      add('lunge', 1 + this.dread * 1.5, () => {
        this.lastLunge = w.time;
        return { kind: 'lunge', pos: { ...w.player.pos }, duration: 1, intensity: 1 };
      });
    }
    const room = w.player.room;
    if (room && w.facility.generatorOnline && w.facility.lightSwitch.get(room)) {
      add('blackout', 1, () => {
        w.facility.setLights(room, false, 'listener');
        return { kind: 'blackout', pos: w.map.roomCenter(room), duration: 1.5, intensity: 0.9 };
      });
    }
    const openDoor = [...w.facility.doors.values()].find((d) => d.open && !d.locked && dist(doorCenter(d.def), w.player.pos) < 12);
    if (openDoor) {
      add('door_slam', 1.2, () => {
        w.facility.setDoor(openDoor.def.id, false, 'listener');
        return { kind: 'door_slam', pos: doorCenter(openDoor.def), duration: 1, intensity: 0.9 };
      });
    }
    const living = w.npcs.filter((n) => n.alive);
    if (living.length) {
      add('false_voice', 0.9, () => {
        const npc = w.rng.pick(living);
        const text = w.rng.pick(FALSE_VOICE_LINES);
        w.radio.post({ from: npc.id, to: 'player', original: text, status: 'report', authentic: false, signal: 0.8 });
        w.history.record({
          time: w.time,
          category: 'entity',
          actor: 'listener',
          text: `"${npc.name}" said on the radio: "${text}" — ${npc.name} never said it.`,
          danger: 0.6,
          tags: ['false_voice'],
        });
        return { kind: 'false_voice', duration: 2.5, intensity: 0.5 };
      });
    }
    if (this.heard.length && living.length) {
      add('false_order', 0.9, () => {
        const cmd = w.rng.pick(this.heard);
        const npc = w.rng.pick(living);
        w.radio.post({ from: 'player', to: npc.id, original: command(cmd).phrase, status: 'sent', authentic: false, signal: 0.75 });
        w.history.record({
          time: w.time,
          category: 'entity',
          actor: 'listener',
          text: `Your voice told ${npc.name}: "${command(cmd).phrase}" — you never sent it.`,
          danger: 0.7,
          tags: ['false_order'],
        });
        w.radio.later(w.radio.latency(), () => npc.receive(cmd, 0.75, false));
        return { kind: 'false_order', duration: 2, intensity: 0.5 };
      });
    }

    // Weighted pick; fall through to the next option if a spot could not be found.
    while (options.length) {
      const total = options.reduce((s, o) => s + o.weight, 0);
      let r = w.rng.next() * total;
      const i = options.findIndex((o) => (r -= o.weight) <= 0);
      const opt = options.splice(i < 0 ? options.length - 1 : i, 1)[0];
      const ev = opt.make();
      if (!ev) continue;
      this.commit(ev);
      return ev;
    }
    return null;
  }

  private commit(ev: ScareEvent): void {
    const w = this.w;
    this.lastKind = ev.kind;
    this.log.push({ time: w.time, kind: ev.kind });
    this.dread = clamp01(this.dread + 0.15 * ev.intensity);
    // Cooldown: shorter when dread is high, much longer after a big one.
    const base = ev.kind === 'lunge' ? 55 : ev.kind === 'apparition' ? 30 : 18;
    this.nextAllowed = w.time + base + w.rng.range(0, 25) * (1.2 - this.dread * 0.6);
    if (ev.pos && (ev.kind === 'footsteps' || ev.kind === 'door_slam' || ev.kind === 'blackout' || ev.kind === 'lunge')) {
      w.facility.makeNoise(ev.pos, ev.kind === 'footsteps' ? 0.5 : 0.9, `listener:${ev.kind}`);
    }
    if (!ev.kind.startsWith('false')) {
      const text: Record<string, string> = {
        footsteps: 'Something heavy walked close to you, out of sight.',
        whisper: 'Something breathed right behind you.',
        apparition: 'You saw a figure at the edge of your flashlight.',
        lunge: 'It was in front of you. Then it wasn\'t.',
        blackout: 'The lights around you blew out.',
        door_slam: 'A door slammed shut next to you. Nobody was there.',
      };
      w.history.record({ time: w.time, category: 'entity', actor: 'listener', text: text[ev.kind], danger: ev.kind === 'lunge' ? 0.95 : 0.6 * ev.intensity, tags: [ev.kind] });
    }
    w.bus.emit('scare', ev);
  }

  /** Walkable point at a distance from the player; `ahead` = in front within the view cone with line of sight. */
  private spotNear(min: number, max: number, ahead: boolean): Vec2 | null {
    const w = this.w;
    const p = w.player.pos;
    const fwd = { x: -Math.sin(this.w.player.yaw), z: -Math.cos(this.w.player.yaw) };
    const candidates: Vec2[] = [];
    for (let row = 0; row < w.map.height; row++) {
      for (let col = 0; col < w.map.width; col++) {
        if (w.map.isSolid(col, row) || w.map.isDoor(col, row)) continue;
        const c = cellToWorld({ col, row });
        const d = dist(c, p);
        if (d < min || d > max) continue;
        const dot = ((c.x - p.x) * fwd.x + (c.z - p.z) * fwd.z) / d;
        if (ahead ? dot < 0.85 || !this.lineOfSight(p, c) : dot > 0.3) continue;
        candidates.push(c);
      }
    }
    return candidates.length ? this.w.rng.pick(candidates) : null;
  }

  private spotBehind(): Vec2 | null {
    const p = this.w.player.pos;
    for (const d of [1.6, 1.2, 0.9]) {
      const b = { x: p.x + Math.sin(this.w.player.yaw) * d, z: p.z + Math.cos(this.w.player.yaw) * d };
      const c = worldToCell(b);
      if (!this.w.map.isSolid(c.col, c.row)) return b;
    }
    return null;
  }

  /** Grid ray march: walls, furniture and closed doors block sight. */
  lineOfSight(a: Vec2, b: Vec2): boolean {
    const w = this.w;
    const steps = Math.ceil(dist(a, b) / (CELL * 0.2));
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const c = worldToCell({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
      if (w.map.isSolid(c.col, c.row)) return false;
      const door = w.map.doorAt(c.col, c.row);
      if (door && !w.facility.isDoorOpen(door.id)) return false;
    }
    return true;
  }
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}
