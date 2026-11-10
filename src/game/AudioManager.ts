import type * as THREE from 'three';
import type { Vec2 } from '../sim/facility/FacilityMap';

/**
 * Audio cues used by the game. Every cue currently has a SYNTHESISED
 * PLACEHOLDER implementation (WebAudio oscillators + filtered noise). None of
 * these are production assets. To replace one, put a file in
 * public/audio/ and set `file` here; `play()` uses the sample when it loaded
 * and falls back to the synth otherwise. Full list: docs/AUDIO_ASSETS.md.
 */
export const AUDIO_CUES = {
  'amb.roomtone': { file: null as string | null, note: 'Facility room tone: ventilation + fluorescent buzz (loop)' },
  'amb.generator': { file: null as string | null, note: 'Generator drone, positional (loop)' },
  'sfx.footstep': { file: null as string | null, note: 'Boot on vinyl floor, 6+ variations' },
  'sfx.door': { file: null as string | null, note: 'Industrial sliding door servo + latch' },
  'sfx.door_denied': { file: null as string | null, note: 'Keycard reader reject buzz' },
  'sfx.impact_metal': { file: null as string | null, note: 'Distant metallic impact, 4+ variations' },
  'sfx.pipes': { file: null as string | null, note: 'Pipe knocking' },
  'sfx.vent': { file: null as string | null, note: 'Vent rattle / air movement' },
  'sfx.power_down': { file: null as string | null, note: 'Breaker trip + spin-down' },
  'sfx.power_up': { file: null as string | null, note: 'Spin-up + relays' },
  'sfx.pickup': { file: null as string | null, note: 'Item pickup' },
  'sfx.switch': { file: null as string | null, note: 'Heavy light switch' },
  'sfx.flashlight': { file: null as string | null, note: 'Flashlight click' },
  'radio.squelch': { file: null as string | null, note: 'Push-to-talk open/close squelch' },
  'radio.static': { file: null as string | null, note: 'Interference bursts' },
  'radio.voice_bed': { file: null as string | null, note: 'Stand-in for recorded voice lines (see dialogue ids)' },
  'radio.unknown': { file: null as string | null, note: 'THE LISTENER: unidentified transmission' },
  'player.breath': { file: null as string | null, note: 'Exhausted breathing' },
  'amb.dread': { file: null as string | null, note: 'Dread bed: sub drone, beating tones, wind in the vents (loop, gain = dread)' },
  'scare.stinger': { file: null as string | null, note: 'Jumpscare stinger: dissonant orchestral/metal hit' },
  'scare.scream': { file: null as string | null, note: 'THE LISTENER scream (inhuman, layered)' },
  'scare.whisper': { file: null as string | null, note: 'Close whisper / breath behind the player, positional' },
  'scare.footsteps': { file: null as string | null, note: 'Heavy, uneven entity footsteps with drag, positional' },
  'scare.heartbeat': { file: null as string | null, note: 'Player heartbeat (one beat), driven by dread' },
  'scare.lights_burst': { file: null as string | null, note: 'Fluorescent tubes bursting + electrical buzz' },
  'scare.presence': { file: null as string | null, note: 'Low rising swell when the figure is seen' },
} as const;
export type CueId = keyof typeof AUDIO_CUES;

export class AudioManager {
  readonly ctx: BaseAudioContext;
  /**
   * Current audio time. Real time normally; for offline rendering (video
   * capture) it is set to the game's clock so every cue lands on its frame.
   */
  now: () => number = () => this.ctx.currentTime;
  readonly offline: boolean;
  private master: GainNode;
  private sfx: GainNode;
  private amb: GainNode;
  private radio: GainNode;
  private noiseBuf: AudioBuffer;
  private samples = new Map<CueId, AudioBuffer>();
  private roomTone: GainNode | null = null;
  private generator: { gain: GainNode } | null = null;
  private breath: GainNode | null = null;
  private dread: GainNode | null = null;
  private dreadFilter: BiquadFilterNode | null = null;

  constructor(ctx?: BaseAudioContext) {
    this.ctx = ctx ?? new AudioContext();
    this.offline = typeof OfflineAudioContext !== 'undefined' && this.ctx instanceof OfflineAudioContext;
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.9;
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    this.master.connect(comp).connect(this.ctx.destination);
    this.sfx = this.bus(1);
    this.amb = this.bus(0.8);
    this.radio = this.radioChain();
    this.noiseBuf = this.makeNoise(3);
    if (!this.offline) void this.loadSamples();
  }

  resume(): void {
    if (this.ctx instanceof AudioContext) void this.ctx.resume();
  }

  /** Listener follows the camera. */
  updateListener(cam: THREE.Camera): void {
    const l = this.ctx.listener;
    const p = cam.position;
    const t = this.now();
    const fwd = { x: -Math.sin(cam.rotation.y), z: -Math.cos(cam.rotation.y) };
    if (l.positionX) {
      l.positionX.setTargetAtTime(p.x, t, 0.02);
      l.positionY.setTargetAtTime(p.y, t, 0.02);
      l.positionZ.setTargetAtTime(p.z, t, 0.02);
      l.forwardX.setTargetAtTime(fwd.x, t, 0.02);
      l.forwardY.setTargetAtTime(0, t, 0.02);
      l.forwardZ.setTargetAtTime(fwd.z, t, 0.02);
      l.upX.value = 0;
      l.upY.value = 1;
      l.upZ.value = 0;
    } else {
      l.setPosition(p.x, p.y, p.z);
      l.setOrientation(fwd.x, 0, fwd.z, 0, 1, 0);
    }
  }

  // ------------------------------------------------------------------ ambience

  startAmbience(generatorPos: Vec2): void {
    // Room tone: low rumble + 60/120 Hz fluorescent buzz.
    const tone = this.ctx.createGain();
    tone.gain.value = 1;
    tone.connect(this.amb);
    const rumble = this.loopNoise();
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 160;
    const rg = this.ctx.createGain();
    rg.gain.value = 0.22;
    rumble.connect(lp).connect(rg).connect(tone);
    for (const [f, g] of [[60, 0.012], [120, 0.008], [180, 0.003]] as const) {
      const o = this.ctx.createOscillator();
      o.frequency.value = f;
      const og = this.ctx.createGain();
      og.gain.value = g;
      o.connect(og).connect(tone);
      o.start();
    }
    this.roomTone = tone;

    // Generator: positional drone.
    const gen = this.ctx.createGain();
    gen.gain.value = 0.5;
    const pan = this.panner(generatorPos, 1.6, 3, 1.2);
    gen.connect(pan).connect(this.amb);
    const saw = this.ctx.createOscillator();
    saw.type = 'sawtooth';
    saw.frequency.value = 49;
    const glp = this.ctx.createBiquadFilter();
    glp.type = 'lowpass';
    glp.frequency.value = 260;
    saw.connect(glp).connect(gen);
    saw.start();
    const gn = this.loopNoise();
    const gbp = this.ctx.createBiquadFilter();
    gbp.type = 'bandpass';
    gbp.frequency.value = 420;
    const gng = this.ctx.createGain();
    gng.gain.value = 0.35;
    gn.connect(gbp).connect(gng).connect(gen);
    this.generator = { gain: gen };

    // Breathing bed (driven by stamina / fear).
    const br = this.ctx.createGain();
    br.gain.value = 0;
    const bn = this.loopNoise();
    const bbp = this.ctx.createBiquadFilter();
    bbp.type = 'bandpass';
    bbp.frequency.value = 900;
    bbp.Q.value = 0.8;
    bn.connect(bbp).connect(br).connect(this.sfx);
    this.breath = br;

    // Dread bed: inaudible at 0, oppressive at 1.
    const dg = this.ctx.createGain();
    dg.gain.value = 0;
    dg.connect(this.amb);
    for (const [f, g] of [[36, 0.22], [36.6, 0.2], [54.9, 0.08], [73.4, 0.05], [77.8, 0.05]] as const) {
      const o = this.ctx.createOscillator();
      o.frequency.value = f;
      const og = this.ctx.createGain();
      og.gain.value = g;
      o.connect(og).connect(dg);
      o.start();
    }
    const wind = this.loopNoise();
    const wf = this.ctx.createBiquadFilter();
    wf.type = 'bandpass';
    wf.frequency.value = 300;
    wf.Q.value = 4;
    const wg = this.ctx.createGain();
    wg.gain.value = 0.5;
    wind.connect(wf).connect(wg).connect(dg);
    // Slow LFO sweeping the "wind" so it moans.
    const lfo = this.ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoGain = this.ctx.createGain();
    lfoGain.gain.value = 180;
    lfo.connect(lfoGain).connect(wf.frequency);
    lfo.start();
    this.dread = dg;
    this.dreadFilter = wf;
  }

  /** 0..1. The dread bed swells and the "wind" opens up as dread rises. */
  setDread(level: number): void {
    if (!this.dread || !this.dreadFilter) return;
    const t = this.now();
    this.dread.gain.setTargetAtTime(Math.pow(level, 1.4) * 0.55, t, 0.8);
    this.dreadFilter.Q.setTargetAtTime(2 + level * 10, t, 1);
  }

  /** Power state drives the hum. Losing power = sudden silence. */
  setPower(online: boolean): void {
    const t = this.now();
    this.roomTone?.gain.setTargetAtTime(online ? 1 : 0.04, t, online ? 0.6 : 0.08);
    this.generator?.gain.gain.setTargetAtTime(online ? 0.5 : 0, t, online ? 1.2 : 0.5);
    this.play(online ? 'sfx.power_up' : 'sfx.power_down');
  }

  /** 0..1 breathing loudness; cycles in and out. */
  setBreathing(level: number): void {
    if (!this.breath) return;
    const cycle = 0.5 + 0.5 * Math.sin(this.now() * 3.2);
    this.breath.gain.setTargetAtTime(level * 0.12 * cycle, this.now(), 0.05);
  }

  // ------------------------------------------------------------------ one-shots

  play(id: CueId, opts: { pos?: Vec2; y?: number; gain?: number; open?: boolean; duration?: number; intensity?: number } = {}): void {
    if (this.ctx.state !== 'running' && !this.offline) return;
    const out = this.ctx.createGain();
    out.gain.value = opts.gain ?? 1;
    const dest = id.startsWith('radio.') ? this.radio : this.sfx;
    if (opts.pos) out.connect(this.panner(opts.pos, opts.y ?? 1.5, 2.5, 1.1)).connect(dest);
    else out.connect(dest);

    const sample = this.samples.get(id);
    if (sample) {
      const src = this.ctx.createBufferSource();
      src.buffer = sample;
      src.playbackRate.value = 0.95 + Math.random() * 0.1;
      src.connect(out);
      src.start();
      return;
    }
    this.synth(id, out, opts);
  }

  // ------------------------------------------------------------------ synth placeholders

  private synth(id: CueId, out: GainNode, opts: { open?: boolean; duration?: number; intensity?: number }): void {
    const t = this.now();
    const c = this.ctx;
    switch (id) {
      case 'sfx.footstep': {
        const i = opts.intensity ?? 0.5;
        this.noiseBurst(out, t, 0.07, 'bandpass', 700 + Math.random() * 900, 0.35 * i, 1.4);
        this.tone(out, t, 'sine', 70 + Math.random() * 20, 0.09, 0.25 * i);
        break;
      }
      case 'sfx.door': {
        const o = c.createOscillator();
        o.type = 'sawtooth';
        o.frequency.setValueAtTime(opts.open ? 110 : 190, t);
        o.frequency.linearRampToValueAtTime(opts.open ? 200 : 105, t + 0.75);
        const lp = c.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 700;
        const g = c.createGain();
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(0.18, t + 0.08);
        g.gain.linearRampToValueAtTime(0.12, t + 0.7);
        g.gain.linearRampToValueAtTime(0, t + 0.8);
        o.connect(lp).connect(g).connect(out);
        o.start(t);
        o.stop(t + 0.85);
        this.noiseBurst(out, t + 0.78, 0.12, 'lowpass', 400, 0.6, 1);
        this.tone(out, t + 0.78, 'sine', 55, 0.25, 0.4);
        break;
      }
      case 'sfx.door_denied':
        this.tone(out, t, 'square', 140, 0.18, 0.08);
        this.tone(out, t + 0.22, 'square', 140, 0.3, 0.08);
        break;
      case 'sfx.impact_metal': {
        const f0 = 80 + Math.random() * 110;
        for (const [ratio, amp] of [[1, 0.5], [2.76, 0.3], [5.4, 0.18], [8.93, 0.1]] as const) this.tone(out, t, 'sine', f0 * ratio, 1.2 + Math.random() * 1.8, amp * 0.5);
        this.noiseBurst(out, t, 0.05, 'lowpass', 2500, 0.8, 1);
        break;
      }
      case 'sfx.pipes':
        for (let k = 0; k < 3 + Math.floor(Math.random() * 3); k++) {
          const at = t + k * (0.16 + Math.random() * 0.12);
          this.tone(out, at, 'sine', 95 + Math.random() * 30, 0.35, 0.35);
          this.noiseBurst(out, at, 0.03, 'bandpass', 800, 0.3, 2);
        }
        break;
      case 'sfx.vent':
        this.noiseBurst(out, t, 1.6, 'bandpass', 500, 0.25, 0.6, 0.6);
        break;
      case 'sfx.power_down': {
        this.noiseBurst(out, t, 0.15, 'lowpass', 1200, 0.9, 1);
        const o = c.createOscillator();
        o.type = 'sawtooth';
        o.frequency.setValueAtTime(110, t);
        o.frequency.exponentialRampToValueAtTime(18, t + 2.6);
        const g = c.createGain();
        g.gain.setValueAtTime(0.25, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + 2.8);
        const lp = c.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 500;
        o.connect(lp).connect(g).connect(out);
        o.start(t);
        o.stop(t + 3);
        break;
      }
      case 'sfx.power_up': {
        const o = c.createOscillator();
        o.type = 'sawtooth';
        o.frequency.setValueAtTime(20, t);
        o.frequency.exponentialRampToValueAtTime(100, t + 2);
        const g = c.createGain();
        g.gain.setValueAtTime(0.001, t);
        g.gain.exponentialRampToValueAtTime(0.2, t + 1.8);
        g.gain.exponentialRampToValueAtTime(0.001, t + 2.6);
        const lp = c.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 600;
        o.connect(lp).connect(g).connect(out);
        o.start(t);
        o.stop(t + 2.7);
        for (let k = 0; k < 4; k++) this.noiseBurst(out, t + 1.9 + k * 0.09, 0.03, 'bandpass', 2000, 0.5, 3);
        break;
      }
      case 'sfx.pickup':
        this.noiseBurst(out, t, 0.04, 'highpass', 3000, 0.3, 1);
        this.tone(out, t, 'triangle', 900, 0.06, 0.08);
        break;
      case 'sfx.switch':
        this.noiseBurst(out, t, 0.03, 'bandpass', 1800, 0.6, 2);
        this.tone(out, t, 'sine', 160, 0.06, 0.2);
        break;
      case 'sfx.flashlight':
        this.noiseBurst(out, t, 0.02, 'highpass', 4000, 0.4, 1);
        break;
      case 'radio.squelch':
        this.noiseBurst(out, t, 0.09, 'highpass', 1500, 0.35, 1);
        this.tone(out, t + 0.02, 'sine', opts.open ? 1450 : 1150, 0.06, 0.07);
        break;
      case 'radio.static': {
        const dur = opts.duration ?? 0.8;
        const i = opts.intensity ?? 0.5;
        this.noiseBurst(out, t, dur, 'bandpass', 2200, 0.5 * i, 0.5, 0.05, true);
        break;
      }
      case 'radio.voice_bed': {
        // NOT a voice. A band-limited, syllable-modulated murmur so a radio
        // reply has presence until recorded lines exist.
        const dur = opts.duration ?? 1.5;
        const src = this.loopNoise();
        const bp = c.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = 700;
        bp.Q.value = 2.5;
        const g = c.createGain();
        g.gain.value = 0;
        for (let k = 0; k * 0.14 < dur; k++) {
          const at = t + k * 0.14 + Math.random() * 0.04;
          const amp = Math.random() < 0.15 ? 0 : 0.05 + Math.random() * 0.07;
          g.gain.setTargetAtTime(amp, at, 0.025);
          bp.frequency.setTargetAtTime(500 + Math.random() * 700, at, 0.03);
        }
        g.gain.setTargetAtTime(0, t + dur, 0.04);
        src.connect(bp).connect(g).connect(out);
        src.stop(t + dur + 0.3);
        break;
      }
      case 'radio.unknown': {
        const dur = opts.duration ?? 3;
        for (const f of [61, 64.3, 122.8]) {
          const o = c.createOscillator();
          o.type = 'sine';
          o.frequency.setValueAtTime(f, t);
          o.frequency.linearRampToValueAtTime(f * 0.92, t + dur);
          const g = c.createGain();
          g.gain.setValueAtTime(0.001, t);
          g.gain.exponentialRampToValueAtTime(0.16, t + dur * 0.5);
          g.gain.exponentialRampToValueAtTime(0.001, t + dur);
          o.connect(g).connect(out);
          o.start(t);
          o.stop(t + dur + 0.1);
        }
        this.noiseBurst(out, t, dur, 'bandpass', 1400, 0.4, 0.4, 0.4, true);
        break;
      }
      case 'scare.stinger': {
        // Dissonant cluster + noise hit + sub drop. Loud on purpose.
        const lp = c.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.setValueAtTime(9000, t);
        lp.frequency.exponentialRampToValueAtTime(400, t + 1.6);
        lp.connect(out);
        for (const f of [233, 247, 262, 277, 311, 466, 494, 698]) {
          const o = c.createOscillator();
          o.type = 'sawtooth';
          o.frequency.setValueAtTime(f, t);
          o.frequency.linearRampToValueAtTime(f * 0.94, t + 1.8);
          const g = c.createGain();
          g.gain.setValueAtTime(0.0001, t);
          g.gain.exponentialRampToValueAtTime(0.09, t + 0.01);
          g.gain.exponentialRampToValueAtTime(0.0001, t + 1.9);
          o.connect(g).connect(lp);
          o.start(t);
          o.stop(t + 2);
        }
        this.noiseBurst(out, t, 0.35, 'lowpass', 5000, 1.2, 0.7);
        const sub = c.createOscillator();
        sub.frequency.setValueAtTime(110, t);
        sub.frequency.exponentialRampToValueAtTime(28, t + 1.2);
        const sg = c.createGain();
        sg.gain.setValueAtTime(0.9, t);
        sg.gain.exponentialRampToValueAtTime(0.001, t + 1.5);
        sub.connect(sg).connect(out);
        sub.start(t);
        sub.stop(t + 1.6);
        break;
      }
      case 'scare.scream': {
        const dur = opts.duration ?? 1.3;
        const shaper = c.createWaveShaper();
        const curve = new Float32Array(512);
        for (let i = 0; i < 512; i++) curve[i] = Math.tanh(((i / 511) * 2 - 1) * 6);
        shaper.curve = curve;
        const g = c.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.5, t + 0.04);
        g.gain.setValueAtTime(0.5, t + dur * 0.6);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        shaper.connect(g).connect(out);
        for (const [base, form] of [[820, 1100], [1240, 2600], [610, 900]] as const) {
          const o = c.createOscillator();
          o.type = 'sawtooth';
          o.frequency.setValueAtTime(base * 0.8, t);
          o.frequency.exponentialRampToValueAtTime(base * 1.25, t + dur * 0.3);
          o.frequency.exponentialRampToValueAtTime(base * 0.55, t + dur);
          const vib = c.createOscillator();
          vib.frequency.value = 23 + Math.random() * 9;
          const vg = c.createGain();
          vg.gain.value = base * 0.06;
          vib.connect(vg).connect(o.frequency);
          const bp = c.createBiquadFilter();
          bp.type = 'bandpass';
          bp.frequency.value = form;
          bp.Q.value = 3;
          const og = c.createGain();
          og.gain.value = 0.25;
          o.connect(bp).connect(og).connect(shaper);
          o.start(t);
          vib.start(t);
          o.stop(t + dur + 0.05);
          vib.stop(t + dur + 0.05);
        }
        this.noiseBurst(shaper, t, dur, 'bandpass', 3000, 0.25, 1, 0.03);
        break;
      }
      case 'scare.whisper': {
        const dur = opts.duration ?? 2.5;
        const src = this.loopNoise();
        const bp = c.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = 3200;
        bp.Q.value = 1.5;
        const g = c.createGain();
        g.gain.value = 0;
        // Syllables: fast, uneven, hissing.
        for (let k = 0; k * 0.11 < dur; k++) {
          const at = t + k * 0.11 + Math.random() * 0.05;
          g.gain.setTargetAtTime(Math.random() < 0.25 ? 0 : 0.2 + Math.random() * 0.25, at, 0.02);
          bp.frequency.setTargetAtTime(2200 + Math.random() * 3000, at, 0.02);
        }
        g.gain.setTargetAtTime(0, t + dur, 0.05);
        src.connect(bp).connect(g).connect(out);
        src.stop(t + dur + 0.4);
        // A slow wet inhale underneath.
        this.noiseBurst(out, t + 0.2, dur * 0.6, 'lowpass', 700, 0.3, 0.8, dur * 0.5);
        break;
      }
      case 'scare.footsteps': {
        // Heavy, uneven: step... step-step... drag.
        let at = t;
        for (let k = 0; k < 5; k++) {
          this.tone(out, at, 'sine', 48 + Math.random() * 10, 0.4, 0.7);
          this.noiseBurst(out, at, 0.09, 'lowpass', 500, 0.6, 1);
          if (k % 2) this.noiseBurst(out, at + 0.12, 0.35, 'bandpass', 1400, 0.12, 2, 0.1); // drag
          at += k === 1 ? 0.28 : 0.55 + Math.random() * 0.4;
        }
        break;
      }
      case 'scare.heartbeat':
        this.tone(out, t, 'sine', 52, 0.16, 0.6);
        this.tone(out, t + 0.2, 'sine', 46, 0.2, 0.45);
        break;
      case 'scare.lights_burst':
        for (let k = 0; k < 3; k++) this.noiseBurst(out, t + k * 0.07, 0.08, 'highpass', 2500, 1, 0.8);
        this.tone(out, t, 'square', 120, 1.2, 0.08);
        break;
      case 'scare.presence': {
        const o = c.createOscillator();
        o.type = 'sawtooth';
        o.frequency.setValueAtTime(40, t);
        o.frequency.exponentialRampToValueAtTime(62, t + 2.5);
        const lp = c.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.setValueAtTime(120, t);
        lp.frequency.exponentialRampToValueAtTime(900, t + 2.5);
        const g = c.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.35, t + 2.3);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 3);
        o.connect(lp).connect(g).connect(out);
        o.start(t);
        o.stop(t + 3.1);
        this.noiseBurst(out, t, 2.6, 'bandpass', 1800, 0.12, 1, 2.4, true);
        break;
      }
      default:
        break;
    }
  }

  // ------------------------------------------------------------------ building blocks

  private bus(gain: number): GainNode {
    const g = this.ctx.createGain();
    g.gain.value = gain;
    g.connect(this.master);
    return g;
  }

  /** Radio voice chain: band-limited + soft clipping, like a handheld speaker. */
  private radioChain(): GainNode {
    const input = this.ctx.createGain();
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 350;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 3200;
    const shaper = this.ctx.createWaveShaper();
    const curve = new Float32Array(256);
    for (let i = 0; i < 256; i++) {
      const x = (i / 255) * 2 - 1;
      curve[i] = Math.tanh(x * 2.5);
    }
    shaper.curve = curve;
    const out = this.ctx.createGain();
    out.gain.value = 0.9;
    input.connect(hp).connect(lp).connect(shaper).connect(out).connect(this.master);
    return input;
  }

  private panner(pos: Vec2, y: number, ref: number, rolloff: number): PannerNode {
    const p = this.ctx.createPanner();
    p.panningModel = 'HRTF';
    p.distanceModel = 'inverse';
    p.refDistance = ref;
    p.rolloffFactor = rolloff;
    p.maxDistance = 60;
    if (p.positionX) {
      p.positionX.value = pos.x;
      p.positionY.value = y;
      p.positionZ.value = pos.z;
    } else p.setPosition(pos.x, y, pos.z);
    return p;
  }

  private makeNoise(seconds: number): AudioBuffer {
    const buf = this.ctx.createBuffer(1, this.ctx.sampleRate * seconds, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  private loopNoise(): AudioBufferSourceNode {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noiseBuf;
    s.loop = true;
    s.loopStart = Math.random();
    s.start(0, Math.random() * 2);
    return s;
  }

  private noiseBurst(out: AudioNode, at: number, dur: number, type: BiquadFilterType, freq: number, amp: number, q: number, attack = 0.002, crackle = false): void {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noiseBuf;
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(amp, at + attack);
    if (crackle) for (let k = 0; k < dur / 0.05; k++) g.gain.setValueAtTime(amp * (0.2 + Math.random()), at + attack + k * 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, at + attack + dur);
    s.connect(f).connect(g).connect(out);
    s.start(at, Math.random() * 2);
    s.stop(at + attack + dur + 0.05);
  }

  private tone(out: AudioNode, at: number, type: OscillatorType, freq: number, dur: number, amp: number): void {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(amp, at + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o.connect(g).connect(out);
    o.start(at);
    o.stop(at + dur + 0.02);
  }

  private async loadSamples(): Promise<void> {
    for (const [id, cue] of Object.entries(AUDIO_CUES) as [CueId, { file: string | null }][]) {
      if (!cue.file) continue;
      try {
        const res = await fetch(`audio/${cue.file}`);
        if (!res.ok) continue;
        this.samples.set(id, await this.ctx.decodeAudioData(await res.arrayBuffer()));
      } catch {
        /* keep synth fallback */
      }
    }
  }
}

/** Renders an offline AudioManager's output to a 16-bit stereo WAV (base64). */
export async function renderWavBase64(ctx: OfflineAudioContext): Promise<string> {
  const buf = await ctx.startRendering();
  const ch = [buf.getChannelData(0), buf.getChannelData(buf.numberOfChannels > 1 ? 1 : 0)];
  const n = buf.length;
  const out = new DataView(new ArrayBuffer(44 + n * 4));
  const str = (o: number, t: string) => [...t].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  out.setUint32(4, 36 + n * 4, true);
  str(8, 'WAVEfmt ');
  out.setUint32(16, 16, true);
  out.setUint16(20, 1, true);
  out.setUint16(22, 2, true);
  out.setUint32(24, buf.sampleRate, true);
  out.setUint32(28, buf.sampleRate * 4, true);
  out.setUint16(32, 4, true);
  out.setUint16(34, 16, true);
  str(36, 'data');
  out.setUint32(40, n * 4, true);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 2; c++) out.setInt16(44 + i * 4 + c * 2, Math.max(-1, Math.min(1, ch[c][i])) * 0x7fff, true);
  }
  const bytes = new Uint8Array(out.buffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
