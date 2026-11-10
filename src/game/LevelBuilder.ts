import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CEILING, CELL, cellToWorld, ROOMS, type Cell, type DoorDef, type FacilityMap, type RoomId, type Vec2 } from '../sim/facility/FacilityMap';
import type { PointsOfInterest } from '../sim/facility/PointsOfInterest';
import { brushedMetal, ceilingPanels, concreteWall, doorTexture, floorTiles, textPanel } from './textures';

export interface RoomLights {
  room: RoomId;
  lights: THREE.PointLight[];
  baseIntensity: number[];
  fixtures: THREE.MeshStandardMaterial;
  emergency: THREE.PointLight[];
  emergencyFixtures: THREE.MeshStandardMaterial | null;
}

export interface DoorView {
  def: DoorDef;
  group: THREE.Group;
  slab: THREE.Mesh;
  led: THREE.MeshStandardMaterial;
  /** 0 closed .. 1 open (animated). */
  openness: number;
  slideAxis: THREE.Vector3;
}

export interface Pickup {
  kind: 'keycard' | 'battery';
  mesh: THREE.Object3D;
  taken: boolean;
}

export interface Note {
  mesh: THREE.Mesh;
  title: string;
  body: string;
}

export interface Level {
  root: THREE.Group;
  rooms: Map<RoomId, RoomLights>;
  doors: Map<string, DoorView>;
  switches: Map<RoomId, THREE.Mesh>;
  generatorPanel: THREE.Mesh;
  generatorLamp: THREE.MeshStandardMaterial;
  pickups: Pickup[];
  notes: Note[];
  /** Canvas the control-room status monitor draws into. */
  statusScreen: { canvas: HTMLCanvasElement; texture: THREE.CanvasTexture };
  /** Meshes that block the flashlight raycast / interaction ray. */
  occluders: THREE.Object3D[];
  /** Logical lights; not in the scene. A LightPool renders the nearest ones. */
  virtualLights: THREE.PointLight[];
}

const WALL_TINT: Record<RoomId, number> = {
  control: 0xa7aca6,
  corridor: 0x9a9c94,
  lab: 0xc4c8c6,
  generator: 0x8a8576,
  medical: 0xc0c8c4,
  storage: 0x8c8a80,
  restricted: 0xd0d0cc,
};

const LIGHT_COLOR = 0xdfe9ff;

export function buildLevel(map: FacilityMap, poi: PointsOfInterest): Level {
  const root = new THREE.Group();
  const occluders: THREE.Object3D[] = [];
  const virtualLights: THREE.PointLight[] = [];

  // ---------------------------------------------------------------- materials
  const wallTex = concreteWall();
  const floorTex = floorTiles();
  const ceilTex = ceilingPanels();
  const metalTex = brushedMetal();
  const darkMetalTex = brushedMetal(77, [52, 56, 60]);

  const floorMat = new THREE.MeshStandardMaterial({ map: floorTex.map, bumpMap: floorTex.bump, bumpScale: 0.6, roughness: 0.82, metalness: 0.05 });
  const ceilMat = new THREE.MeshStandardMaterial({ map: ceilTex.map, bumpMap: ceilTex.bump, bumpScale: 0.4, roughness: 0.95 });
  const metal = new THREE.MeshStandardMaterial({ map: metalTex.map, bumpMap: metalTex.bump, bumpScale: 0.3, roughness: 0.5, metalness: 0.75 });
  const darkMetal = new THREE.MeshStandardMaterial({ map: darkMetalTex.map, roughness: 0.6, metalness: 0.7 });
  const plastic = new THREE.MeshStandardMaterial({ color: 0x2a2d30, roughness: 0.7 });
  const fabric = new THREE.MeshStandardMaterial({ color: 0x8c9a9a, roughness: 0.95 });
  const paper = new THREE.MeshStandardMaterial({ color: 0xd8d4c8, roughness: 0.95 });

  // ---------------------------------------------------------------- floors, ceilings, walls
  const floors: THREE.BufferGeometry[] = [];
  const ceilings: THREE.BufferGeometry[] = [];
  const wallsByRoom = new Map<RoomId, THREE.BufferGeometry[]>();

  for (let row = 0; row < map.height; row++) {
    for (let col = 0; col < map.width; col++) {
      if (map.isWall(col, row)) continue;
      const cx = (col + 0.5) * CELL;
      const cz = (row + 0.5) * CELL;
      const f = new THREE.PlaneGeometry(CELL, CELL).rotateX(-Math.PI / 2).translate(cx, 0, cz);
      floors.push(f);
      ceilings.push(new THREE.PlaneGeometry(CELL, CELL).rotateX(Math.PI / 2).translate(cx, CEILING, cz));
      const room = map.roomAt(col, row) ?? map.doorAt(col, row)!.rooms[0];
      const list = wallsByRoom.get(room) ?? [];
      const sides: Array<[number, number, number]> = [
        [1, 0, -Math.PI / 2],
        [-1, 0, Math.PI / 2],
        [0, 1, Math.PI],
        [0, -1, 0],
      ];
      for (const [dc, dr, rotY] of sides) {
        if (!map.isWall(col + dc, row + dr)) continue;
        const w = new THREE.PlaneGeometry(CELL, CEILING)
          .translate(0, CEILING / 2, 0)
          .rotateY(rotY)
          .translate(cx + (dc * CELL) / 2, 0, cz + (dr * CELL) / 2);
        list.push(w);
      }
      wallsByRoom.set(room, list);
    }
  }
  const floorMesh = new THREE.Mesh(mergeGeometries(floors), floorMat);
  floorMesh.receiveShadow = true;
  const ceilMesh = new THREE.Mesh(mergeGeometries(ceilings), ceilMat);
  ceilMesh.receiveShadow = true;
  root.add(floorMesh, ceilMesh);
  occluders.push(floorMesh, ceilMesh);
  for (const [room, geoms] of wallsByRoom) {
    const mat = new THREE.MeshStandardMaterial({ map: wallTex.map, bumpMap: wallTex.bump, bumpScale: 0.8, roughness: 0.9, color: WALL_TINT[room] });
    const mesh = new THREE.Mesh(mergeGeometries(geoms), mat);
    mesh.receiveShadow = true;
    mesh.castShadow = true;
    mesh.name = `walls_${room}`;
    root.add(mesh);
    occluders.push(mesh);
  }

  // ---------------------------------------------------------------- helpers
  const box = (w: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D = root, solid = true) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    m.receiveShadow = true;
    parent.add(m);
    if (solid) occluders.push(m);
    return m;
  };
  const emissive = (color: number, intensity: number) => new THREE.MeshStandardMaterial({ color: 0x111111, emissive: color, emissiveIntensity: intensity, roughness: 0.4 });

  // ---------------------------------------------------------------- lighting
  const rooms = new Map<RoomId, RoomLights>();
  for (const def of ROOMS) {
    const cells = map.cellsOfRoom(def.id);
    const fixtureMat = emissive(LIGHT_COLOR, 2.2);
    const fixtureCells = cells.filter((c) => (def.id === 'corridor' ? c.col % 3 === 1 : c.col % 3 === 1 && c.row % 2 === 0));
    for (const c of fixtureCells) {
      const p = cellToWorld(c);
      const along = def.id === 'corridor' && map.isWall(c.col, c.row - 1) && map.isWall(c.col, c.row + 1);
      box(along ? 1.3 : 0.28, 0.06, along ? 0.28 : 1.3, fixtureMat, p.x, CEILING - 0.04, p.z, root, false).castShadow = false;
    }
    // Point lights: about one per 10 cells, spread across the fixtures.
    const count = Math.max(1, Math.round(cells.length / 10));
    const lights: THREE.PointLight[] = [];
    const base: number[] = [];
    for (let i = 0; i < count; i++) {
      const c = fixtureCells[Math.floor(((i + 0.5) / count) * fixtureCells.length)] ?? cells[0];
      const p = cellToWorld(c);
      const intensity = def.id === 'corridor' ? 9 : 14;
      const l = new THREE.PointLight(LIGHT_COLOR, intensity, def.id === 'corridor' ? 9 : 11, 1.6);
      l.position.set(p.x, CEILING - 0.35, p.z);
      virtualLights.push(l);
      lights.push(l);
      base.push(intensity);
    }
    // Battery-backed red emergency lights where the simulation says they exist.
    const emergency: THREE.PointLight[] = [];
    let emergencyFixtures: THREE.MeshStandardMaterial | null = null;
    if (def.id === 'corridor' || def.id === 'control') {
      emergencyFixtures = emissive(0xff1a0a, 0.15);
      const step = def.id === 'corridor' ? 6 : 99;
      const ecells = cells.filter((c, i) => (def.id === 'corridor' ? c.row === 6 && c.col % step === 3 : i === Math.floor(cells.length / 2)));
      for (const c of ecells) {
        const p = cellToWorld(c);
        box(0.25, 0.12, 0.12, emergencyFixtures, p.x, CEILING - 0.3, p.z - CELL / 2 + 0.08, root, false);
        const l = new THREE.PointLight(0xff2010, 0, 11, 1.5);
        l.position.set(p.x, CEILING - 0.5, p.z);
        virtualLights.push(l);
        emergency.push(l);
      }
    }
    rooms.set(def.id, { room: def.id, lights, baseIntensity: base, fixtures: fixtureMat, emergency, emergencyFixtures });
  }

  // ---------------------------------------------------------------- doors
  const doors = new Map<string, DoorView>();
  for (const def of map.doors) {
    const p = cellToWorld(def.cell);
    const g = new THREE.Group();
    g.position.set(p.x, 0, p.z);
    const restricted = def.kind === 'keycard';
    const label = restricted ? 'Restricted' : ROOMS.find((r) => r.id === (def.rooms[0] === 'corridor' ? def.rooms[1] : def.rooms[0]))!.name;
    const tex = doorTexture(label, restricted);
    const slabMat = new THREE.MeshStandardMaterial({ map: tex.map, bumpMap: tex.bump, bumpScale: 0.5, roughness: 0.55, metalness: 0.6 });
    const along = def.axis === 'x';
    const slab = new THREE.Mesh(new THREE.BoxGeometry(along ? CELL : 0.1, 2.4, along ? 0.1 : CELL), slabMat);
    slab.position.y = 1.2;
    slab.castShadow = slab.receiveShadow = true;
    g.add(slab);
    // lintel above the opening
    box(along ? CELL : 0.36, CEILING - 2.4, along ? 0.36 : CELL, darkMetal, 0, 2.4 + (CEILING - 2.4) / 2, 0, g);
    // status LED + keypad on both faces
    const led = emissive(restricted ? 0xff2a1a : 0x38ff6a, 1.5);
    for (const side of [-1, 1]) {
      const off = side * 0.25;
      const lx = along ? 1.05 : off;
      const lz = along ? off : 1.05;
      const pad = box(0.14, 0.22, 0.14, plastic, lx, 1.25, lz, g, false);
      pad.castShadow = false;
      box(0.05, 0.05, 0.05, led, lx, 1.42, lz, g, false).castShadow = false;
    }
    root.add(g);
    occluders.push(slab);
    doors.set(def.id, { def, group: g, slab, led, openness: 0, slideAxis: along ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1) });
  }

  // ---------------------------------------------------------------- furniture by component
  for (const comp of components(map)) buildProp(comp);

  function buildProp(comp: { ch: string; cells: Cell[] }) {
    const xs = comp.cells.map((c) => c.col);
    const zs = comp.cells.map((c) => c.row);
    const min = { x: Math.min(...xs) * CELL, z: Math.min(...zs) * CELL };
    const max = { x: (Math.max(...xs) + 1) * CELL, z: (Math.max(...zs) + 1) * CELL };
    const w = max.x - min.x;
    const d = max.z - min.z;
    const cx = (min.x + max.x) / 2;
    const cz = (min.z + max.z) / 2;
    switch (comp.ch) {
      case 't': // storage shelving
        for (const c of comp.cells) {
          const p = cellToWorld(c);
          for (const y of [0.1, 0.8, 1.5, 2.2]) box(1.8, 0.05, 1.4, metal, p.x, y, p.z);
          for (const sx of [-0.88, 0.88]) for (const sz of [-0.68, 0.68]) box(0.05, 2.4, 0.05, darkMetal, p.x + sx, 1.2, p.z + sz);
          const crateMat = new THREE.MeshStandardMaterial({ color: 0x6b5a40, roughness: 0.9 });
          for (const y of [0.1, 0.8, 1.5]) {
            const n = 1 + ((c.col * 7 + c.row * 3 + y * 10) % 3);
            for (let i = 0; i < n; i++) box(0.45, 0.4, 0.5, crateMat, p.x - 0.6 + i * 0.6, y + 0.23, p.z + ((i % 2) - 0.5) * 0.3);
          }
        }
        break;
      case 'l': // lab bench with instruments
        box(w - 0.3, 0.06, d - 0.6, new THREE.MeshStandardMaterial({ color: 0x1d2224, roughness: 0.35, metalness: 0.2 }), cx, 0.92, cz);
        box(w - 0.4, 0.88, d - 0.8, metal, cx, 0.45, cz);
        for (let i = 0; i < Math.round(w / 1.6); i++) {
          const x = min.x + 0.8 + i * 1.6;
          box(0.5, 0.32, 0.4, plastic, x, 1.12, cz + 0.1);
          box(0.42, 0.24, 0.02, emissive(i % 2 ? 0x37d27a : 0x3fa0e0, 0.9), x, 1.14, cz + 0.31, root, false);
        }
        break;
      case 'm': // infirmary bed
        box(0.9, 0.08, 1.9, darkMetal, cx, 0.55, cz + 0.05);
        box(0.86, 0.14, 1.85, fabric, cx, 0.66, cz + 0.05);
        for (const sx of [-0.4, 0.4]) for (const sz of [-0.85, 0.95]) box(0.05, 0.55, 0.05, metal, cx + sx, 0.27, cz + sz);
        box(0.6, 0.12, 0.4, new THREE.MeshStandardMaterial({ color: 0xe8e8e4, roughness: 0.9 }), cx, 0.78, cz - 0.6);
        break;
      case 'g': // the generator
        box(w - 0.6, 2.1, d - 0.8, new THREE.MeshStandardMaterial({ map: metalTex.map, color: 0x6f7a62, roughness: 0.55, metalness: 0.7 }), cx, 1.05, cz);
        for (let i = 0; i < 5; i++) box(0.08, 1.8, d - 0.6, darkMetal, min.x + 0.7 + i * ((w - 1.4) / 4), 1.0, cz);
        box(w - 1.2, 0.5, 0.6, darkMetal, cx, 2.35, cz);
        for (const sx of [-1, 1]) {
          const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, CEILING - 2.1, 12), metal);
          pipe.position.set(cx + sx * (w / 3), 2.1 + (CEILING - 2.1) / 2, cz);
          root.add(pipe);
        }
        break;
      case 'c': // control console
        box(w - 0.2, 0.8, d - 0.6, darkMetal, cx, 0.4, cz);
        box(w - 0.1, 0.06, d - 0.4, new THREE.MeshStandardMaterial({ color: 0x23282a, roughness: 0.4 }), cx, 0.83, cz);
        break;
      case 'r': // containment chamber
        {
          const glass = new THREE.MeshPhysicalMaterial({ color: 0x9fb8c0, roughness: 0.08, metalness: 0, transmission: 0.0, transparent: true, opacity: 0.18, side: THREE.DoubleSide });
          const r = Math.min(w, d) / 2 - 0.4;
          const cyl = new THREE.Mesh(new THREE.CylinderGeometry(r, r, CEILING - 0.6, 32, 1, true), glass);
          cyl.position.set(cx, 0.3 + (CEILING - 0.6) / 2, cz);
          root.add(cyl);
          for (const y of [0.15, CEILING - 0.15]) {
            const ring = new THREE.Mesh(new THREE.CylinderGeometry(r + 0.15, r + 0.15, 0.3, 32), darkMetal);
            ring.position.set(cx, y, cz);
            ring.castShadow = ring.receiveShadow = true;
            root.add(ring);
          }
          // the experiment: a microphone array suspended inside, pointed at nothing
          for (let i = 0; i < 6; i++) {
            const a = (i / 6) * Math.PI * 2;
            box(0.06, 0.06, 0.5, plastic, cx + Math.cos(a) * 0.6, 1.9, cz + Math.sin(a) * 0.6, root, false).lookAt(cx, 1.4, cz);
          }
          // a hairline crack of light at the base
          box(r * 1.6, 0.01, 0.04, emissive(0x88aaff, 0.6), cx, 0.31, cz + 0.2, root, false).rotation.y = 0.6;
        }
        break;
    }
  }

  // ---------------------------------------------------------------- control room monitors
  const statusCanvas = document.createElement('canvas');
  statusCanvas.width = statusCanvas.height = 512;
  const statusTex = new THREE.CanvasTexture(statusCanvas);
  statusTex.colorSpace = THREE.SRGBColorSpace;
  {
    const consoleCells = map.cellsOfRoom('control').filter((c) => map.isBlocked(c.col, c.row));
    const minX = Math.min(...consoleCells.map((c) => c.col)) * CELL;
    const z = (consoleCells[0].row + 1) * CELL - 0.55;
    const screens = [
      textPanel(['CAM 01  SEC CORRIDOR', '', '  [ FEED OFFLINE ]', '', 'MAINT TICKET #4471'], { bg: '#020604', fg: '#5cff9a', glow: true }),
      textPanel(['RADIO NET  CH 1-4', '', 'DANIEL   ●', 'EMILY    ●', 'ROBERT   ●', 'LUCAS    ●', '', 'ENCRYPTION: NONE'], { bg: '#020406', fg: '#62c8ff', glow: true }),
      statusTex,
      textPanel(['SIGNAL ANALYSIS', '', 'BAND 7  ...repeat', 'BAND 7  ...repeat', 'BAND 7  ...repeat', '', 'SOURCE: SECTOR R'], { bg: '#060402', fg: '#ffb35c', glow: true }),
    ];
    screens.forEach((tex, i) => {
      const x = minX + 1.4 + i * 2.4;
      box(1.1, 0.75, 0.12, plastic, x, 1.28, z - 0.05);
      const scr = new THREE.Mesh(new THREE.PlaneGeometry(1.0, 0.66), new THREE.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: 1.1, color: 0x000000 }));
      scr.position.set(x, 1.28, z + 0.015);
      root.add(scr);
      box(0.1, 0.4, 0.1, darkMetal, x, 0.98, z - 0.1, root, false);
    });
    const glow = new THREE.PointLight(0x7fd8ff, 2.5, 4, 2);
    glow.position.set(minX + 5, 1.4, z + 0.8);
    virtualLights.push(glow);
    // radio base station + headset on the desk
    box(0.5, 0.18, 0.32, darkMetal, minX + 8.6, 0.95, z + 0.1);
    box(0.06, 0.06, 0.06, emissive(0xffa020, 1.4), minX + 8.45, 1.06, z + 0.27, root, false);
  }

  // ---------------------------------------------------------------- light switches
  const switches = new Map<RoomId, THREE.Mesh>();
  for (const [room, sw] of poi.switches) {
    const t = sw.towardDoor;
    const perp = { x: t.z, z: t.x };
    let side = 1;
    const n1 = { col: sw.cell.col + perp.x, row: sw.cell.row + perp.z };
    if (map.isWall(n1.col, n1.row)) side = -1;
    const pos = { x: sw.stand.x + perp.x * side * 1.3 + t.x * 0.97, z: sw.stand.z + perp.z * side * 1.3 + t.z * 0.97 };
    const panel = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.32, 0.22), new THREE.MeshStandardMaterial({ color: 0xb8b0a0, roughness: 0.6 }));
    panel.position.set(pos.x, 1.35, pos.z);
    panel.castShadow = true;
    root.add(panel);
    const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 0.24), emissive(0xfff0a0, 0.8));
    lamp.position.set(pos.x, 1.45, pos.z);
    root.add(lamp);
    panel.userData.lamp = lamp;
    switches.set(room, panel);
  }

  // ---------------------------------------------------------------- generator control panel
  const gp = poi.generatorPanel;
  const generatorPanel = box(1.2, 1.3, 0.35, darkMetal, gp.x, 0.65, gp.z + 0.55);
  const generatorLamp = emissive(0x3aff70, 1.6);
  box(0.12, 0.12, 0.05, generatorLamp, gp.x - 0.35, 1.15, gp.z + 0.36, root, false);
  box(0.7, 0.4, 0.02, new THREE.MeshStandardMaterial({ map: textPanel(['GEN-2  TRANSFER', 'BREAKER  RESET', 'HOLD TO PRIME'], { bg: '#2a2a24', fg: '#e8e0c0', font: 'bold 44px monospace' }), roughness: 0.7 }), gp.x + 0.1, 0.95, gp.z + 0.37, root, false);

  // ---------------------------------------------------------------- pickups (wall shelves)
  const pickups: Pickup[] = [];
  const shelfAt = (cell: Cell): Vec2 & { ry: number } => {
    const p = cellToWorld(cell);
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, -1], [0, 1]] as const) {
      if (map.isWall(cell.col + dc, cell.row + dr)) {
        const pos = { x: p.x + dc * (CELL / 2 - 0.2), z: p.z + dr * (CELL / 2 - 0.2), ry: dc !== 0 ? Math.PI / 2 : 0 };
        const shelf = box(dc !== 0 ? 0.4 : 0.8, 0.04, dc !== 0 ? 0.8 : 0.4, metal, pos.x, 1.0, pos.z);
        shelf.castShadow = true;
        return pos;
      }
    }
    return { ...p, ry: 0 };
  };
  {
    const s = shelfAt(poi.keycardCell);
    const card = new THREE.Group();
    const cardMesh = box(0.09, 0.005, 0.055, new THREE.MeshStandardMaterial({ color: 0xd8d8d0, roughness: 0.4 }), 0, 0, 0, card, false);
    box(0.09, 0.006, 0.015, emissive(0xc02010, 0.4), 0, 0.001, -0.015, card, false);
    cardMesh.castShadow = false;
    card.position.set(s.x, 1.03, s.z);
    card.rotation.y = 0.4;
    card.scale.setScalar(2);
    root.add(card);
    pickups.push({ kind: 'keycard', mesh: card, taken: false });
  }
  for (const cell of poi.batteryCells) {
    const s = shelfAt(cell);
    const g = new THREE.Group();
    for (let i = 0; i < 2; i++) {
      const b = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.13, 12), new THREE.MeshStandardMaterial({ color: 0x202020, roughness: 0.4, metalness: 0.5 }));
      b.position.set(i * 0.09 - 0.045, 0.065, 0);
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.036, 0.036, 0.03, 12), new THREE.MeshStandardMaterial({ color: 0xb08a20, metalness: 0.8, roughness: 0.3 }));
      cap.position.set(i * 0.09 - 0.045, 0.11, 0);
      g.add(b, cap);
    }
    g.position.set(s.x, 1.02, s.z);
    g.scale.setScalar(1.6);
    root.add(g);
    pickups.push({ kind: 'battery', mesh: g, taken: false });
  }

  // ---------------------------------------------------------------- notes / environmental storytelling
  const notes: Note[] = [];
  const wallNote = (cell: Cell, dir: [number, number], w: number, h: number, y: number, tex: THREE.Texture, title: string, body: string) => {
    const p = cellToWorld(cell);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85 }));
    m.position.set(p.x + dir[0] * (CELL / 2 - 0.02), y, p.z + dir[1] * (CELL / 2 - 0.02));
    m.rotation.y = Math.atan2(-dir[0], -dir[1]);
    m.receiveShadow = true;
    root.add(m);
    notes.push({ mesh: m, title, body });
    return m;
  };
  wallNote(
    { col: 13, row: 1 },
    [0, -1],
    2.4,
    1.3,
    1.6,
    textPanel(['BAND 7 CARRIER - NOT OURS', '', 'repeats our transmissions', 'delay grows each time:', '  4.1s  3.2s  1.9s  0.6s', '', 'It is catching up.  -E'], { bg: '#e8e8e2', fg: '#1a3c8a', font: 'italic 30px monospace' }),
    'Laboratory whiteboard',
    'BAND 7 CARRIER — NOT OURS.\nRepeats our transmissions. The delay shrinks each time: 4.1s, 3.2s, 1.9s, 0.6s.\n"It is catching up." — E.',
  );
  wallNote(
    { col: 25, row: 3 },
    [1, 0],
    0.5,
    0.7,
    1.5,
    textPanel(['MEMO - MEDICAL', '', 'Sector R keycard is', 'kept here per Dr. Vance.', '', 'Do NOT lend it out.', 'Not even if they ask', 'over the radio.'], { bg: '#efe9d8', fg: '#222', font: '30px monospace' }),
    'Memo pinned to the cabinet',
    'Sector R keycard is kept here per Dr. Vance.\nDo NOT lend it out. Not even if they ask over the radio.',
  );
  wallNote(
    { col: 16, row: 10 },
    [-1, 0],
    0.6,
    0.8,
    1.5,
    textPanel(['NIGHT SHIFT - RULES', '', '1. Radio check hourly', '2. Doors close on', '   their own. Let them.', '3. Every order goes', '   through CONTROL.', '4. If you hear an order', '   you did not give,', '   do not repeat it.'], { bg: '#ece6d6', fg: '#222', font: '26px monospace' }),
    'Night-shift rules',
    '1. Radio check hourly.\n2. Doors close on their own. Let them.\n3. Every order goes through CONTROL.\n4. If you hear an order you did not give, do not repeat it.',
  );

  // Restricted sector: what happened here.
  {
    const c = map.roomCenter('restricted');
    const chair = new THREE.Group();
    box(0.5, 0.06, 0.5, darkMetal, 0, 0.45, 0, chair, false);
    box(0.5, 0.5, 0.06, darkMetal, 0, 0.72, -0.22, chair, false);
    chair.position.set(c.x - 2.6, 0.25, c.z + 3.2);
    chair.rotation.set(Math.PI / 2.2, 0.7, 0);
    root.add(chair);
    for (let i = 0; i < 9; i++) {
      const sheet = new THREE.Mesh(new THREE.PlaneGeometry(0.21, 0.297), paper);
      sheet.rotation.x = -Math.PI / 2;
      sheet.rotation.z = i * 1.3;
      sheet.position.set(c.x - 2 + Math.sin(i * 2.1) * 1.6, 0.005 + i * 0.0005, c.z + 2.6 + Math.cos(i * 1.7) * 1.2);
      sheet.receiveShadow = true;
      root.add(sheet);
    }
    // a headset on the floor, cable running toward the chamber
    box(0.18, 0.08, 0.16, plastic, c.x - 1.2, 0.04, c.z + 2.4, root, false);
  }

  // Corridor pipes and security cameras: the facility's infrastructure.
  {
    const corridor = map.cellsOfRoom('corridor').filter((c) => c.row === 6);
    const x0 = Math.min(...corridor.map((c) => c.col)) * CELL;
    const x1 = (Math.max(...corridor.map((c) => c.col)) + 1) * CELL;
    for (const [z, r, y] of [[12.35, 0.09, 2.95], [12.6, 0.06, 2.8], [13.7, 0.12, 2.9]] as const) {
      const pipe = new THREE.Mesh(new THREE.CylinderGeometry(r, r, x1 - x0, 10).rotateZ(Math.PI / 2), metal);
      pipe.position.set((x0 + x1) / 2, y, z);
      pipe.castShadow = true;
      root.add(pipe);
    }
    for (const x of [x0 + 0.4, x1 - 0.4]) {
      const cam = new THREE.Group();
      box(0.3, 0.16, 0.16, plastic, 0, 0, 0, cam, false);
      box(0.03, 0.03, 0.03, emissive(0xff2010, 0.8), 0.16, 0.04, 0, cam, false);
      cam.position.set(x, 2.85, 12.6);
      cam.rotation.y = x < x1 / 2 ? 0 : Math.PI;
      cam.rotation.z = -0.35;
      root.add(cam);
    }
  }

  return {
    root,
    rooms,
    doors,
    switches,
    generatorPanel,
    generatorLamp,
    pickups,
    notes,
    statusScreen: { canvas: statusCanvas, texture: statusTex },
    occluders,
    virtualLights,
  };
}

/** Connected components of furniture characters (4-connected, same char). */
function components(map: FacilityMap): { ch: string; cells: Cell[] }[] {
  const seen = new Set<string>();
  const out: { ch: string; cells: Cell[] }[] = [];
  for (let row = 0; row < map.height; row++) {
    for (let col = 0; col < map.width; col++) {
      if (!map.isBlocked(col, row) || seen.has(`${col},${row}`)) continue;
      const ch = map.charAt(col, row);
      const cells: Cell[] = [];
      const stack: Cell[] = [{ col, row }];
      seen.add(`${col},${row}`);
      while (stack.length) {
        const c = stack.pop()!;
        cells.push(c);
        for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const n = { col: c.col + dc, row: c.row + dr };
          const k = `${n.col},${n.row}`;
          // Shelves and beds stay individual pieces; machines and benches merge.
          if (ch === 't' || ch === 'm') continue;
          if (!seen.has(k) && map.charAt(n.col, n.row) === ch) {
            seen.add(k);
            stack.push(n);
          }
        }
      }
      out.push({ ch, cells });
    }
  }
  return out;
}
