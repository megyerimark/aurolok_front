/**
 * Records gameplay-significant events. This is the raw material for the
 * end-of-shift incident report, and a debugging aid: every NPC decision is
 * stored together with the reason it was made.
 */
export type HistoryCategory =
  | 'command' // the player issued an instruction
  | 'response' // an NPC accepted / refused / misread an instruction
  | 'npc' // an NPC changed state on its own (panic, hiding, injury)
  | 'facility' // power, doors, lights
  | 'entity' // anything THE LISTENER did
  | 'story'; // objectives / chapter beats

export interface HistoryEntry {
  time: number; // seconds since shift start
  category: HistoryCategory;
  actor: string; // 'player', npc id, 'facility', 'listener'
  text: string; // human-readable, report-ready sentence
  reason?: string; // why it happened (for decisions)
  danger: number; // 0..1, how dangerous the moment was
  tags: string[];
}

export class EventHistory {
  readonly entries: HistoryEntry[] = [];

  record(entry: Omit<HistoryEntry, 'tags' | 'danger'> & { danger?: number; tags?: string[] }): HistoryEntry {
    const full: HistoryEntry = { danger: 0, tags: [], ...entry };
    this.entries.push(full);
    return full;
  }

  byActor(actor: string): HistoryEntry[] {
    return this.entries.filter((e) => e.actor === actor);
  }

  byCategory(category: HistoryCategory): HistoryEntry[] {
    return this.entries.filter((e) => e.category === category);
  }

  /** The N most dangerous moments, most dangerous first (ties: earliest first). */
  mostDangerous(n: number): HistoryEntry[] {
    return [...this.entries].sort((a, b) => b.danger - a.danger || a.time - b.time).slice(0, n);
  }
}
