import type { RoomId, Vec2 } from './facility/FacilityMap';
import type { RadioMessage } from './radio/RadioSystem';
import type { NpcStateName } from './npc/NpcAgent';
import type { ScareEvent } from './entity/Listener';

/** Every fact the simulation publishes. Presentation layers subscribe to these. */
export interface SimEvents {
  doorChanged: { doorId: string; open: boolean; by: string };
  doorDenied: { doorId: string; by: string; reason: 'locked' | 'keycard' };
  lightsChanged: { room: RoomId };
  powerChanged: { online: boolean; reason: string };
  noise: { pos: Vec2; loudness: number; source: string; time: number };
  radioMessage: RadioMessage;
  radioStatic: { intensity: number; duration: number };
  npcStateChanged: { npcId: string; from: NpcStateName; to: NpcStateName };
  objectiveChanged: { id: string; text: string };
  shiftEnded: { reason: string };
  /** THE LISTENER shows itself. */
  scare: ScareEvent;
}
