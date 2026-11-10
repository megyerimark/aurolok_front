import { cellToWorld, FacilityMap, ROOMS, type Cell, type RoomId, type Vec2 } from './FacilityMap';

/**
 * Functional locations inside the facility, derived from the map so they stay
 * consistent with geometry. Simulation uses the stand positions; LevelBuilder
 * mounts the matching props (switch panels, generator console, lockers).
 */
export interface LightSwitchPoint {
  room: RoomId;
  /** Where someone stands to use it (room cell next to the door). */
  stand: Vec2;
  cell: Cell;
  /** Unit vector from the stand cell towards the door (the wall the panel is on). */
  towardDoor: Vec2;
}

export interface HideSpot {
  room: RoomId;
  pos: Vec2;
  label: string;
}

export class PointsOfInterest {
  readonly switches = new Map<RoomId, LightSwitchPoint>();
  /** Generator control panel: stand here to repair. */
  readonly generatorPanel: Vec2;
  readonly generatorPanelCell: Cell = { col: 7, row: 8 };
  readonly hideSpots: HideSpot[];
  /** Player start: behind the control console, facing the monitors. */
  readonly playerStart: Vec2;
  /** Pickups. */
  readonly keycardCell: Cell = { col: 25, row: 1 };
  readonly batteryCells: Cell[] = [
    { col: 19, row: 4 },
    { col: 6, row: 4 },
    { col: 11, row: 11 },
  ];

  constructor(readonly map: FacilityMap) {
    for (const room of ROOMS) {
      const door = map.doors.find((d) => d.rooms.includes(room.id));
      if (!door) continue;
      const { col, row } = door.cell;
      const neighbours: Cell[] = [
        { col: col + 1, row },
        { col: col - 1, row },
        { col, row: row + 1 },
        { col, row: row - 1 },
      ];
      const cell = neighbours.find((c) => map.roomAt(c.col, c.row) === room.id && !map.isBlocked(c.col, c.row))!;
      this.switches.set(room.id, {
        room: room.id,
        cell,
        stand: cellToWorld(cell),
        towardDoor: { x: col - cell.col, z: row - cell.row },
      });
    }
    this.generatorPanel = cellToWorld(this.generatorPanelCell);
    this.hideSpots = [
      { room: 'storage', pos: cellToWorld({ col: 1, row: 4 }), label: 'a storage locker' },
      { room: 'medical', pos: cellToWorld({ col: 25, row: 4 }), label: 'behind the medical cabinets' },
      { room: 'lab', pos: cellToWorld({ col: 17, row: 1 }), label: 'under a lab bench' },
      { room: 'generator', pos: cellToWorld({ col: 3, row: 11 }), label: 'behind the generator' },
      { room: 'control', pos: cellToWorld({ col: 24, row: 11 }), label: 'under the control desk' },
    ];
    this.playerStart = cellToWorld({ col: 20, row: 10 });
  }
}
