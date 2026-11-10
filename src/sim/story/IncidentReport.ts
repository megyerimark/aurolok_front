import type { HistoryEntry } from '../../core/EventHistory';
import type { SimWorld } from '../SimWorld';

export interface IncidentReport {
  seed: number;
  duration: number;
  commands: HistoryEntry[];
  /** Non-compliant responses: refusals, misreadings, questions, independent action. */
  reactions: HistoryEntry[];
  mistakes: HistoryEntry[];
  unexpected: HistoryEntry[];
  personnel: { name: string; role: string; status: string; trust: number }[];
  mostDangerous: HistoryEntry[];
}

/** Turns the event history into the end-of-shift report. */
export function buildIncidentReport(w: SimWorld): IncidentReport {
  const h = w.history.entries;
  const has = (e: HistoryEntry, ...tags: string[]) => tags.some((t) => e.tags.includes(t));
  return {
    seed: w.seed,
    duration: w.time,
    commands: h.filter((e) => e.category === 'command'),
    reactions: h.filter((e) => e.category === 'response' && !has(e, 'comply')),
    mistakes: h.filter((e) => has(e, 'misread', 'panic', 'literal')),
    unexpected: h.filter((e) => e.category === 'entity' || has(e, 'independent', 'power')),
    personnel: w.npcs.map((n) => ({
      name: n.name,
      role: n.p.role,
      status: !n.alive ? 'Lost' : n.state === 'Hiding' ? 'Hiding — unaccounted for' : n.state === 'Injured' ? 'Injured' : 'Accounted for',
      trust: n.trust,
    })),
    mostDangerous: w.history.mostDangerous(3).filter((e) => e.danger > 0),
  };
}

export function formatTime(t: number): string {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
