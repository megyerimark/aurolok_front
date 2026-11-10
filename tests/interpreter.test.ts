import { Rng } from '../src/core/Rng';
import { command } from '../src/sim/npc/Commands';
import { interpret, type InterpretContext, type ResponseKind } from '../src/sim/npc/Interpreter';
import { PERSONALITIES } from '../src/sim/npc/Personality';

const P = Object.fromEntries(PERSONALITIES.map((p) => [p.id, p]));

function ctx(over: Partial<InterpretContext> = {}): InterpretContext {
  return { fear: 0.15, stress: 0.1, trust: 0.65, signal: 1, targetRisk: 0.65, insisted: false, contradicts: false, stimulus: 0, alreadyDone: false, ...over };
}

/** Distribution of response kinds across many seeds. */
function dist(id: string, cmd: Parameters<typeof command>[0], c: InterpretContext, n = 400): Record<ResponseKind, number> {
  const out: Record<ResponseKind, number> = { comply: 0, hesitate: 0, question: 0, misread: 0, independent: 0, refuse: 0 };
  const p = { ...P[id] };
  for (let s = 1; s <= n; s++) out[interpret(p, command(cmd), { ...c, trust: c.trust ?? p.initialTrust }, new Rng(s)).kind] += 1 / n;
  return out;
}

describe('Interpreter: same order, different people', () => {
  // "Go to the generator" while the generator room is dark.
  const dark = (id: string) => ctx({ fear: P[id].initialFear, trust: P[id].initialTrust });

  it('Robert (rule follower) almost always complies', () => {
    expect(dist('robert', 'goto_generator', dark('robert')).comply).toBeGreaterThan(0.9);
  });

  it('Emily (anxious) usually resists, hesitates or refuses', () => {
    const d = dist('emily', 'goto_generator', dark('emily'));
    expect(d.comply).toBeLessThan(0.55);
    expect(d.hesitate + d.refuse).toBeGreaterThan(0.45);
  });

  it('Lucas (suspicious) questions or refuses far more than Robert', () => {
    const l = dist('lucas', 'goto_generator', dark('lucas'));
    const r = dist('robert', 'goto_generator', dark('robert'));
    expect(l.question + l.refuse).toBeGreaterThan(r.question + r.refuse + 0.4);
  });

  it('Daniel (overconfident) goes, unless something more interesting is happening', () => {
    expect(dist('daniel', 'goto_generator', dark('daniel')).comply).toBeGreaterThan(0.8);
    expect(dist('daniel', 'goto_generator', { ...dark('daniel'), stimulus: 1 }).independent).toBeGreaterThan(0.7);
  });

  it('insisting turns Emily around', () => {
    const once = dist('emily', 'goto_generator', dark('emily'));
    const twice = dist('emily', 'goto_generator', { ...dark('emily'), insisted: true });
    expect(twice.comply).toBeGreaterThan(once.comply + 0.3);
  });

  it('repeating an order confirms it to a suspicious listener', () => {
    const shaky = ctx({ signal: 0.6, trust: 0.5, targetRisk: 0.2 });
    expect(dist('lucas', 'goto_generator', shaky).question).toBeGreaterThan(0.5);
    expect(dist('lucas', 'goto_generator', { ...shaky, insisted: true }).question).toBeLessThan(0.1);
  });

  it('bad signal produces misreadings', () => {
    const clear = dist('robert', 'lights_off', ctx({ signal: 1, targetRisk: 0 }));
    const noisy = dist('robert', 'lights_off', ctx({ signal: 0.35, targetRisk: 0 }));
    expect(clear.misread).toBeLessThan(0.05);
    expect(noisy.misread).toBeGreaterThan(0.5);
  });

  it('always explains itself', () => {
    const d = interpret(P.emily, command('goto_generator'), dark('emily'), new Rng(3));
    expect(d.reason.length).toBeGreaterThan(3);
    expect(d.reason).not.toBe('no strong reason');
  });
});
