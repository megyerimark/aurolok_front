import * as THREE from 'three';
import { CEILING, cellToWorld, type RoomId } from '../sim/facility/FacilityMap';
import { doorCenter, roomName } from '../sim/facility/FacilityState';
import type { CommandId } from '../sim/npc/Commands';
import { SimWorld } from '../sim/SimWorld';
import { buildIncidentReport } from '../sim/story/IncidentReport';
import { Hud } from '../ui/Hud';
import { RadioUI } from '../ui/RadioUI';
import { AudioManager } from './AudioManager';
import { buildLevel, type DoorView, type Level } from './LevelBuilder';
import { LightPool } from './LightPool';
import { NpcView } from './NpcView';
import { PlayerController } from './PlayerController';
import { Renderer } from './Renderer';
import { dustSprite } from './textures';

interface Interactable {
  object: THREE.Object3D;
  /** Prompt text, or null when not currently usable. */
  prompt(): { text: string; key?: string; progress?: number } | null;
  /** Tap action. */
  use?(): void;
  /** Hold action, called every frame while E is held. */
  hold?(dt: number): void;
}

const INTERACT_RANGE = 2.4;

export class Game {
  readonly sim: SimWorld;
  private scene = new THREE.Scene();
  private level: Level;
  private player: PlayerController;
  private renderer: Renderer;
  private audio: AudioManager;
  private hud: Hud;
  private radio: RadioUI;
  private flashlight: THREE.SpotLight;
  private npcViews: NpcView[] = [];
  private interactables: Interactable[] = [];
  private raycaster = new THREE.Raycaster();
  private keys = new Set<string>();
  private focused: Interactable | null = null;
  private running = false;
  private ended = false;
  private readingNote = false;
  private clock = new THREE.Clock();
  private time = 0;
  private interference = 0;
  private dust!: THREE.Points;
  private lightPool: LightPool;
  private lightTargets = new Map<RoomId, { main: number; emergency: number }>();
  private powerFlicker = 0;
  private radioTick = 0;
  private statusTick = 0;

  constructor(private readonly container: HTMLElement, ui: HTMLElement) {
    const seed = Number(new URLSearchParams(location.search).get('seed')) || undefined;
    this.sim = new SimWorld({ seed });
    const sim = this.sim;

    this.scene.background = new THREE.Color(0x020304);
    this.scene.fog = new THREE.FogExp2(0x030405, 0.055);
    this.scene.add(new THREE.HemisphereLight(0x3a4250, 0x0a0806, 0.12));

    this.level = buildLevel(sim.map, sim.poi);
    this.scene.add(this.level.root);
    this.lightPool = new LightPool(this.scene, this.level.virtualLights, 8);

    this.player = new PlayerController(sim.map, (c, r) => this.doorClosedAt(c, r), sim.poi.playerStart, window.innerWidth / window.innerHeight);
    this.player.yaw = 0; // facing north, toward the monitors
    this.scene.add(this.player.camera);

    this.flashlight = new THREE.SpotLight(0xfff4e2, 0, 22, 0.42, 0.55, 1.5);
    this.flashlight.castShadow = true;
    this.flashlight.shadow.mapSize.set(1024, 1024);
    this.flashlight.shadow.camera.near = 0.1;
    this.flashlight.shadow.bias = -0.0008;
    this.flashlight.position.set(0.18, -0.15, 0.1);
    this.flashlight.target.position.set(0.05, -0.2, -4);
    this.player.camera.add(this.flashlight, this.flashlight.target);

    for (const npc of sim.npcs) {
      const v = new NpcView(npc);
      this.npcViews.push(v);
      this.scene.add(v.root);
    }

    this.buildDust();
    this.renderer = new Renderer(container, this.scene, this.player.camera);
    this.audio = new AudioManager();
    this.hud = new Hud(ui);
    this.radio = new RadioUI(ui, sim);
    this.radio.onTransmit = (to, cmd) => this.transmit(to, cmd);

    this.registerInteractables();
    this.wireSimEvents();
    this.wireInput();
    for (const room of this.level.rooms.keys()) this.updateLightTarget(room);
    this.hud.setInventory(sim.player.charge, sim.player.batteries, sim.player.hasKeycard);
    this.drawStatusScreen();

    this.hud.showTitle(() => this.begin());
    (window as unknown as { __game: Game }).__game = this;
    this.loop();
  }

  // ------------------------------------------------------------------ lifecycle

  private begin(): void {
    this.hud.hideOverlay();
    this.audio.resume();
    this.audio.startAmbience(this.sim.map.roomCenter('generator'));
    this.running = true;
    this.lockPointer();
    this.hud.setObjective(this.sim.story.objective);
    this.player.onStep = (i) => this.audio.play('sfx.footstep', { intensity: i, gain: 0.8 });
  }

  private lockPointer(): void {
    const canvas = this.renderer.gl.domElement;
    try {
      const p = canvas.requestPointerLock() as unknown as Promise<void> | undefined;
      p?.catch?.(() => {});
    } catch {
      /* headless / unsupported */
    }
  }

  private loop = (): void => {
    requestAnimationFrame(this.loop);
    const dt = Math.min(this.clock.getDelta(), 0.05);
    this.time += dt;
    if (this.running && !this.ended && !this.hud.overlayOpen) this.update(dt);
    this.updateVisuals(dt);
    this.renderer.draw(this.time);
  };

  private update(dt: number): void {
    const sim = this.sim;
    const k = this.keys;
    this.player.update(dt, {
      forward: (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0),
      right: (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0),
      sprint: k.has('ShiftLeft') || k.has('ShiftRight'),
      crouch: k.has('ControlLeft') || k.has('KeyC'),
    });
    sim.player.pos = this.player.position;
    sim.player.room = sim.map.roomAtWorld(sim.player.pos);
    sim.update(dt);

    // Interaction
    this.focused = this.pickInteractable();
    const prompt = this.focused?.prompt() ?? null;
    this.hud.setPrompt(prompt?.text ?? null, prompt?.key ?? 'E', prompt?.progress);
    if (this.focused?.hold && k.has('KeyE')) this.focused.hold(dt);

    // Breathing when out of stamina
    this.audio.setBreathing(Math.max(0, 0.6 - this.player.stamina) * 1.6);
    this.audio.updateListener(this.player.camera);

    this.radioTick -= dt;
    if (this.radioTick <= 0) {
      this.radioTick = 0.25;
      this.radio.render();
      this.hud.setInventory(sim.player.charge, sim.player.batteries, sim.player.hasKeycard);
    }
    this.statusTick -= dt;
    if (this.statusTick <= 0) {
      this.statusTick = 2;
      this.drawStatusScreen();
    }
  }

  // ------------------------------------------------------------------ visuals

  private updateVisuals(dt: number): void {
    const sim = this.sim;
    // Doors
    for (const view of this.level.doors.values()) this.syncDoor(view, dt);

    // Room lights: lerp toward targets, plus flicker.
    this.powerFlicker = Math.max(0, this.powerFlicker - dt);
    for (const [room, rl] of this.level.rooms) {
      const target = this.lightTargets.get(room)!;
      let main = target.main;
      if (this.powerFlicker > 0) main = Math.random() < 0.5 ? 1 : 0.05;
      rl.lights.forEach((l, i) => {
        let want = rl.baseIntensity[i] * main;
        // one failing tube in the corridor, always
        if (room === 'corridor' && i === 1 && main > 0.5 && Math.sin(this.time * 7.3) + Math.sin(this.time * 2.1) > 1.6) want *= 0.15;
        l.intensity += (want - l.intensity) * Math.min(1, dt * (main > 0.5 ? 12 : 20));
      });
      rl.fixtures.emissiveIntensity = 2.2 * (rl.lights[0].intensity / Math.max(0.001, rl.baseIntensity[0]));
      for (const e of rl.emergency) {
        const pulse = 0.75 + 0.25 * Math.sin(this.time * 2.4);
        e.intensity += (target.emergency * 7 * pulse - e.intensity) * Math.min(1, dt * 4);
      }
      if (rl.emergencyFixtures) rl.emergencyFixtures.emissiveIntensity = 0.15 + target.emergency * 3 * (0.75 + 0.25 * Math.sin(this.time * 2.4));
    }
    for (const [room, panel] of this.level.switches) {
      const lamp = panel.userData.lamp as THREE.Mesh;
      (lamp.material as THREE.MeshStandardMaterial).emissiveIntensity = sim.facility.generatorOnline && sim.facility.lightSwitch.get(room) ? 0.9 : 0.05;
    }
    this.level.generatorLamp.emissive.set(sim.facility.generatorOnline ? 0x3aff70 : 0xff2a10);
    this.level.generatorLamp.emissiveIntensity = sim.facility.generatorOnline ? 1.6 : Math.sin(this.time * 8) > 0 ? 2.5 : 0.1;

    // Flashlight
    const p = sim.player;
    let fl = p.flashlightOn ? 38 * (0.35 + 0.65 * Math.min(1, p.charge * 2.5)) : 0;
    if (p.flashlightOn && p.charge < 0.15 && Math.random() < 0.08) fl *= 0.2;
    this.flashlight.intensity += (fl - this.flashlight.intensity) * Math.min(1, dt * 25);

    // NPCs
    for (const v of this.npcViews) v.sync(dt, 1 - sim.facility.lightLevel(v.agent.room));

    // Dust drifts around the camera
    const pos = this.dust.geometry.attributes.position as THREE.BufferAttribute;
    const cam = this.player.camera.position;
    for (let i = 0; i < pos.count; i++) {
      let x = pos.getX(i) + Math.sin(this.time * 0.3 + i) * dt * 0.05;
      let y = pos.getY(i) - dt * 0.02;
      let z = pos.getZ(i) + Math.cos(this.time * 0.2 + i * 0.7) * dt * 0.05;
      if (x - cam.x > 5) x -= 10;
      if (cam.x - x > 5) x += 10;
      if (z - cam.z > 5) z -= 10;
      if (cam.z - z > 5) z += 10;
      if (y < 0.1) y = CEILING - 0.1;
      pos.setXYZ(i, x, y, z);
    }
    pos.needsUpdate = true;
    (this.dust.material as THREE.PointsMaterial).opacity = 0.18 + (p.flashlightOn ? 0.25 : 0);

    // Interference: pulses from static + the restricted sector's baseline.
    const base = (1 - sim.radio.signalFor(p.room)) * 0.25;
    this.interference = Math.max(base, this.interference - dt * 0.5);
    this.renderer.interference = this.interference;
    this.lightPool.update(this.player.camera);
  }

  private syncDoor(view: DoorView, dt: number): void {
    const st = this.sim.facility.doors.get(view.def.id)!;
    const target = st.open ? 1 : 0;
    const speed = 1.6;
    view.openness += Math.sign(target - view.openness) * Math.min(Math.abs(target - view.openness), dt * speed);
    const e = view.openness * view.openness * (3 - 2 * view.openness);
    view.slab.position.copy(view.slideAxis).multiplyScalar(e * 1.95);
    view.slab.position.y = 1.2;
    view.led.emissive.set(st.locked ? 0xff2a1a : st.open ? 0xffc040 : 0x38ff6a);
  }

  private doorClosedAt(col: number, row: number): boolean {
    const def = this.sim.map.doorAt(col, row);
    if (!def) return false;
    const view = this.level.doors.get(def.id)!;
    return view.openness < 0.8;
  }

  private updateLightTarget(room: RoomId): void {
    const mode = this.sim.facility.lightMode(room);
    this.lightTargets.set(room, { main: mode === 'on' ? 1 : 0, emergency: mode === 'emergency' ? 1 : 0 });
  }

  private buildDust(): void {
    const n = 380;
    const g = new THREE.BufferGeometry();
    const arr = new Float32Array(n * 3);
    const c = this.sim.poi.playerStart;
    for (let i = 0; i < n; i++) {
      arr[i * 3] = c.x + (Math.random() - 0.5) * 10;
      arr[i * 3 + 1] = Math.random() * CEILING;
      arr[i * 3 + 2] = c.z + (Math.random() - 0.5) * 10;
    }
    g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    const m = new THREE.PointsMaterial({ map: dustSprite(), size: 0.035, transparent: true, opacity: 0.2, depthWrite: false, blending: THREE.AdditiveBlending, color: 0xd8d0c0 });
    this.dust = new THREE.Points(g, m);
    this.dust.frustumCulled = false;
    this.scene.add(this.dust);
  }

  private drawStatusScreen(): void {
    const { canvas, texture } = this.level.statusScreen;
    const ctx = canvas.getContext('2d')!;
    const s = this.sim;
    const on = s.facility.generatorOnline;
    ctx.fillStyle = '#020604';
    ctx.fillRect(0, 0, 512, 512);
    ctx.font = '28px monospace';
    ctx.shadowBlur = 8;
    const line = (t: string, y: number, c = '#5cff9a') => {
      ctx.fillStyle = c;
      ctx.shadowColor = c;
      ctx.fillText(t, 24, y);
    };
    line('FACILITY STATUS', 48);
    line(`POWER     ${on ? 'ONLINE' : 'FAILURE'}`, 112, on ? '#5cff9a' : '#ff4a3a');
    if (!on) line(`GEN-2     ${Math.round(s.facility.repairProgress * 100)}% PRIMED`, 152, '#ffb35c');
    const r = s.facility.doors.get('door_corridor_restricted')!;
    line(`SECTOR R  ${r.locked ? 'SEALED' : 'OPEN'}`, 202, r.locked ? '#5cff9a' : '#ff4a3a');
    line(`PERSONNEL ${s.npcs.filter((n) => n.alive).length}/4`, 252);
    const t = Math.floor(s.time);
    line(`SHIFT     02:${String(14 + Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`, 302);
    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    for (let y = 0; y < 512; y += 4) ctx.fillRect(0, y, 512, 2);
    texture.needsUpdate = true;
  }

  // ------------------------------------------------------------------ radio

  private transmit(to: string, cmd: CommandId): void {
    this.audio.play('radio.squelch', { open: true });
    this.sim.transmit(to, cmd);
    setTimeout(() => this.audio.play('radio.squelch', { open: false }), 450);
  }

  // ------------------------------------------------------------------ sim events -> presentation

  private wireSimEvents(): void {
    const bus = this.sim.bus;
    bus.on('doorChanged', (e) => {
      const def = this.sim.facility.doors.get(e.doorId)!.def;
      this.audio.play('sfx.door', { pos: doorCenter(def), open: e.open, gain: 0.9 });
    });
    bus.on('doorDenied', (e) => {
      const def = this.sim.facility.doors.get(e.doorId)!.def;
      this.audio.play('sfx.door_denied', { pos: doorCenter(def) });
      if (e.by === 'player') this.hud.toast(e.reason === 'keycard' ? 'SECTOR R · KEYCARD REQUIRED' : 'LOCKED');
    });
    bus.on('lightsChanged', (e) => this.updateLightTarget(e.room));
    bus.on('powerChanged', (e) => {
      if (!e.online) this.powerFlicker = 1.1;
      this.audio.setPower(e.online);
      this.drawStatusScreen();
    });
    bus.on('noise', (n) => {
      if (!n.source.startsWith('facility:') && n.source !== 'generator') return;
      const cue = n.source === 'facility:pipes' ? 'sfx.pipes' : n.source === 'facility:vent' ? 'sfx.vent' : 'sfx.impact_metal';
      this.audio.play(cue, { pos: n.pos, y: CEILING - 0.4, gain: n.loudness });
    });
    bus.on('radioMessage', (m) => {
      this.radio.receive(m);
      if (m.from === 'player') return;
      const npc = this.sim.npcs.find((n) => n.id === m.from);
      const name = npc?.name ?? (m.from === 'unknown' ? '???' : m.from);
      const color = npc?.p.color ?? '#ff5a46';
      this.hud.subtitle(m, name, color);
      if (m.status === 'unknown') {
        this.audio.play('radio.unknown', { duration: 3.2 });
        this.interference = 1;
      } else {
        this.audio.play('radio.squelch', { open: true, gain: 0.7 });
        this.audio.play('radio.voice_bed', { duration: 0.4 + m.text.length * 0.045 });
      }
    });
    bus.on('radioStatic', (e) => {
      this.audio.play('radio.static', { intensity: e.intensity, duration: e.duration });
      this.interference = Math.max(this.interference, e.intensity * 0.8);
    });
    bus.on('objectiveChanged', (e) => {
      if (this.running) this.hud.setObjective(e.text);
    });
    bus.on('shiftEnded', (e) => {
      this.ended = true;
      document.exitPointerLock?.();
      setTimeout(() => this.hud.showReport(buildIncidentReport(this.sim), e.reason, () => location.reload()), 1200);
    });
  }

  // ------------------------------------------------------------------ interaction

  private registerInteractables(): void {
    const sim = this.sim;
    const L = this.level;
    for (const view of L.doors.values()) {
      this.interactables.push({
        object: view.slab,
        prompt: () => {
          const st = sim.facility.doors.get(view.def.id)!;
          if (st.locked) return { text: sim.player.hasKeycard ? 'Swipe keycard' : 'Keycard required' };
          return { text: st.open ? 'Close door' : 'Open door' };
        },
        use: () => {
          const st = sim.facility.doors.get(view.def.id)!;
          sim.facility.setDoor(view.def.id, !st.open, 'player', sim.player.hasKeycard);
        },
      });
    }
    for (const [room, panel] of L.switches) {
      this.interactables.push({
        object: panel,
        prompt: () => ({ text: `${sim.facility.lightSwitch.get(room) ? 'Lights off' : 'Lights on'} · ${roomName(room)}` }),
        use: () => {
          sim.facility.setLights(room, !sim.facility.lightSwitch.get(room), 'player');
          this.audio.play('sfx.switch', { pos: { x: panel.position.x, z: panel.position.z } });
        },
      });
    }
    this.interactables.push({
      object: L.generatorPanel,
      prompt: () =>
        sim.facility.generatorOnline
          ? { text: 'GEN-2 running', key: '' }
          : { text: 'Hold to prime generator', progress: sim.facility.repairProgress },
      hold: (dt) => {
        if (sim.playerRepair(dt)) this.hud.toast('POWER RESTORED');
      },
    });
    for (const pk of L.pickups) {
      this.interactables.push({
        object: pk.mesh,
        prompt: () => (pk.taken ? null : { text: pk.kind === 'keycard' ? 'Take Sector R keycard' : 'Take batteries' }),
        use: () => {
          if (pk.taken) return;
          pk.taken = true;
          pk.mesh.visible = false;
          if (pk.kind === 'keycard') {
            sim.player.hasKeycard = true;
            sim.history.record({ time: sim.time, category: 'story', actor: 'player', text: 'You took the Sector R keycard from the Medical Room.' });
            this.hud.toast('SECTOR R KEYCARD');
          } else {
            sim.player.batteries += 2;
            this.hud.toast('+2 BATTERIES');
          }
          this.audio.play('sfx.pickup');
        },
      });
    }
    for (const note of L.notes) {
      this.interactables.push({
        object: note.mesh,
        prompt: () => ({ text: `Read · ${note.title}` }),
        use: () => {
          this.readingNote = true;
          this.hud.showNote(note.title, note.body);
        },
      });
    }
    // Talking face to face: no radio, no interference, no doubt about who is speaking.
    for (const v of this.npcViews) {
      this.interactables.push({
        object: v.root,
        prompt: () => {
          const a = v.agent;
          if (!a.alive) return null;
          return { text: `${a.name} · ${a.p.role} — "Come with me"` };
        },
        use: () => sim.speak(v.agent.id, 'follow'),
      });
    }
  }

  private pickInteractable(): Interactable | null {
    this.raycaster.setFromCamera(new THREE.Vector2(0, 0), this.player.camera);
    this.raycaster.far = INTERACT_RANGE;
    const targets = [...this.level.occluders, ...this.interactables.map((i) => i.object)];
    const hits = this.raycaster.intersectObjects(targets, true);
    for (const h of hits) {
      let o: THREE.Object3D | null = h.object;
      while (o) {
        const found = this.interactables.find((i) => i.object === o);
        if (found) return found.object.visible ? found : null;
        o = o.parent;
      }
      // first hit is a wall/occluder that is not interactable: nothing in reach
      if (this.level.occluders.includes(h.object)) return null;
    }
    return null;
  }

  // ------------------------------------------------------------------ input

  private wireInput(): void {
    const canvas = this.renderer.gl.domElement;
    canvas.addEventListener('click', () => {
      if (this.running && !this.ended && !document.pointerLockElement) this.lockPointer();
    });
    document.addEventListener('pointerlockchange', () => {
      if (!document.pointerLockElement && this.running && !this.ended && !this.readingNote) {
        this.keys.clear();
        this.hud.showPause(() => {
          this.hud.hideOverlay();
          this.lockPointer();
        });
      }
    });
    document.addEventListener('mousemove', (e) => {
      if (document.pointerLockElement && !this.hud.overlayOpen) this.player.look(e.movementX, e.movementY);
    });
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Tab') e.preventDefault();
      if (!this.running || this.ended) return;
      if (this.readingNote) {
        if (e.code === 'KeyE' || e.code === 'Escape') {
          this.readingNote = false;
          this.hud.hideOverlay();
          if (!document.pointerLockElement) this.lockPointer();
        }
        return;
      }
      if (this.hud.overlayOpen) return;
      if (e.repeat) return;
      this.keys.add(e.code);
      const sim = this.sim;
      switch (e.code) {
        case 'KeyF':
          if (sim.player.charge > 0) {
            sim.player.flashlightOn = !sim.player.flashlightOn;
            this.audio.play('sfx.flashlight');
          }
          break;
        case 'KeyB':
          if (sim.player.reload()) {
            this.hud.toast('BATTERY SWAPPED');
            this.audio.play('sfx.pickup');
          }
          break;
        case 'KeyR':
          this.radio.toggle();
          this.audio.play('radio.squelch', { open: this.radio.open, gain: 0.4 });
          break;
        case 'KeyQ':
        case 'Tab':
          if (this.radio.open) {
            this.radio.cycle();
            this.audio.play('sfx.switch', { gain: 0.3 });
          }
          break;
        case 'KeyE':
          this.focused?.use?.();
          break;
        default:
          if (/^Digit[1-9]$/.test(e.code)) this.radio.press(Number(e.code.slice(5)));
      }
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  /** Test hook: start without a click (used by the smoke test). */
  debugBegin(): void {
    if (!this.running) this.begin();
  }

  /** Test hook: teleport + face a direction. */
  debugPlace(col: number, row: number, yaw: number, pitch = 0): void {
    const p = cellToWorld({ col, row });
    this.player.camera.position.set(p.x, 1.62, p.z);
    this.player.yaw = yaw;
    this.player.pitch = pitch;
    this.player.update(0, { forward: 0, right: 0, sprint: false, crouch: false });
  }

  /** Test hook: advance the simulation by fixed steps, independent of frame rate. */
  debugAdvance(seconds: number): void {
    for (let t = 0; t < seconds; t += 0.05) this.sim.update(0.05);
  }

  get containerElement(): HTMLElement {
    return this.container;
  }
}
