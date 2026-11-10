/**
 * Presentation timers (subtitle fades, LED flashes, toasts). Normally backed
 * by real time. In manual mode (offline video capture, deterministic tests)
 * time only moves when `advance()` is called, so UI timing matches game time.
 */
class TimerService {
  manual = false;
  private virtualNow = 0;
  private queue: { at: number; fn: () => void }[] = [];

  now(): number {
    return this.manual ? this.virtualNow : performance.now();
  }

  after(ms: number, fn: () => void): void {
    if (!this.manual) {
      window.setTimeout(fn, ms);
      return;
    }
    this.queue.push({ at: this.virtualNow + ms, fn });
  }

  /** Manual mode only: move virtual time forward and fire due timers. */
  advance(ms: number): void {
    this.virtualNow += ms;
    const due = this.queue.filter((t) => t.at <= this.virtualNow).sort((a, b) => a.at - b.at);
    this.queue = this.queue.filter((t) => t.at > this.virtualNow);
    for (const t of due) t.fn();
  }
}

export const timers = new TimerService();
