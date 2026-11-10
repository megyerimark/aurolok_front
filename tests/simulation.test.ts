import { SimWorld } from '../src/sim/SimWorld';
import { buildIncidentReport } from '../src/sim/story/IncidentReport';

function run(w: SimWorld, seconds: number, until?: () => boolean): void {
  for (let t = 0; t < seconds; t += 0.1) {
    w.update(0.1);
    if (until?.()) return;
  }
}

const quiet = (seed = 11) => new SimWorld({ seed, story: false, ambientNoise: false });

describe('SimWorld integration', () => {
  it('Robert takes "Do not open the door" literally and gets stuck behind one', () => {
    const w = quiet();
    w.transmit('robert', 'dont_open_door');
    run(w, 4);
    w.transmit('robert', 'goto_generator');
    run(w, 6);
    const robert = w.npc('robert');
    expect(robert.room).toBe('storage');
    expect(w.radio.log.some((m) => m.from === 'robert' && /door/i.test(m.original) && m.status === 'report')).toBe(true);
    expect(w.history.entries.some((e) => e.tags.includes('literal'))).toBe(true);
  });

  it('a technician restores power after a trip', () => {
    const w = quiet(5);
    w.facility.tripGenerator('test');
    w.transmit('robert', 'repair_power');
    run(w, 150, () => w.facility.generatorOnline);
    expect(w.facility.generatorOnline).toBe(true);
    expect(w.history.entries.some((e) => e.text.includes('Robert restored facility power'))).toBe(true);
  });

  it('the same order to the whole team produces different reactions', () => {
    const kinds = new Set<string>();
    for (let seed = 1; seed <= 6; seed++) {
      const w = quiet(seed);
      w.facility.tripGenerator('test');
      run(w, 3);
      w.transmit('all', 'goto_generator');
      run(w, 4);
      for (const e of w.history.byCategory('response')) kinds.add(e.tags[0]);
    }
    expect(kinds.size).toBeGreaterThanOrEqual(3);
  });

  it('a frightened NPC left in the dark eventually panics and hides', () => {
    const w = quiet(3);
    const emily = w.npc('emily');
    w.facility.tripGenerator('test');
    run(w, 90, () => emily.state === 'Hiding');
    expect(['Panicking', 'Hiding']).toContain(emily.state);
    expect(w.history.entries.some((e) => e.actor === 'emily' && e.tags.includes('panic'))).toBe(true);
  });

  it('Daniel says everything is fine while hiding', () => {
    const w = quiet(4);
    const daniel = w.npc('daniel');
    daniel.fear = 1;
    run(w, 30, () => daniel.state === 'Hiding');
    expect(daniel.state).toBe('Hiding');
    daniel.fear = 0.9; // still frightened, so he stays hidden
    w.transmit('daniel', 'status');
    run(w, 3);
    const last = w.radio.log.filter((m) => m.from === 'daniel').at(-1)!;
    expect(last.original).toMatch(/safe|clear|control/i);
  });

  it('builds an incident report from the history', () => {
    const w = quiet(8);
    w.transmit('all', 'status');
    w.facility.tripGenerator('test');
    run(w, 20);
    const r = buildIncidentReport(w);
    expect(r.commands.length).toBe(1);
    expect(r.personnel.length).toBe(4);
    expect(r.unexpected.some((e) => e.tags.includes('power'))).toBe(true);
  });

  it('runs a full scripted shift without errors', () => {
    const w = new SimWorld({ seed: 99 });
    w.transmit('all', 'status');
    run(w, 400);
    expect(w.story.phase).not.toBe('checkin');
  });
});
