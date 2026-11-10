/**
 * The facility layout as a grid. One source of truth for:
 *  - level geometry (LevelBuilder turns cells into walls/floors),
 *  - collision (player + NPCs),
 *  - navigation (A* over cells, doors as conditional edges),
 *  - room membership ("which room is Emily in, and is it dark?").
 *
 * Each character is a CELL x CELL metre square seen from above.
 * Columns map to +X, rows map to +Z.
 */

export const CELL = 2; // metres per cell
export const CEILING = 3.2; // metres

export type RoomId = 'control' | 'corridor' | 'lab' | 'generator' | 'medical' | 'storage' | 'restricted';

export interface RoomDef {
  id: RoomId;
  name: string; // shown in UI / radio
  char: string; // map character
  /** Rough description of what the room is for; used by docs/tooling. */
  purpose: string;
}

export const ROOMS: RoomDef[] = [
  { id: 'control', name: 'Central Control', char: 'C', purpose: 'Radio console, camera monitors, the only safe-ish place.' },
  { id: 'corridor', name: 'Security Corridor', char: 'S', purpose: 'Spine connecting every sector. Long sightlines, emergency lights.' },
  { id: 'lab', name: 'Laboratory', char: 'L', purpose: 'Signal-analysis lab. Emily works here.' },
  { id: 'generator', name: 'Generator Room', char: 'G', purpose: 'Facility power. Loud, hot, dark when it fails.' },
  { id: 'medical', name: 'Medical Room', char: 'M', purpose: 'Infirmary. Batteries and the restricted keycard are kept here.' },
  { id: 'storage', name: 'Storage', char: 'T', purpose: 'Shelving, crates, lockers. Good hiding spots.' },
  { id: 'restricted', name: 'Restricted Research Sector', char: 'R', purpose: 'Where the incident happened. Keycard access only.' },
];

/**
 * '#' wall, room chars (upper case) floor, lower case = floor occupied by
 * furniture/machinery of that room (blocks movement, LevelBuilder places the
 * matching prop), '+' door, '=' keycard door.
 * Every row must have the same length (validated in tests).
 */
export const FACILITY_LAYOUT: readonly string[] = [
  '####################################', // 0
  '#tTtTTt#LLLLLLLLLL#MmMmMmM##########', // 1
  '#tTtTTT#LlllLLlllL#MMMMMMM###RRRRRR#', // 2
  '#TTTTTT#LLLLLLLLLL#MMMMMMM###RRrrRR#', // 3
  '#TTTTTT#LLLLLLLLLL#MMMMMMM###RRrrRR#', // 4
  '####+#######+#########+######RRRRRR#', // 5
  '#SSSSSSSSSSSSSSSSSSSSSSSSSSS=RRRRRR#', // 6
  '#S######+###########+########RRRRRR#', // 7
  '#S#GGGGGGGGG####CCCCCCCCC####RRRRRR#', // 8
  '#S#GGGgggGGG####CCcccccCC###########', // 9
  '#S+GGGgggGGG####CCCCCCCCC###########', // 10
  '#S#GGGGGGGGG####CCCCCCCCC###########', // 11
  '####################################', // 12
];

export interface Cell {
  col: number;
  row: number;
}

export interface Vec2 {
  x: number;
  z: number;
}

export type DoorKind = 'normal' | 'keycard';

export interface DoorDef {
  id: string;
  cell: Cell;
  kind: DoorKind;
  /** 'x' = slab spans along X (passage runs along Z), 'z' = slab spans along Z. */
  axis: 'x' | 'z';
  /** The two rooms this door joins. */
  rooms: [RoomId, RoomId];
}

const charToRoom = new Map<string, RoomId>(ROOMS.flatMap((r) => [[r.char, r.id] as const, [r.char.toLowerCase(), r.id] as const]));

export class FacilityMap {
  readonly width: number;
  readonly height: number;
  readonly doors: DoorDef[] = [];
  private readonly grid: string[];
  private readonly doorByKey = new Map<string, DoorDef>();

  constructor(layout: readonly string[] = FACILITY_LAYOUT) {
    this.grid = [...layout];
    this.height = layout.length;
    this.width = layout[0].length;
    for (const [row, line] of layout.entries()) {
      if (line.length !== this.width) throw new Error(`Facility row ${row} has length ${line.length}, expected ${this.width}`);
    }
    this.findDoors();
  }

  charAt(col: number, row: number): string {
    if (row < 0 || row >= this.height || col < 0 || col >= this.width) return '#';
    return this.grid[row][col];
  }

  isWall(col: number, row: number): boolean {
    return this.charAt(col, row) === '#';
  }

  /** Floor cell occupied by furniture or machinery. */
  isBlocked(col: number, row: number): boolean {
    const c = this.charAt(col, row);
    return c !== c.toUpperCase();
  }

  /** Nothing can walk here: wall or furniture. */
  isSolid(col: number, row: number): boolean {
    return this.isWall(col, row) || this.isBlocked(col, row);
  }

  isDoor(col: number, row: number): boolean {
    const c = this.charAt(col, row);
    return c === '+' || c === '=';
  }

  doorAt(col: number, row: number): DoorDef | undefined {
    return this.doorByKey.get(key(col, row));
  }

  /** Room for a floor cell. Door cells report undefined. */
  roomAt(col: number, row: number): RoomId | undefined {
    return charToRoom.get(this.charAt(col, row));
  }

  /** Room containing a world position; door cells resolve to the nearest adjoining room. */
  roomAtWorld(p: Vec2): RoomId | undefined {
    const c = worldToCell(p);
    const direct = this.roomAt(c.col, c.row);
    if (direct) return direct;
    const door = this.doorAt(c.col, c.row);
    return door?.rooms[0];
  }

  /** Walkable cell closest to a point inside the room (room centres can land on furniture). */
  standSpot(room: RoomId, near: Vec2 = this.roomCenter(room)): Vec2 {
    let best: Cell | undefined;
    let bestD = Infinity;
    for (const c of this.cellsOfRoom(room)) {
      if (this.isBlocked(c.col, c.row)) continue;
      const d = dist(cellToWorld(c), near);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    return cellToWorld(best!);
  }

  cellsOfRoom(room: RoomId): Cell[] {
    const out: Cell[] = [];
    for (let row = 0; row < this.height; row++)
      for (let col = 0; col < this.width; col++) if (this.roomAt(col, row) === room) out.push({ col, row });
    return out;
  }

  roomCenter(room: RoomId): Vec2 {
    const cells = this.cellsOfRoom(room);
    let x = 0;
    let z = 0;
    for (const c of cells) {
      const w = cellToWorld(c);
      x += w.x;
      z += w.z;
    }
    return { x: x / cells.length, z: z / cells.length };
  }

  /** Axis-aligned bounds of a room in world space (min/max corners). */
  roomBounds(room: RoomId): { min: Vec2; max: Vec2 } {
    const cells = this.cellsOfRoom(room);
    const cols = cells.map((c) => c.col);
    const rows = cells.map((c) => c.row);
    return {
      min: { x: Math.min(...cols) * CELL, z: Math.min(...rows) * CELL },
      max: { x: (Math.max(...cols) + 1) * CELL, z: (Math.max(...rows) + 1) * CELL },
    };
  }

  /**
   * A* over 4-connected cells. `canPass(door)` decides whether a door cell is
   * traversable for this particular walker (closed? locked? forbidden by an
   * instruction?). Returns cell centres from start to goal, or null.
   */
  findPath(from: Vec2, to: Vec2, canPass: (door: DoorDef) => boolean = () => true): Vec2[] | null {
    const start = worldToCell(from);
    const goal = worldToCell(to);
    if (this.isSolid(goal.col, goal.row) || this.isWall(start.col, start.row)) return null;

    const startK = key(start.col, start.row);
    const goalK = key(goal.col, goal.row);
    const open = new MinHeap();
    const g = new Map<string, number>([[startK, 0]]);
    const came = new Map<string, string>();
    const h = (c: number, r: number) => Math.abs(c - goal.col) + Math.abs(r - goal.row);
    open.push(startK, h(start.col, start.row));
    const closed = new Set<string>();

    while (open.size > 0) {
      const curK = open.pop()!;
      if (curK === goalK) break;
      if (closed.has(curK)) continue;
      closed.add(curK);
      const [cc, cr] = unkey(curK);
      for (const [dc, dr] of DIRS) {
        const nc = cc + dc;
        const nr = cr + dr;
        if (this.isSolid(nc, nr)) continue;
        const door = this.doorAt(nc, nr);
        if (door && !canPass(door)) continue;
        const nK = key(nc, nr);
        const cost = g.get(curK)! + 1;
        if (cost < (g.get(nK) ?? Infinity)) {
          g.set(nK, cost);
          came.set(nK, curK);
          open.push(nK, cost + h(nc, nr));
        }
      }
    }

    if (!g.has(goalK)) return null;
    const cells: string[] = [goalK];
    while (cells[0] !== startK) cells.unshift(came.get(cells[0])!);
    const path = cells.map((k) => {
      const [c, r] = unkey(k);
      return cellToWorld({ col: c, row: r });
    });
    // End exactly on the requested point rather than the cell centre.
    path[path.length - 1] = { ...to };
    return path;
  }

  private findDoors(): void {
    for (let row = 0; row < this.height; row++) {
      for (let col = 0; col < this.width; col++) {
        const ch = this.charAt(col, row);
        if (ch !== '+' && ch !== '=') continue;
        // Walls left/right => passage runs along Z, slab spans X.
        const wallsLR = this.isWall(col - 1, row) && this.isWall(col + 1, row);
        const axis: 'x' | 'z' = wallsLR ? 'x' : 'z';
        const a = axis === 'x' ? this.roomAt(col, row - 1) : this.roomAt(col - 1, row);
        const b = axis === 'x' ? this.roomAt(col, row + 1) : this.roomAt(col + 1, row);
        if (!a || !b) throw new Error(`Door at ${col},${row} does not join two rooms`);
        const baseId = `door_${[a, b].sort().join('_')}`;
        const dupes = this.doors.filter((d) => d.id.startsWith(baseId)).length;
        const door: DoorDef = {
          id: dupes === 0 ? baseId : `${baseId}_${dupes + 1}`,
          cell: { col, row },
          kind: ch === '=' ? 'keycard' : 'normal',
          axis,
          rooms: [a, b],
        };
        this.doors.push(door);
        this.doorByKey.set(key(col, row), door);
      }
    }
  }
}

const DIRS: ReadonlyArray<[number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

export function worldToCell(p: Vec2): Cell {
  return { col: Math.floor(p.x / CELL), row: Math.floor(p.z / CELL) };
}

export function cellToWorld(c: Cell): Vec2 {
  return { x: (c.col + 0.5) * CELL, z: (c.row + 0.5) * CELL };
}

export function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function key(col: number, row: number): string {
  return `${col},${row}`;
}

function unkey(k: string): [number, number] {
  const i = k.indexOf(',');
  return [Number(k.slice(0, i)), Number(k.slice(i + 1))];
}

/** Tiny binary heap keyed by priority, for A*. */
class MinHeap {
  private items: { k: string; p: number }[] = [];
  get size(): number {
    return this.items.length;
  }
  push(k: string, p: number): void {
    const a = this.items;
    a.push({ k, p });
    let i = a.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (a[parent].p <= a[i].p) break;
      [a[parent], a[i]] = [a[i], a[parent]];
      i = parent;
    }
  }
  pop(): string | undefined {
    const a = this.items;
    if (a.length === 0) return undefined;
    const top = a[0];
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l].p < a[m].p) m = l;
        if (r < a.length && a[r].p < a[m].p) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top.k;
  }
}
