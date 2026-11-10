import type { EventBus } from '../../core/EventBus';
import type { Rng } from '../../core/Rng';
import type { RoomId } from '../facility/FacilityMap';
import type { SimEvents } from '../SimEvents';

export type RadioStatus =
  | 'sent' // player transmission
  | 'accepted'
  | 'hesitant'
  | 'questioned'
  | 'misread' // the NPC acted on a different reading; only revealed in hindsight
  | 'independent'
  | 'refused'
  | 'report' // a status report or task update
  | 'no_response'
  | 'unknown'; // a transmission nobody on the team sent

export interface RadioMessage {
  id: number;
  time: number;
  /** 'player', an npc id, 'system', or 'unknown'. */
  from: string;
  /** npc id, 'all', or 'player'. */
  to: string;
  /** The text as heard (possibly garbled). */
  text: string;
  /** The text as actually said; kept for the incident report. */
  original: string;
  status: RadioStatus;
  /** False when the transmission did not come from who it claims to. */
  authentic: boolean;
  signal: number;
}

/**
 * Per-room baseline radio clarity. Shielding and the generator's EM noise
 * degrade the signal; the restricted sector is worst. THE LISTENER (stage 4)
 * will push these down further.
 */
const ROOM_SIGNAL: Record<RoomId, number> = {
  control: 1,
  corridor: 0.97,
  lab: 0.95,
  medical: 0.95,
  storage: 0.92,
  generator: 0.82,
  restricted: 0.55,
};

interface Pending {
  at: number;
  run: () => void;
}

export class RadioSystem {
  readonly log: RadioMessage[] = [];
  time = 0;
  /** Extra interference applied to every channel (0 = none, 1 = unusable). */
  interference = 0;
  private nextId = 1;
  private pending: Pending[] = [];

  constructor(
    private readonly bus: EventBus<SimEvents>,
    private readonly rng: Rng,
  ) {}

  signalFor(room: RoomId | undefined): number {
    const base = room ? ROOM_SIGNAL[room] : 0.9;
    return clamp01(base - this.interference);
  }

  /** Schedules work after a delay in simulation seconds. */
  later(delay: number, run: () => void): void {
    this.pending.push({ at: this.time + delay, run });
  }

  /** Radio latency + human reaction time before a recipient hears a call. */
  latency(): number {
    return this.rng.range(0.35, 0.8);
  }

  post(msg: Omit<RadioMessage, 'id' | 'time' | 'text'> & { text?: string }): RadioMessage {
    const text = msg.text ?? garble(msg.original, msg.signal, this.rng);
    const full: RadioMessage = { ...msg, text, id: this.nextId++, time: this.time };
    this.log.push(full);
    if (full.signal < 0.9) this.bus.emit('radioStatic', { intensity: 1 - full.signal, duration: 0.6 + (1 - full.signal) });
    this.bus.emit('radioMessage', full);
    return full;
  }

  update(dt: number): void {
    this.time += dt;
    const due = this.pending.filter((p) => p.at <= this.time);
    if (due.length === 0) return;
    this.pending = this.pending.filter((p) => p.at > this.time);
    for (const p of due) p.run();
  }
}

/**
 * Drops words to static according to signal quality. A clear signal (>= 0.9)
 * passes through untouched; at 0.5 roughly a third of the words are lost.
 */
export function garble(text: string, signal: number, rng: Rng): string {
  if (signal >= 0.9) return text;
  const lossChance = (0.9 - signal) * 0.8;
  return text
    .split(' ')
    .map((w) => (rng.chance(lossChance) ? '—' : w))
    .join(' ')
    .replace(/(— )+—/g, '——');
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}
