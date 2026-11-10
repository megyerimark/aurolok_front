import { Rng } from '../src/core/Rng';
import { DialogueSelector } from '../src/sim/npc/Dialogue';

describe('DialogueSelector', () => {
  it('prefers a speaker-specific line, then falls back to shared lines', () => {
    const d = new DialogueSelector(new Rng(1));
    expect(d.resolve('daniel', 'accept.follow')!.bankKey).toBe('daniel:accept.follow');
    expect(d.resolve('robert', 'done.lights')!.bankKey).toBe('_:done.lights');
    expect(d.resolve('emily', 'accept.nonexistent')!.bankKey).toBe('emily:accept');
  });

  it('does not repeat a line until the bank is exhausted', () => {
    const d = new DialogueSelector(new Rng(7));
    const bank = d.resolve('lucas', 'question')!.lines;
    const said = new Set(bank.map(() => d.line('lucas', 'question')));
    expect(said.size).toBe(bank.length);
  });

  it('fills placeholders', () => {
    const d = new DialogueSelector(new Rng(2));
    expect(d.line('robert', 'done.arrived', { room: 'Generator Room' })).toContain('Generator Room');
  });
});
