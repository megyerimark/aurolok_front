import { FACILITY_LAYOUT, FacilityMap, ROOMS } from '../src/sim/facility/FacilityMap';
import { PointsOfInterest } from '../src/sim/facility/PointsOfInterest';

describe('FacilityMap', () => {
  const map = new FacilityMap();

  it('has a rectangular layout', () => {
    for (const row of FACILITY_LAYOUT) expect(row.length).toBe(FACILITY_LAYOUT[0].length);
  });

  it('finds every door with unique ids and exactly one keycard door', () => {
    expect(map.doors.length).toBe(7);
    expect(new Set(map.doors.map((d) => d.id)).size).toBe(7);
    expect(map.doors.filter((d) => d.kind === 'keycard').map((d) => d.rooms.sort())).toEqual([['corridor', 'restricted']]);
  });

  it('connects every room to the control room when doors are passable', () => {
    const from = map.standSpot('control');
    for (const r of ROOMS) expect(map.findPath(from, map.standSpot(r.id)), r.id).not.toBeNull();
  });

  it('cuts off the restricted sector when its door is impassable', () => {
    const path = map.findPath(map.standSpot('control'), map.standSpot('restricted'), (d) => d.kind !== 'keycard');
    expect(path).toBeNull();
  });

  it('never routes through furniture', () => {
    const path = map.findPath(map.standSpot('storage'), map.standSpot('generator'))!;
    for (const p of path.slice(0, -1)) {
      const c = { col: Math.floor(p.x / 2), row: Math.floor(p.z / 2) };
      expect(map.isSolid(c.col, c.row)).toBe(false);
    }
  });

  it('places points of interest on walkable cells', () => {
    const poi = new PointsOfInterest(map);
    expect(poi.switches.size).toBe(ROOMS.length);
    const cells = [poi.generatorPanelCell, poi.keycardCell, ...poi.batteryCells, ...[...poi.switches.values()].map((s) => s.cell)];
    for (const c of cells) expect(map.isSolid(c.col, c.row), `${c.col},${c.row}`).toBe(false);
  });
});
