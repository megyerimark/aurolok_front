import type { SimWorld } from '../SimWorld';

export type Phase = 'checkin' | 'calm' | 'outage' | 'signal' | 'ended';

/**
 * Chapter 1 – THE SHIFT. A small, deliberately paced sequence of beats that
 * hands control to the systems as soon as possible: the outage is scripted,
 * how the team copes with it is not.
 */
export class StoryDirector {
  phase: Phase = 'checkin';
  objective = '';
  private phaseTime = 0;
  private transmissions = 0;
  private statusAsked = false;
  private unknownSent = false;

  constructor(private readonly w: SimWorld) {
    w.bus.on('powerChanged', (e) => {
      if (e.online && this.phase === 'outage') this.enter('signal');
    });
  }

  start(): void {
    this.enter('checkin');
  }

  /** Called by SimWorld whenever the player transmits. */
  onTransmit(isStatus: boolean): void {
    this.transmissions++;
    if (isStatus) this.statusAsked = true;
  }

  /** Called when the player reaches the restricted sector. */
  onEnterRestricted(): void {
    if (this.phase === 'signal') this.end('You entered the Restricted Research Sector.');
  }

  update(dt: number): void {
    this.phaseTime += dt;
    switch (this.phase) {
      case 'checkin':
        if (this.statusAsked || this.transmissions >= 2) this.enter('calm');
        break;
      case 'calm':
        if (this.phaseTime > 25) {
          this.w.facility.tripGenerator('generator overload. Breaker tripped.');
          this.enter('outage');
        }
        break;
      case 'signal':
        if (!this.unknownSent && this.phaseTime > 7) {
          this.unknownSent = true;
          this.w.unknownTransmission('...follow me... ...do not... ...the door...', 0.45);
        }
        break;
    }
  }

  private enter(phase: Phase): void {
    this.phase = phase;
    this.phaseTime = 0;
    const text: Record<Phase, string> = {
      checkin: 'Check in with your team. Open the radio [R] and ask for a status report.',
      calm: 'Monitor the facility. Your team is at their posts.',
      outage: 'Power failure. Get the generator running: send someone, or go yourself (Generator Room, west).',
      signal: 'Someone else is on the channel. The restricted keycard is in the Medical Room. Find the source.',
      ended: 'Shift over.',
    };
    this.objective = text[phase];
    this.w.bus.emit('objectiveChanged', { id: phase, text: this.objective });
    this.w.history.record({ time: this.w.time, category: 'story', actor: 'story', text: `Objective: ${this.objective}` });
  }

  end(reason: string): void {
    if (this.phase === 'ended') return;
    this.enter('ended');
    this.w.bus.emit('shiftEnded', { reason });
  }
}
