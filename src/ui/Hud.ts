import { timers } from '../core/Timers';
import type { RadioMessage } from '../sim/radio/RadioSystem';
import { formatTime, type IncidentReport } from '../sim/story/IncidentReport';
import type { HistoryEntry } from '../core/EventHistory';

const STATUS_TAG: Partial<Record<RadioMessage['status'], [string, string]>> = {
  accepted: ['ACK', 'var(--ok)'],
  hesitant: ['WAIT', 'var(--warn)'],
  questioned: ['CONFIRM?', 'var(--warn)'],
  independent: ['IGNORED', 'var(--bad)'],
  refused: ['REFUSED', 'var(--bad)'],
  no_response: ['NO REPLY', 'var(--bad)'],
  unknown: ['UNREGISTERED', 'var(--bad)'],
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, parent?: HTMLElement): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  parent?.appendChild(e);
  return e;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

/** Minimal, diegetic-leaning HUD. Everything that can live on the radio does. */
export class Hud {
  readonly root: HTMLElement;
  private crosshair: HTMLElement;
  private prompt: HTMLElement;
  private objective: HTMLElement;
  private inventory: HTMLElement;
  private subs: HTMLElement;
  private toastEl: HTMLElement;
  private overlay: HTMLElement;
  private flashEl: HTMLElement;
  private objectiveTimer = 0;
  private toastTimer = 0;

  constructor(root: HTMLElement) {
    this.root = root;
    this.crosshair = el('div', 'crosshair', root);
    this.prompt = el('div', 'prompt hidden', root);
    this.objective = el('div', 'objective stale', root);
    this.inventory = el('div', 'inventory', root);
    this.subs = el('div', 'subs', root);
    this.toastEl = el('div', 'toast', root);
    this.flashEl = el('div', 'flash', root);
    this.overlay = el('div', 'screen hidden', root);
  }

  setPrompt(text: string | null, key = 'E', progress?: number): void {
    this.crosshair.classList.toggle('active', !!text);
    if (!text) {
      this.prompt.classList.add('hidden');
      return;
    }
    this.prompt.classList.remove('hidden');
    const bar = progress !== undefined ? `<div class="bar"><div style="width:${Math.round(progress * 100)}%"></div></div>` : '';
    this.prompt.innerHTML = `${key ? `<span class="key">${key}</span>` : ''}${esc(text)}${bar}`;
  }

  setObjective(text: string): void {
    this.objective.innerHTML = `<span class="label">OBJECTIVE</span>${esc(text)}`;
    this.objective.className = 'objective fresh';
    const token = ++this.objectiveTimer;
    timers.after(9000, () => token === this.objectiveTimer && (this.objective.className = 'objective stale'));
  }

  setInventory(charge: number, batteries: number, keycard: boolean): void {
    const low = charge < 0.2 ? ' low' : '';
    this.inventory.innerHTML =
      `<div><div class="battery${low}"><div style="width:${Math.round(charge * 100)}%"></div></div><div style="margin-top:4px">LIGHT ${batteries > 0 ? `· ${batteries} SPARE` : ''}</div></div>` +
      (keycard ? '<div class="keycard">SECTOR R KEYCARD</div>' : '');
  }

  /** Full-screen flash (jumpscares). */
  flash(color: string, ms: number, opacity = 1): void {
    const f = this.flashEl;
    f.style.transition = 'none';
    f.style.background = color;
    f.style.opacity = String(opacity);
    void f.offsetWidth;
    f.style.transition = `opacity ${ms}ms ease-out`;
    f.style.opacity = '0';
  }

  toast(text: string, ms = 2200): void {
    this.toastEl.textContent = text;
    this.toastEl.classList.add('show');
    const token = ++this.toastTimer;
    timers.after(ms, () => token === this.toastTimer && this.toastEl.classList.remove('show'));
  }

  subtitle(msg: RadioMessage, speaker: string, color: string): void {
    const d = el('div', `sub${msg.status === 'unknown' ? ' unknown' : ''}`);
    const tag = STATUS_TAG[msg.status];
    d.innerHTML =
      `<span class="who" style="color:${color}">${esc(speaker.toUpperCase())}</span>${esc(msg.text)}` +
      (tag ? `<span class="tag" style="color:${tag[1]};border-color:${tag[1]}">${tag[0]}</span>` : '');
    this.subs.appendChild(d);
    while (this.subs.children.length > 4) this.subs.firstElementChild!.remove();
    const life = 3500 + msg.text.length * 55;
    timers.after(life, () => d.classList.add('fade'));
    timers.after(life + 900, () => d.remove());
  }

  // ------------------------------------------------------------- overlays

  get overlayOpen(): boolean {
    return !this.overlay.classList.contains('hidden');
  }

  hideOverlay(): void {
    this.overlay.classList.add('hidden');
    this.overlay.innerHTML = '';
  }

  showTitle(onBegin: () => void): void {
    this.overlay.classList.remove('hidden');
    this.overlay.innerHTML = `
      <div class="title">
        <h1>THE LAST INSTRUCTION</h1>
        <div class="tag">NIGHT SHIFT · SUBLEVEL 4 · CENTRAL CONTROL</div>
        <div class="begin">CLICK TO BEGIN SHIFT</div>
        <div class="controls">
          <b>WASD</b><span>move</span>
          <b>SHIFT / CTRL</b><span>sprint / crouch</span>
          <b>E</b><span>interact (hold for repairs)</span>
          <b>F</b><span>flashlight · <b>B</b> swap battery</span>
          <b>R</b><span>radio on / off</span>
          <b>Q</b><span>radio: change channel</span>
          <b>1–9</b><span>radio: transmit instruction</span>
          <b>ESC</b><span>pause</span>
        </div>
        <div class="small">Headphones strongly recommended. Audio is positional.<br/>
        You give the instructions. They make the decisions.</div>
      </div>`;
    this.overlay.querySelector('.begin')!.addEventListener('click', onBegin, { once: true });
  }

  showPause(onResume: () => void): void {
    this.overlay.classList.remove('hidden');
    this.overlay.innerHTML = `<div class="title"><h1 style="font-size:28px">PAUSED</h1><div class="begin">CLICK TO RESUME</div></div>`;
    this.overlay.querySelector('.begin')!.addEventListener('click', onResume, { once: true });
  }

  showNote(title: string, body: string): void {
    this.overlay.classList.remove('hidden');
    this.overlay.innerHTML = `<div class="note"><h3>${esc(title.toUpperCase())}</h3>${esc(body)}<div class="close">[E] PUT DOWN</div></div>`;
  }

  showReport(r: IncidentReport, reason: string, onRestart: () => void): void {
    const li = (e: HistoryEntry) => `<li><span class="t">${formatTime(e.time)}</span>${esc(e.text)}${e.reason ? ` <span class="why">(${esc(e.reason)})</span>` : ''}</li>`;
    const section = (title: string, items: HistoryEntry[], empty: string) => `<h4>${title}</h4><ul>${items.length ? items.map(li).join('') : `<li>${empty}</li>`}</ul>`;
    this.overlay.classList.remove('hidden');
    this.overlay.innerHTML = `
      <div class="report">
        <h2>INCIDENT REPORT</h2>
        <div class="meta">SUBLEVEL 4 · NIGHT SHIFT · DURATION ${formatTime(r.duration)} · SHIFT SEED ${r.seed >>> 0}</div>
        <div>${esc(reason)}</div>
        ${section('INSTRUCTIONS ISSUED', r.commands, 'None.')}
        ${section('HOW THEY RESPONDED', r.reactions, 'Every instruction was followed. As far as you know.')}
        ${section('MISTAKES', r.mistakes, 'None recorded.')}
        ${section('UNEXPECTED EVENTS', r.unexpected, 'None.')}
        ${section('MOST DANGEROUS MOMENTS', r.mostDangerous, 'None.')}
        <h4>PERSONNEL</h4>
        <ul>${r.personnel.map((p) => `<li>${esc(p.name)} — ${esc(p.role)}: <b>${esc(p.status)}</b> · trust in control ${Math.round(p.trust * 100)}%</li>`).join('')}</ul>
        <div class="stamp">CHAPTER 1 · END OF CURRENT BUILD</div><br/>
        <button>START A NEW SHIFT</button>
      </div>`;
    this.overlay.querySelector('button')!.addEventListener('click', onRestart, { once: true });
  }
}
