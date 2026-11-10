import type { Rng } from '../../core/Rng';
import type { CommandDef, CommandId } from './Commands';
import type { Personality } from './Personality';

/**
 * How an NPC responds to an instruction.
 *  comply      – does what was asked.
 *  hesitate    – asks for reassurance, then complies after a delay.
 *  question    – doubts the instruction is real; waits for the player to repeat it.
 *  misread     – carries out a different, plausible reading of the words.
 *  independent – ignores the instruction in favour of their own plan.
 *  refuse      – will not do it.
 */
export type ResponseKind = 'comply' | 'hesitate' | 'question' | 'misread' | 'independent' | 'refuse';

/** Everything the NPC knows when the instruction arrives. Built by NpcAgent. */
export interface InterpretContext {
  fear: number; // 0..1
  stress: number; // 0..1
  trust: number; // 0..1
  /** 0..1 radio clarity. Interference, distance and THE LISTENER lower it. */
  signal: number;
  /** 0..1 how dangerous the destination looks: darkness, known incidents. */
  targetRisk: number;
  /** The same instruction was repeated recently: the player is insisting. */
  insisted: boolean;
  /** Contradicts an instruction they received moments ago. */
  contradicts: boolean;
  /** Something is happening the NPC wants to deal with themselves (fresh noise). */
  stimulus: number; // 0..1
  /** The NPC is already doing the thing (e.g. already in the generator room). */
  alreadyDone: boolean;
}

export interface Decision {
  kind: ResponseKind;
  command: CommandId;
  /** For misread: the reading they actually act on. */
  actedCommand: CommandId;
  /** Ranked factor list, e.g. "dark destination (risk 0.80)". Report-ready. */
  reason: string;
  scores: Record<ResponseKind, number>;
}

/**
 * What each instruction can plausibly be misheard/misread as. Every pairing
 * should be defensible when the player looks back at it.
 */
export const MISREADINGS: Record<CommandId, CommandId> = {
  follow: 'return_control', // "Follow me" -> heads to where the player usually is
  stay: 'stay',
  goto_generator: 'repair_power', // goes there AND starts tinkering
  repair_power: 'goto_generator', // goes there but just waits for instructions
  dont_open_door: 'stay', // heard "don't open the door" as "don't leave"
  lights_off: 'lights_off', // same words, wrong lights: resolved by NpcAgent
  investigate_noise: 'investigate_noise', // wrong noise: resolved by NpcAgent
  return_control: 'follow',
  status: 'status',
};

interface Factor {
  label: string;
  value: number;
}

/**
 * Utility-based interpretation. Each possible response gets a score built
 * from named factors. The highest score wins (with a small seeded jitter so
 * identical situations are not perfectly predictable). The winning response's
 * strongest factors become the human-readable reason.
 */
export function interpret(p: Personality, cmd: CommandDef, ctx: InterpretContext, rng: Rng): Decision {
  // Status requests are always answered (the answer itself may not be honest).
  if (cmd.id === 'status') return fixed('comply', cmd.id, 'status request');

  const factors: Record<ResponseKind, Factor[]> = {
    comply: [],
    hesitate: [],
    question: [],
    misread: [],
    independent: [],
    refuse: [],
  };
  const add = (k: ResponseKind, label: string, value: number) => {
    if (Math.abs(value) > 0.001) factors[k].push({ label, value });
  };

  const fearPull = ctx.targetRisk * (0.35 + ctx.fear) * (1 - p.courage);
  const insist = ctx.insisted ? 1 : 0;

  // --- comply
  add('comply', 'obedient', p.obedience * 0.55);
  add('comply', 'trusts you', ctx.trust * 0.45);
  add('comply', 'you insisted', insist * 0.35);
  add('comply', 'afraid of the destination', -fearPull * 1.3);
  add('comply', 'already there', ctx.alreadyDone ? 0.2 : 0);

  // --- hesitate (wants reassurance; low stress tolerance)
  add('hesitate', 'frightened', fearPull * 0.85);
  add('hesitate', 'low stress tolerance', (1 - p.stressTolerance) * 0.35 * (0.4 + ctx.stress));
  add('hesitate', 'already reassured', -insist * 0.6);

  // --- question (doubts the source)
  const oddness = (1 - ctx.signal) * 0.8 + (ctx.contradicts ? 0.45 : 0) + ctx.targetRisk * 0.25;
  add('question', 'suspicious of the transmission', p.suspicion * oddness);
  add('question', 'distrusts you', (1 - ctx.trust) * p.suspicion * 0.35);
  add('question', 'confirmed by repetition', -insist * 0.9);

  // --- misread (bad signal, stress, literal reading of an ambiguous order)
  add('misread', 'poor signal', (1 - ctx.signal) * 0.95);
  add('misread', 'stressed', ctx.stress * (1 - p.awareness) * 0.35);
  add('misread', 'literal reading of an ambiguous order', p.literalness * cmd.ambiguity * 0.3);
  add('misread', 'clear repetition', -insist * 0.3);

  // --- independent (own plan beats your plan)
  add('independent', 'prefers own judgement', p.independence * 0.45);
  add('independent', 'something caught their attention', ctx.stimulus * p.independence * 0.5);
  add('independent', 'brave', p.courage * 0.15);
  add('independent', 'obedient', -p.obedience * 0.4);
  add('independent', 'careful', -p.caution * 0.15);

  // --- refuse
  add('refuse', 'afraid of the destination', fearPull * 1.15);
  add('refuse', 'distrusts you', (1 - ctx.trust) * 0.25);
  add('refuse', 'not one to obey', (1 - p.obedience) * 0.15);
  add('refuse', 'pressured', insist * fearPull * 0.3);
  add('refuse', 'obedient', -p.obedience * 0.2);

  const scores = {} as Record<ResponseKind, number>;
  let best: ResponseKind = 'comply';
  for (const k of Object.keys(factors) as ResponseKind[]) {
    const s = factors[k].reduce((sum, f) => sum + f.value, 0) + rng.range(-0.06, 0.06);
    scores[k] = s;
    if (s > scores[best]) best = k;
  }

  // Ordering someone to stay put cannot really be "refused out of fear".
  if (cmd.id === 'stay' && (best === 'refuse' || best === 'hesitate')) best = 'comply';

  const top = factors[best]
    .filter((f) => f.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, 2)
    .map((f) => f.label);
  return {
    kind: best,
    command: cmd.id,
    actedCommand: best === 'misread' ? MISREADINGS[cmd.id] : cmd.id,
    reason: top.join(', ') || 'no strong reason',
    scores,
  };
}

function fixed(kind: ResponseKind, id: CommandId, reason: string): Decision {
  const scores: Record<ResponseKind, number> = { comply: 0, hesitate: 0, question: 0, misread: 0, independent: 0, refuse: 0 };
  scores[kind] = 1;
  return { kind, command: id, actedCommand: id, reason, scores };
}
