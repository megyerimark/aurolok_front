import type { EventBus } from '../../core/EventBus';
import type { EventHistory } from '../../core/EventHistory';
import type { Rng } from '../../core/Rng';
import { dist, worldToCell, type DoorDef, type FacilityMap, type RoomId, type Vec2 } from '../facility/FacilityMap';
import { roomName, type FacilityState, type Noise } from '../facility/FacilityState';
import type { PointsOfInterest } from '../facility/PointsOfInterest';
import type { RadioStatus, RadioSystem } from '../radio/RadioSystem';
import type { SimEvents } from '../SimEvents';
import { command, type CommandDef, type CommandId } from './Commands';
import type { DialogueSelector } from './Dialogue';
import { interpret, type Decision, type InterpretContext } from './Interpreter';
import type { Personality } from './Personality';

export type NpcStateName =
  | 'Idle'
  | 'Following'
  | 'MovingToLocation'
  | 'PerformingTask'
  | 'Investigating'
  | 'Hiding'
  | 'Panicking'
  | 'Injured'
  | 'Suspicious'
  | 'Communicating'
  | 'Dead';

/** What the agent needs from the world. SimWorld implements this. */
export interface NpcWorld {
  readonly map: FacilityMap;
  readonly poi: PointsOfInterest;
  readonly facility: FacilityState;
  readonly radio: RadioSystem;
  readonly dialogue: DialogueSelector;
  readonly history: EventHistory;
  readonly bus: EventBus<SimEvents>;
  readonly rng: Rng;
  readonly time: number;
  readonly player: { pos: Vec2; room: RoomId | undefined };
  readonly npcs: readonly NpcAgent[];
}

export interface Memory {
  time: number;
  kind: 'noise' | 'dark' | 'panic' | 'order' | 'refused' | 'misread' | 'power' | 'contradiction';
  text: string;
  room?: RoomId;
}

type ArrivalAction = 'arrive' | 'repair' | 'lights_off' | 'investigate' | 'hide' | 'none';

interface Task {
  /** Instruction as given. */
  command: CommandId | 'self';
  /** Instruction as understood. */
  acted: CommandId | 'self';
  issuedBy: 'player' | 'self';
  target?: Vec2;
  targetRoom?: RoomId;
  onArrive: ArrivalAction;
  /** For lights_off: which room's lights. */
  lightsRoom?: RoomId;
  progress: number;
}

const WALK = 1.45;
const RUN = 3.4;
const FOLLOW_GAP = 2.2;
const DOOR_OPEN_TIME = 0.6;
const QUESTION_TIMEOUT = 20;
const INSIST_WINDOW = 25;
const CONTRADICT_WINDOW = 12;

/**
 * One employee. A finite state machine whose transitions are chosen by
 * utility scores (Interpreter for instructions, `autonomy()` for self-driven
 * behaviour). Everything an NPC does is recorded with a reason.
 */
export class NpcAgent {
  readonly id: string;
  readonly name: string;
  pos: Vec2;
  heading = 0;
  /** Current speed in m/s, for animation. */
  speed = 0;
  state: NpcStateName = 'Idle';
  fear: number;
  stress = 0;
  trust: number;
  readonly memory: Memory[] = [];
  task: Task | null = null;
  /** "Do not open the door" restriction, if active. */
  noDoors: { since: number } | null = null;
  holdPos: Vec2 | null = null;

  private path: Vec2[] = [];
  private pathIdx = 0;
  private waitTimer = 0;
  private repathTimer = 0;
  private autonomyTimer = 2;
  private lastOrder: { cmd: CommandId; time: number } | null = null;
  private questioned: { cmd: CommandId; time: number; resume: NpcStateName } | null = null;
  private lastSpoke = -99;
  private lastNoiseRemark = -99;
  private blockedReported = false;
  private panicStartedAt = 0;
  private recoveredAt = -99;
  /** A player-issued task interrupted by panic; obedient people go back to it. */
  private interrupted: { given: CommandId; acted: CommandId } | null = null;

  constructor(
    readonly p: Personality,
    private readonly world: NpcWorld,
    start: Vec2,
  ) {
    this.id = p.id;
    this.name = p.name;
    this.pos = { ...start };
    this.fear = p.initialFear;
    this.trust = p.initialTrust;
    world.bus.on('noise', (n) => this.hear(n));
    world.bus.on('powerChanged', (e) => this.onPower(e.online));
  }

  get room(): RoomId | undefined {
    return this.world.map.roomAtWorld(this.pos);
  }

  get alive(): boolean {
    return this.state !== 'Dead';
  }

  /** Badge telemetry shown on the radio. */
  get heartRate(): number {
    if (!this.alive) return 0;
    return Math.round(64 + this.fear * 82 + this.stress * 18 + (this.speed > 2 ? 22 : 0));
  }

  get panicThreshold(): number {
    const holding = this.task?.acted === 'stay' ? this.p.literalness * 0.15 : 0;
    // Right after a panic the adrenaline is spent: it takes more to tip them over again.
    const crash = this.world.time - this.recoveredAt < 45 ? 0.15 : 0;
    return 0.5 + this.p.courage * 0.4 + holding + crash;
  }

  /** Short description of what they are doing, for the radio status panel. */
  get activity(): string {
    switch (this.state) {
      case 'Following':
        return 'Following you';
      case 'MovingToLocation':
        return this.task?.targetRoom ? `Moving to ${roomName(this.task.targetRoom)}` : 'Moving';
      case 'PerformingTask':
        return `Repairing (${Math.round(this.world.facility.repairProgress * 100)}%)`;
      case 'Investigating':
        return 'Investigating';
      case 'Hiding':
        return 'Unknown'; // the badge does not know they are hiding
      case 'Panicking':
        return 'Running';
      case 'Suspicious':
        return 'Awaiting confirmation';
      case 'Dead':
        return 'Signal lost';
      default:
        return this.task?.acted === 'stay' ? 'Holding position' : 'Idle';
    }
  }

  // ---------------------------------------------------------------- orders

  /** An instruction arrives over the radio (after latency). */
  receive(cmdId: CommandId, signal: number, authentic = true): void {
    if (!this.alive) return;
    const w = this.world;
    const cmd = command(cmdId);

    if (this.state === 'Panicking') {
      this.reply('...[heavy breathing]...', 'no_response', signal);
      w.history.record({ time: w.time, category: 'response', actor: this.id, text: `${this.name} did not answer "${cmd.phrase}" while panicking.`, danger: 0.5 });
      return;
    }

    const ctx = this.buildContext(cmd, signal);
    const decision = interpret(this.p, cmd, ctx, w.rng);

    // Remember the order for insistence / contradiction checks.
    if (ctx.contradicts) {
      this.stress = clamp01(this.stress + 0.08);
      this.trust = clamp01(this.trust - 0.03);
      this.remember('contradiction', `Got contradictory orders: ${this.lastOrder?.cmd} then ${cmdId}`);
    }
    if (cmdId !== 'status') this.lastOrder = { cmd: cmdId, time: w.time };
    this.remember('order', `Ordered: ${cmd.phrase}${authentic ? '' : ' (not from control)'}`);

    this.recordDecision(cmd, decision, ctx);
    const delay = w.rng.range(0.8, 1.8) + (decision.kind === 'hesitate' ? 0.6 : 0);
    w.radio.later(delay, () => this.respond(cmd, decision, signal));
  }

  private buildContext(cmd: CommandDef, signal: number): InterpretContext {
    const w = this.world;
    const targetRoom = this.targetRoomFor(cmd.id);
    let risk = this.riskOf(targetRoom);
    if (this.state === 'Hiding' && cmd.id !== 'stay') risk = clamp01(risk + 0.35);
    const sinceLast = this.lastOrder ? w.time - this.lastOrder.time : Infinity;
    const insisted =
      (this.lastOrder?.cmd === cmd.id && sinceLast < INSIST_WINDOW) ||
      (this.questioned?.cmd === cmd.id && w.time - this.questioned.time < QUESTION_TIMEOUT);
    const contradicts = cmd.id !== 'status' && !!this.lastOrder && this.lastOrder.cmd !== cmd.id && sinceLast < CONTRADICT_WINDOW;
    const noise = this.freshNoise(15);
    return {
      fear: this.fear,
      stress: this.stress,
      trust: this.trust,
      signal,
      targetRisk: risk,
      insisted,
      contradicts,
      stimulus: noise ? clamp01(noise.loudness * (1 - (w.time - noise.time) / 15)) : 0,
      alreadyDone:
        (cmd.id === 'goto_generator' && this.room === 'generator') ||
        (cmd.id === 'return_control' && this.room === 'control') ||
        (cmd.id === 'stay' && this.speed < 0.1),
    };
  }

  private respond(cmd: CommandDef, d: Decision, signal: number): void {
    if (!this.alive || this.state === 'Panicking') return;
    const w = this.world;
    const vars = { room: this.roomLabel() };

    if (cmd.id === 'status') {
      this.reply(w.dialogue.line(this.id, this.statusKey(), vars), 'report', signal);
      return;
    }

    switch (d.kind) {
      case 'comply': {
        const key = cmd.id === 'stay' && this.speed < 0.1 && this.task?.acted === 'stay' ? 'already.stay' : `accept.${cmd.id}`;
        this.reply(w.dialogue.line(this.id, key, vars), 'accepted', signal);
        this.questioned = null;
        this.execute(cmd.id, cmd.id, 'player');
        break;
      }
      case 'hesitate': {
        this.reply(w.dialogue.line(this.id, 'hesitate', vars), 'hesitant', signal);
        this.questioned = null;
        w.radio.later(w.rng.range(2.5, 4.5), () => {
          if (this.state === 'Panicking' || !this.alive) return;
          this.reply(w.dialogue.line(this.id, `accept.${cmd.id}`, vars), 'accepted', signal);
          this.execute(cmd.id, cmd.id, 'player');
        });
        break;
      }
      case 'question': {
        this.reply(w.dialogue.line(this.id, 'question', vars), 'questioned', signal);
        this.questioned = { cmd: cmd.id, time: w.time, resume: this.state };
        this.halt();
        this.setState('Suspicious');
        break;
      }
      case 'misread': {
        // They believe they understood: the acknowledgement sounds normal.
        this.reply(w.dialogue.line(this.id, `accept.${d.actedCommand}`, vars), 'accepted', signal);
        this.questioned = null;
        this.remember('misread', `Misread "${cmd.phrase}" as ${d.actedCommand}`);
        this.execute(cmd.id, d.actedCommand, 'player', true);
        break;
      }
      case 'independent': {
        this.reply(w.dialogue.line(this.id, 'independent', vars), 'independent', signal);
        const noise = this.freshNoise(30);
        if (noise) this.investigate(noise, 'self');
        break;
      }
      case 'refuse': {
        this.reply(w.dialogue.line(this.id, 'refuse', vars), 'refused', signal);
        this.remember('refused', `Refused: ${cmd.phrase}`);
        break;
      }
    }
  }

  /** Starts carrying out an instruction (as understood). */
  private execute(given: CommandId, acted: CommandId, by: 'player' | 'self', misread = false): void {
    const w = this.world;
    this.holdPos = null;
    this.blockedReported = false;
    if (acted !== 'dont_open_door' && acted !== 'status') this.task = null;

    switch (acted) {
      case 'follow':
        this.task = { command: given, acted, issuedBy: by, onArrive: 'none', progress: 0 };
        this.setState('Following');
        this.repathTimer = 0;
        break;
      case 'stay':
        this.halt();
        this.holdPos = { ...this.pos };
        this.task = { command: given, acted, issuedBy: by, onArrive: 'none', progress: 0 };
        this.setState('Idle');
        break;
      case 'goto_generator':
        this.moveTo(w.map.standSpot('generator', w.poi.generatorPanel), { command: given, acted, issuedBy: by, targetRoom: 'generator', onArrive: 'arrive', progress: 0 });
        break;
      case 'repair_power':
        this.moveTo(w.poi.generatorPanel, { command: given, acted, issuedBy: by, targetRoom: 'generator', onArrive: 'repair', progress: 0 });
        break;
      case 'return_control':
        this.moveTo(w.map.standSpot('control', { x: 40, z: 17 }), { command: given, acted, issuedBy: by, targetRoom: 'control', onArrive: 'arrive', progress: 0 });
        break;
      case 'dont_open_door':
        this.noDoors = { since: w.time };
        if (misread) {
          // Heard as "don't leave": stop where they are.
          this.execute(given, 'stay', by);
        }
        break;
      case 'lights_off': {
        // Correct reading: the lights where *they* are. Misreading: the lights where *you* are.
        const room = misread ? (w.player.room ?? 'control') : (this.room ?? 'corridor');
        const sw = w.poi.switches.get(room)!;
        this.moveTo(sw.stand, { command: given, acted, issuedBy: by, targetRoom: room, lightsRoom: room, onArrive: 'lights_off', progress: 0 });
        if (misread) {
          w.history.record({ time: w.time, category: 'response', actor: this.id, text: `${this.name} took "Turn off the lights" to mean the lights in the ${roomName(room)} and headed there.`, danger: 0.3, tags: ['misread'] });
        }
        break;
      }
      case 'investigate_noise': {
        const noises = w.facility.noises.filter((n) => w.time - n.time < 60 && !n.source.endsWith(`:${this.id}`));
        // Misreading picks an older noise than the one you meant.
        const target = misread && noises.length > 1 ? noises[0] : noises[noises.length - 1];
        if (!target) {
          this.reply('What noise? I didn\'t hear anything.', 'report', this.signal());
          break;
        }
        this.investigate(target, by, given);
        break;
      }
      case 'status':
        break;
    }
  }

  private investigate(noise: Noise, by: 'player' | 'self', given: CommandId | 'self' = 'self'): void {
    const room = this.world.map.roomAtWorld(noise.pos);
    const target = room && this.world.map.isBlocked(worldToCell(noise.pos).col, worldToCell(noise.pos).row) ? this.world.map.standSpot(room, noise.pos) : noise.pos;
    this.moveTo(target, { command: given, acted: 'investigate_noise', issuedBy: by, targetRoom: room, onArrive: 'investigate', progress: 0 });
    if (this.state === 'MovingToLocation') this.setState('Investigating');
  }

  // ---------------------------------------------------------------- update

  update(dt: number): void {
    if (!this.alive) return;
    this.updateEmotion(dt);
    this.expireRestrictions();

    if (this.waitTimer > 0) {
      this.waitTimer -= dt;
      this.speed = 0;
      return;
    }

    switch (this.state) {
      case 'Following':
        this.updateFollow(dt);
        break;
      case 'MovingToLocation':
      case 'Investigating':
      case 'Panicking':
        this.walkPath(dt);
        break;
      case 'PerformingTask':
        this.updateTask(dt);
        break;
      case 'Hiding':
        this.speed = 0;
        if (this.fear < 0.25) this.recover();
        break;
      case 'Suspicious':
        this.speed = 0;
        if (this.questioned && this.world.time - this.questioned.time > QUESTION_TIMEOUT) {
          this.questioned = null;
          this.trust = clamp01(this.trust - 0.05);
          this.setState('Idle');
        }
        break;
      case 'Idle':
        this.speed = 0;
        this.autonomyTimer -= dt;
        if (this.autonomyTimer <= 0) {
          this.autonomyTimer = 2.5;
          this.autonomy();
        }
        break;
      default:
        this.speed = 0;
    }

    if (this.state !== 'Panicking' && this.state !== 'Hiding' && this.fear > this.panicThreshold) this.panic();
  }

  private recover(): void {
    const w = this.world;
    this.recoveredAt = w.time;
    this.say('recovered', 'report');
    this.task = null;
    this.setState('Idle');
    const resume = this.interrupted && this.p.obedience > 0.6 ? this.interrupted : null;
    this.interrupted = null;
    w.history.record({
      time: w.time,
      category: 'npc',
      actor: this.id,
      text: `${this.name} calmed down and came out of hiding${resume ? ' and went back to your instruction' : ''}.`,
    });
    if (resume) this.execute(resume.given, resume.acted, 'player');
  }

  private updateEmotion(dt: number): void {
    const w = this.world;
    const light = w.facility.lightLevel(this.room);
    const dark = 1 - light;
    const hiding = this.state === 'Hiding';
    let df = dark * (1 - this.p.courage) * 0.022 * (hiding ? 0.2 : 1);
    df -= light * 0.02;
    if (hiding) df -= 0.035;
    const nearPlayer = dist(this.pos, w.player.pos) < 4;
    if (nearPlayer) df -= 0.03;
    // Not being alone helps a little.
    if (this.companions() > 0) df -= 0.012;
    this.fear = clamp01(this.fear + df * dt);
    this.stress = clamp01(this.stress + (this.fear * 0.015 - 0.006) * dt);
    if (nearPlayer && this.state === 'Following') this.trust = clamp01(this.trust + 0.004 * dt);
  }

  private companions(): number {
    return this.world.npcs.filter((n) => n !== this && n.alive && dist(n.pos, this.pos) < 4).length;
  }

  private expireRestrictions(): void {
    // Most people forget "don't open the door" after a while; literal people never do.
    if (this.noDoors && this.p.literalness < 0.7 && this.world.time - this.noDoors.since > 90) this.noDoors = null;
  }

  /** Self-driven behaviour when idle. Utility: own plan vs. standing orders. */
  private autonomy(): void {
    const w = this.world;
    const holding = this.task?.acted === 'stay';
    const noise = this.freshNoise(12);
    if (noise) {
      const want = this.p.independence * this.p.courage * noise.loudness - (holding ? this.p.obedience * 0.5 : 0) - this.p.caution * 0.2;
      if (want > 0.3) {
        this.say('autonomy.investigate', 'report');
        w.history.record({
          time: w.time,
          category: 'npc',
          actor: this.id,
          text: holding ? `${this.name} abandoned "Stay here" to investigate a noise on their own.` : `${this.name} went to investigate a noise on their own.`,
          reason: 'independent, brave, noise nearby',
          danger: 0.35,
          tags: ['independent'],
        });
        this.investigate(noise, 'self');
        return;
      }
    }
    const light = w.facility.lightLevel(this.room);
    if (light < 0.3 && this.fear > 0.3) {
      const want = this.fear * (1 - light) - (holding ? this.p.obedience * this.p.literalness : 0);
      if (want > 0.25) {
        w.history.record({ time: w.time, category: 'npc', actor: this.id, text: `${this.name} left the dark ${this.roomLabel()} looking for light.`, reason: 'afraid of the dark' });
        this.moveTo(w.map.standSpot('control', { x: 42, z: 21 }), { command: 'self', acted: 'self', issuedBy: 'self', targetRoom: 'control', onArrive: 'arrive', progress: 0 });
      }
    }
  }

  private panic(): void {
    const w = this.world;
    const fromPlayer = this.task?.issuedBy === 'player';
    if (fromPlayer) this.trust = clamp01(this.trust - 0.1);
    this.interrupted =
      fromPlayer && this.task && this.task.acted !== 'self' && this.task.command !== 'self'
        ? { given: this.task.command, acted: this.task.acted }
        : null;
    this.remember('panic', `Panicked in the ${this.roomLabel()}`);
    this.say('panic', 'report');
    w.history.record({
      time: w.time,
      category: 'npc',
      actor: this.id,
      text: `${this.name} panicked in the ${this.roomLabel()}${fromPlayer ? ' while following your instruction' : ''}.`,
      danger: 0.65,
      tags: ['panic'],
    });
    this.panicStartedAt = w.time;
    this.holdPos = null;
    const spot = this.nearestHideSpot();
    this.task = { command: 'self', acted: 'self', issuedBy: 'self', target: spot?.pos, onArrive: 'hide', progress: 0 };
    this.path = spot ? (this.plan(spot.pos, true) ?? []) : [];
    this.pathIdx = 0;
    this.setState('Panicking');
    if (this.path.length === 0) {
      this.setState('Hiding'); // nowhere to run: freeze in place
    }
  }

  private nearestHideSpot() {
    let best;
    let bestLen = Infinity;
    for (const s of this.world.poi.hideSpots) {
      const path = this.plan(s.pos, true);
      if (path && path.length < bestLen) {
        bestLen = path.length;
        best = s;
      }
    }
    return best;
  }

  private updateFollow(dt: number): void {
    const target = this.world.player.pos;
    const d = dist(this.pos, target);
    this.repathTimer -= dt;
    if (d < FOLLOW_GAP) {
      this.speed = 0;
      this.path = [];
      this.face(target, dt);
      return;
    }
    if (this.repathTimer <= 0 || this.pathIdx >= this.path.length) {
      this.repathTimer = 0.75;
      const path = this.plan(target);
      if (!path) {
        if (!this.blockedReported) {
          this.blockedReported = true;
          this.say(this.noDoors ? 'blocked.forbidden_door' : 'blocked.no_path', 'report');
        }
        this.speed = 0;
        return;
      }
      this.blockedReported = false;
      this.path = path;
      this.pathIdx = 1;
    }
    this.step(dt, d > 7 ? RUN * 0.8 : WALK * 1.15);
  }

  private walkPath(dt: number): void {
    if (this.pathIdx >= this.path.length) {
      this.arrive();
      return;
    }
    const speed = this.state === 'Panicking' ? RUN : this.state === 'Injured' ? WALK * 0.5 : WALK;
    this.step(dt, speed);
  }

  /** Moves along the current path, opening doors on the way. */
  private step(dt: number, speed: number): void {
    const w = this.world;
    const next = this.path[this.pathIdx];
    if (!next) return;
    const nc = worldToCell(next);
    const door = w.map.doorAt(nc.col, nc.row);
    if (door && !w.facility.isDoorOpen(door.id)) {
      if (!this.mayOpen(door)) {
        this.halt();
        if (!this.blockedReported) {
          this.blockedReported = true;
          this.say('blocked.forbidden_door', 'report');
          w.history.record({ time: w.time, category: 'npc', actor: this.id, text: `${this.name} stopped at a closed door because you said not to open doors.`, tags: ['literal'] });
        }
        if (this.state !== 'Following') this.setState('Idle');
        return;
      }
      if (dist(this.pos, next) < 2.4) {
        if (!w.facility.setDoor(door.id, true, this.id)) {
          this.halt();
          this.say('blocked.locked', 'report');
          this.setState('Idle');
          return;
        }
        this.waitTimer = DOOR_OPEN_TIME;
        return;
      }
    }
    const dx = next.x - this.pos.x;
    const dz = next.z - this.pos.z;
    const d = Math.hypot(dx, dz);
    const move = Math.min(d, speed * dt);
    if (d > 1e-4) {
      this.pos.x += (dx / d) * move;
      this.pos.z += (dz / d) * move;
      this.face(next, dt);
    }
    this.speed = speed;
    if (d - move < 0.15) this.pathIdx++;
  }

  private arrive(): void {
    const w = this.world;
    const t = this.task;
    this.speed = 0;
    this.path = [];
    if (!t) {
      this.setState('Idle');
      return;
    }
    switch (t.onArrive) {
      case 'repair':
        if (w.facility.generatorOnline) {
          this.say('done.repair_already', 'report');
          this.finishTask(true);
        } else {
          this.setState('PerformingTask');
        }
        return;
      case 'lights_off':
        if (t.lightsRoom) w.facility.setLights(t.lightsRoom, false, this.id);
        this.say('done.lights', 'report', { room: t.lightsRoom ? roomName(t.lightsRoom) : undefined });
        this.finishTask(true);
        return;
      case 'investigate':
        this.setState('PerformingTask');
        t.progress = 0;
        return;
      case 'hide':
        this.say('hiding', 'report');
        this.setState('Hiding');
        return;
      case 'arrive':
        if (t.issuedBy === 'player') this.say('done.arrived', 'report');
        this.finishTask(true);
        return;
      default:
        this.setState('Idle');
    }
  }

  private updateTask(dt: number): void {
    const w = this.world;
    const t = this.task;
    this.speed = 0;
    if (!t) {
      this.setState('Idle');
      return;
    }
    if (t.onArrive === 'repair') {
      const rate = 0.015 + this.p.technical * 0.05; // Emily ~16s, Daniel ~33s
      const shaky = this.stress > 0.6 && w.rng.chance((1 - this.p.stressTolerance) * 0.02) ? -0.08 : 0;
      if (shaky < 0) {
        w.facility.repairProgress = Math.max(0, w.facility.repairProgress + shaky);
        this.say('hesitate', 'report');
      }
      if (w.facility.addRepair(rate * dt, this.id)) {
        this.say('done.repair', 'report');
        this.finishTask(true);
      }
    } else if (t.onArrive === 'investigate') {
      t.progress += dt;
      this.heading += Math.sin(w.time * 1.3) * dt * 0.9; // look around
      if (t.progress > 4) {
        this.say('done.investigate_nothing', 'report');
        w.history.record({ time: w.time, category: 'npc', actor: this.id, text: `${this.name} investigated the ${this.roomLabel()} and found nothing.` });
        this.finishTask(true);
      }
    } else {
      this.finishTask(true);
    }
  }

  private finishTask(safe: boolean): void {
    if (safe && this.task?.issuedBy === 'player') this.trust = clamp01(this.trust + 0.05);
    const literalWait = this.p.literalness > 0.7 && this.task?.issuedBy === 'player';
    this.task = null;
    // Literal people hold where the task ended until told otherwise.
    if (literalWait) this.holdPos = { ...this.pos };
    this.setState('Idle');
  }

  // ---------------------------------------------------------------- senses

  private hear(n: Noise): void {
    if (!this.alive || n.source.endsWith(`:${this.id}`)) return;
    const d = dist(this.pos, n.pos);
    const range = n.loudness * 22;
    if (d > range) return;
    const strength = n.loudness * (1 - d / range);
    // Doors opened by people are expected; machinery and unexplained bangs are not.
    const startle = n.source.startsWith('door:') ? 0.25 : 1;
    this.fear = clamp01(this.fear + strength * (1 - this.p.courage) * 0.3 * startle);
    if (startle === 1) {
      this.remember('noise', `Heard a noise (${n.source}) near the ${this.world.map.roomAtWorld(n.pos) ?? 'facility'}`, this.world.map.roomAtWorld(n.pos));
      const w = this.world;
      if (strength > 0.25 && this.p.awareness > 0.4 && w.time - this.lastNoiseRemark > 25 && this.state !== 'Panicking') {
        this.lastNoiseRemark = w.time;
        w.radio.later(w.rng.range(0.6, 1.4), () => this.say('noise.heard', 'report'));
      }
    }
  }

  private onPower(online: boolean): void {
    if (online || !this.alive) return;
    const w = this.world;
    this.remember('power', 'The power went out');
    if (w.facility.lightLevel(this.room) < 0.3) w.radio.later(w.rng.range(1, 2.5), () => this.say('power.lost', 'report'));
  }

  private freshNoise(maxAge: number): Noise | undefined {
    const w = this.world;
    return w.facility.recentNoise(maxAge, (n) => n.source.startsWith('door:') || dist(n.pos, this.pos) > n.loudness * 22);
  }

  // ---------------------------------------------------------------- helpers

  private targetRoomFor(id: CommandId): RoomId | undefined {
    const c = command(id);
    if (c.targetRoom) return c.targetRoom;
    if (id === 'follow') return this.world.player.room;
    if (id === 'investigate_noise') {
      const n = this.world.facility.recentNoise(60);
      return n ? this.world.map.roomAtWorld(n.pos) : this.room;
    }
    return this.room;
  }

  /** How dangerous a room looks to this NPC right now. */
  riskOf(room: RoomId | undefined): number {
    if (!room) return 0.2;
    const dark = 1 - this.world.facility.lightLevel(room);
    const bad = this.memory.filter((m) => m.room === room && (m.kind === 'panic' || m.kind === 'noise')).length;
    const restricted = room === 'restricted' ? 0.35 : 0;
    return clamp01(dark * 0.65 + Math.min(0.4, bad * 0.15) + restricted);
  }

  private mayOpen(door: DoorDef): boolean {
    const st = this.world.facility.doors.get(door.id)!;
    if (st.locked) return false;
    if (!this.noDoors) return true;
    // A panicking non-literal person forgets the rule.
    return this.state === 'Panicking' && this.p.literalness < 0.7;
  }

  private plan(to: Vec2, panicking = false): Vec2[] | null {
    const w = this.world;
    return w.map.findPath(this.pos, to, (door) => {
      const st = w.facility.doors.get(door.id)!;
      if (st.open) return true;
      if (st.locked) return false;
      if (!this.noDoors) return true;
      return panicking && this.p.literalness < 0.7;
    });
  }

  private moveTo(target: Vec2, task: Task): void {
    const path = this.plan(target);
    this.task = { ...task, target };
    if (!path) {
      this.say(this.noDoors ? 'blocked.forbidden_door' : 'blocked.no_path', 'report');
      if (this.noDoors) this.world.history.record({ time: this.world.time, category: 'npc', actor: this.id, text: `${this.name} could not go anywhere: every route needs a door, and you said not to open doors.`, tags: ['literal'] });
      this.task = null;
      this.setState('Idle');
      return;
    }
    this.path = path;
    this.pathIdx = 1;
    this.setState('MovingToLocation');
  }

  private halt(): void {
    this.path = [];
    this.pathIdx = 0;
    this.speed = 0;
  }

  private face(target: Vec2, dt: number): void {
    const want = Math.atan2(target.x - this.pos.x, target.z - this.pos.z);
    let diff = want - this.heading;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    this.heading += diff * Math.min(1, dt * 6);
  }

  private setState(next: NpcStateName): void {
    if (next === this.state) return;
    const from = this.state;
    this.state = next;
    this.world.bus.emit('npcStateChanged', { npcId: this.id, from, to: next });
  }

  private remember(kind: Memory['kind'], text: string, room: RoomId | undefined = this.room): void {
    this.memory.push({ time: this.world.time, kind, text, room });
    if (this.memory.length > 60) this.memory.shift();
  }

  signal(): number {
    return this.world.radio.signalFor(this.room);
  }

  private statusKey(): string {
    if (this.state === 'Hiding') return this.p.pride > 0.6 ? 'status.hiding_lie' : 'status.hiding_truth';
    if (this.fear > 0.45) return 'status.scared';
    if (this.world.facility.lightLevel(this.room) === 0 && this.fear > 0.2) return 'status.dark';
    return 'status.calm';
  }

  private roomLabel(): string {
    const r = this.room;
    return r ? roomName(r) : 'corridor';
  }

  private say(key: string, status: RadioStatus, vars: { room?: string } = {}): void {
    const w = this.world;
    // Rate-limit chatter so the channel stays readable.
    const ambient = /^(noise|power|autonomy)/.test(key);
    if (ambient && w.time - this.lastSpoke < 1.2) return;
    this.reply(w.dialogue.line(this.id, key, { room: this.roomLabel(), ...vars }), status, this.signal());
  }

  private reply(text: string, status: RadioStatus, signal: number): void {
    this.lastSpoke = this.world.time;
    this.world.radio.post({ from: this.id, to: 'player', original: text, status, authentic: true, signal: Math.min(signal, this.signal()) });
  }

  private recordDecision(cmd: CommandDef, d: Decision, ctx: InterpretContext): void {
    const verbs: Record<Decision['kind'], string> = {
      comply: 'followed',
      hesitate: 'hesitated at',
      question: 'questioned',
      misread: 'misread',
      independent: 'ignored',
      refuse: 'refused',
    };
    this.world.history.record({
      time: this.world.time,
      category: 'response',
      actor: this.id,
      text: `${this.name} ${verbs[d.kind]} "${cmd.phrase}"`,
      reason: d.reason,
      danger: d.kind === 'comply' ? ctx.targetRisk * 0.5 : d.kind === 'refuse' ? 0.1 : 0.2,
      tags: [d.kind, cmd.id],
    });
  }

  /** Exposed for the radio UI / incident report. */
  get secondsSincePanic(): number {
    return this.world.time - this.panicStartedAt;
  }
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}
