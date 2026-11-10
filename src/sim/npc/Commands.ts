import type { RoomId } from '../facility/FacilityMap';

export type CommandId =
  | 'follow'
  | 'stay'
  | 'goto_generator'
  | 'repair_power'
  | 'dont_open_door'
  | 'lights_off'
  | 'investigate_noise'
  | 'return_control'
  | 'status';

export interface CommandDef {
  id: CommandId;
  /** Label in the radio menu. */
  label: string;
  /** What the player is heard saying over the radio. */
  phrase: string;
  /** Fixed destination, if the instruction implies one. */
  targetRoom?: RoomId;
  /**
   * How easy the instruction is to read differently (0..1). "Turn off the
   * lights" never says *which* lights; "Return to the control room" is clear.
   */
  ambiguity: number;
}

export const COMMANDS: readonly CommandDef[] = [
  { id: 'follow', label: 'Follow me', phrase: 'Follow me.', ambiguity: 0.35 },
  { id: 'stay', label: 'Stay here', phrase: 'Stay where you are.', ambiguity: 0.1 },
  { id: 'goto_generator', label: 'Go to the generator', phrase: 'Go to the generator room.', targetRoom: 'generator', ambiguity: 0.15 },
  { id: 'repair_power', label: 'Repair the power', phrase: 'Get the power back on.', targetRoom: 'generator', ambiguity: 0.4 },
  { id: 'dont_open_door', label: 'Do not open the door', phrase: 'Do not open the door.', ambiguity: 0.7 },
  { id: 'lights_off', label: 'Turn off the lights', phrase: 'Turn off the lights.', ambiguity: 0.75 },
  { id: 'investigate_noise', label: 'Investigate the noise', phrase: 'Check out that noise.', ambiguity: 0.45 },
  { id: 'return_control', label: 'Return to control', phrase: 'Come back to the control room.', targetRoom: 'control', ambiguity: 0.1 },
  { id: 'status', label: 'Status report', phrase: 'Status report.', ambiguity: 0 },
];

export function command(id: CommandId): CommandDef {
  return COMMANDS.find((c) => c.id === id)!;
}
