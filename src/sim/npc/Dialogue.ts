import type { Rng } from '../../core/Rng';
import { DIALOGUE, type LineBank } from './DialogueLines';

export interface LineVars {
  room?: string;
  target?: string;
  player?: string;
}

/**
 * Picks a line for a speaker and situation.
 * Resolution order for key "a.b": speaker "a.b" -> shared "a.b" -> speaker "a" -> shared "a".
 * Within the chosen bank, lines used recently are avoided (least-recently-used
 * wins, ties broken by the seeded RNG) so repeated situations do not repeat words.
 */
export class DialogueSelector {
  private lastUsed = new Map<string, number>();
  private counter = 0;

  constructor(
    private readonly rng: Rng,
    private readonly banks: Record<string, LineBank> = DIALOGUE,
  ) {}

  /** Returns the resolved bank key actually used (useful for tests/debug). */
  resolve(speaker: string, key: string): { bankKey: string; lines: string[] } | undefined {
    const own = this.banks[speaker] ?? {};
    const shared = this.banks._ ?? {};
    const base = key.split('.')[0];
    const candidates: Array<[string, LineBank]> = [
      [`${speaker}:${key}`, own],
      [`_:${key}`, shared],
      [`${speaker}:${base}`, own],
      [`_:${base}`, shared],
    ];
    for (const [bankKey, bank] of candidates) {
      const k = bankKey.slice(bankKey.indexOf(':') + 1);
      const lines = bank[k];
      if (lines && lines.length > 0) return { bankKey, lines };
    }
    return undefined;
  }

  line(speaker: string, key: string, vars: LineVars = {}): string {
    const found = this.resolve(speaker, key);
    if (!found) return '...';
    let best: string[] = [];
    let bestAge = Infinity;
    for (const text of found.lines) {
      const used = this.lastUsed.get(`${speaker}|${text}`) ?? -1;
      if (used < bestAge) {
        bestAge = used;
        best = [text];
      } else if (used === bestAge) best.push(text);
    }
    const text = this.rng.pick(best);
    this.lastUsed.set(`${speaker}|${text}`, this.counter++);
    return fill(text, vars);
  }
}

function fill(text: string, vars: LineVars): string {
  return text
    .replace(/\{room\}/g, vars.room ?? 'here')
    .replace(/\{target\}/g, vars.target ?? 'there')
    .replace(/\{player\}/g, vars.player ?? 'control');
}
