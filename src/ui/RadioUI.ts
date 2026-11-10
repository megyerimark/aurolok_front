import { COMMANDS, type CommandId } from '../sim/npc/Commands';
import type { RadioMessage } from '../sim/radio/RadioSystem';
import type { SimWorld } from '../sim/SimWorld';

const CHANNELS = ['all', 'daniel', 'emily', 'robert', 'lucas'] as const;

function bars(signal: number): string {
  const n = Math.round(signal * 5);
  return '▮'.repeat(n) + '▯'.repeat(5 - n);
}

/**
 * The handheld radio. Raised with R; Q cycles channel; 1-9 transmit.
 * Shows per-channel badge telemetry (location, heart rate, activity) and
 * flags anything abnormal on the line.
 */
export class RadioUI {
  open = false;
  channel = 0;
  onTransmit: (to: string, cmd: CommandId) => void = () => {};
  private root: HTMLElement;
  private lcd: HTMLElement;
  private tx: HTMLElement;
  private rx: HTMLElement;
  private warn: HTMLElement;
  private last: RadioMessage | null = null;
  private sentFlash: { cmd: CommandId; until: number } | null = null;
  private noiseUntil = 0;

  constructor(parent: HTMLElement, private readonly sim: SimWorld) {
    this.root = document.createElement('div');
    this.root.className = 'radio';
    this.root.innerHTML = `
      <div class="antenna"></div>
      <div class="body">
        <div class="top"><span>MOTOR-FIELD HT-9 · SUBLEVEL NET</span>
          <div class="leds"><span class="led tx"><i></i>TX</span><span class="led rx"><i></i>RX</span><span class="led warn"><i></i>!</span></div></div>
        <div class="lcd"></div>
        <div class="hint">R RAISE/LOWER · Q CHANNEL · 1–9 TRANSMIT</div>
        <div class="grille"></div>
      </div>`;
    parent.appendChild(this.root);
    this.lcd = this.root.querySelector('.lcd')!;
    this.tx = this.root.querySelector('.led.tx')!;
    this.rx = this.root.querySelector('.led.rx')!;
    this.warn = this.root.querySelector('.led.warn')!;
    this.render();
  }

  get channelId(): string {
    return CHANNELS[this.channel];
  }

  toggle(): void {
    this.open = !this.open;
    this.root.classList.toggle('open', this.open);
    this.render();
  }

  cycle(): void {
    this.channel = (this.channel + 1) % CHANNELS.length;
    this.render();
  }

  /** Number key pressed while the radio is up. */
  press(n: number): boolean {
    if (!this.open) return false;
    const cmd = COMMANDS[n - 1];
    if (!cmd) return false;
    const to = this.channelId;
    if (to !== 'all' && !this.sim.npc(to).alive) return false;
    this.onTransmit(to, cmd.id);
    this.sentFlash = { cmd: cmd.id, until: performance.now() + 700 };
    this.flash(this.tx, 600);
    this.render();
    return true;
  }

  /** A message arrived on the net. */
  receive(msg: RadioMessage): void {
    if (msg.from === 'player') return;
    this.last = msg;
    if (msg.status === 'unknown') {
      this.flash(this.warn, 4000);
      this.noiseUntil = performance.now() + 2500;
    } else this.flash(this.rx, 500 + msg.text.length * 20);
    if (msg.signal < 0.9) this.noiseUntil = Math.max(this.noiseUntil, performance.now() + 900);
    this.render();
  }

  render(): void {
    const s = this.sim;
    const ch = this.channelId;
    const now = performance.now();
    this.lcd.classList.toggle('noise', now < this.noiseUntil);
    const header = ch === 'all' ? 'CH 0 · ALL STATIONS' : `CH ${this.channel} · ${s.npc(ch).name.toUpperCase()}`;
    const mySignal = s.radio.signalFor(s.player.room);
    let body = '';
    if (ch === 'all') {
      body = `<div class="team">${s.npcs
        .map((n) => `<div class="row"><span>${n.name.toUpperCase()}</span><span class="bars">${bars(n.alive ? n.signal() : 0)}</span><span>♥${String(n.heartRate).padStart(3, ' ')}</span></div>`)
        .join('')}</div>`;
    } else {
      const n = s.npc(ch);
      const room = n.alive ? (n.room ? s.map.roomAtWorld(n.pos) : undefined) : undefined;
      const roomName = room ? (s.facility.lightMode(room) === 'off' ? `${room.toUpperCase()} (DARK)` : room.toUpperCase()) : '—';
      body = `<div class="row"><span>LOC ${roomName}</span><span class="bars">${bars(n.alive ? n.signal() : 0)}</span></div>
              <div class="row"><span>♥ ${n.heartRate} BPM</span><span class="dim">${n.p.role.toUpperCase()}</span></div>
              <div class="row"><span>${n.activity.toUpperCase()}</span></div>`;
    }
    const cmds = this.open
      ? `<div class="sep"></div>${COMMANDS.map((c, i) => `<div class="cmd${this.sentFlash && this.sentFlash.cmd === c.id && now < this.sentFlash.until ? ' sent' : ''}"><b>${i + 1}</b>${c.label.toUpperCase()}</div>`).join('')}`
      : '';
    const last = this.last;
    const lastLine = last
      ? `<div class="sep"></div><div class="last">${last.status === 'unknown' ? '<span class="flag" style="color:var(--bad)">UNREG TX</span> ' : ''}${last.from === 'unknown' ? '???' : last.from.toUpperCase()}: ${last.text}</div>`
      : '';
    this.lcd.innerHTML = `<div class="row"><span class="ch">${header}</span><span class="bars dim">${bars(mySignal)}</span></div><div class="sep"></div>${body}${cmds}${lastLine}`;
  }

  private flash(led: HTMLElement, ms: number): void {
    led.classList.add('on');
    setTimeout(() => led.classList.remove('on'), ms);
  }
}
