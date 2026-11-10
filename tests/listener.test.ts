import { SimWorld } from '../src/sim/SimWorld';

/** A shift where the player stands in the corridor and the power is out. */
function darkShift(seed: number, seconds: number): SimWorld {
  const w = new SimWorld({ seed });
  w.player.pos = { x: 27, z: 13 };
  w.player.room = 'corridor';
  w.transmit('all', 'status'); // check-in -> 'calm'
  w.transmit('robert', 'repair_power'); // something for the entity to overhear
  for (let t = 0; t < seconds; t += 0.1) {
    w.player.yaw = Math.sin(t * 0.3) * 2; // looking around
    w.update(0.1);
  }
  return w;
}

describe('THE LISTENER scare director', () => {
  it('does nothing before the team has checked in', () => {
    const w = new SimWorld({ seed: 1 });
    for (let t = 0; t < 120; t += 0.1) w.update(0.1);
    expect(w.listener.log.length).toBe(0);
  });

  it('scares regularly but not constantly once the lights are out', () => {
    for (const seed of [1, 2, 3, 4]) {
      const w = darkShift(seed, 600);
      const log = w.listener.log;
      expect(log.length, `seed ${seed}`).toBeGreaterThanOrEqual(6);
      expect(log.length, `seed ${seed}`).toBeLessThanOrEqual(35);
      for (let i = 1; i < log.length; i++) {
        expect(log[i].time - log[i - 1].time).toBeGreaterThanOrEqual(18);
        expect(log[i].kind).not.toBe(log[i - 1].kind);
      }
    }
  });

  it('is varied: many different kinds of scare across a shift', () => {
    const kinds = new Set<string>();
    for (const seed of [5, 6, 7]) for (const e of darkShift(seed, 600).listener.log) kinds.add(e.kind);
    expect(kinds.size).toBeGreaterThanOrEqual(6);
  });

  it('is unpredictable between shifts but reproducible from the seed', () => {
    const a = darkShift(11, 400).listener.log;
    const b = darkShift(11, 400).listener.log;
    const c = darkShift(12, 400).listener.log;
    expect(b).toEqual(a);
    expect(c).not.toEqual(a);
  });

  it('only lunges at the player in the dark', () => {
    const w = new SimWorld({ seed: 3, story: false });
    w.player.pos = w.map.standSpot('control');
    w.player.room = 'control';
    w.listener.dread = 1;
    for (let i = 0; i < 40; i++) expect(w.listener.fire(['lunge'])).toBeNull();
    w.facility.setLights('control', false, 'test');
    expect(w.listener.fire(['lunge'])?.kind).toBe('lunge');
  });

  it('can turn your own earlier order against you', () => {
    const w = new SimWorld({ seed: 9, story: false, ambientNoise: false });
    w.transmit('robert', 'goto_generator');
    for (let t = 0; t < 5; t += 0.1) w.update(0.1);
    const ev = w.listener.fire(['false_order']);
    expect(ev?.kind).toBe('false_order');
    const fake = w.radio.log.filter((m) => m.from === 'player' && !m.authentic);
    expect(fake.length).toBe(1);
    expect(w.history.entries.some((e) => e.tags.includes('false_order'))).toBe(true);
  });
});
