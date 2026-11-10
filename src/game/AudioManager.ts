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
} as const;
export type CueId = keyof typeof AUDIO_CUES;

export class AudioManager {
  readonly ctx: AudioContext;
  private master: GainNode;
  private sfx: GainNode;
  private amb: GainNode;
  private radio: GainNode;
  private noiseBuf: AudioBuffer;
  private samples = new Map<CueId, AudioBuffer>();
  private roomTone: GainNode | null = null;
  private generator: { gain: GainNode } | null = null;
  private breath: GainNode | null = null;

  constructor() {
    this.ctx = new AudioContext();
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
    void this.loadSamples();
  }

  resume(): void {
    void this.ctx.resume();
  }

  /** Listener follows the camera. */
  updateListener(cam: THREE.Camera): void {
    const l = this.ctx.listener;
    const p = cam.position;
    const t = this.ctx.currentTime;
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
  }

  /** Power state drives the hum. Losing power = sudden silence. */
  setPower(online: boolean): void {
    const t = this.ctx.currentTime;
    this.roomTone?.gain.setTargetAtTime(online ? 1 : 0.04, t, online ? 0.6 : 0.08);
    this.generator?.gain.gain.setTargetAtTime(online ? 0.5 : 0, t, online ? 1.2 : 0.5);
    this.play(online ? 'sfx.power_up' : 'sfx.power_down');
  }

  /** 0..1 breathing loudness; cycles in and out. */
  setBreathing(level: number): void {
    if (!this.breath) return;
    const cycle = 0.5 + 0.5 * Math.sin(this.ctx.currentTime * 3.2);
    this.breath.gain.setTargetAtTime(level * 0.12 * cycle, this.ctx.currentTime, 0.05);
  }

  // ------------------------------------------------------------------ one-shots

  play(id: CueId, opts: { pos?: Vec2; y?: number; gain?: number; open?: boolean; duration?: number; intensity?: number } = {}): void {
    if (this.ctx.state !== 'running') return;
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
    const t = this.ctx.currentTime;
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
