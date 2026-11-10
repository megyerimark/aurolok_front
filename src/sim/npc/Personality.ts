import type { RoomId } from '../facility/FacilityMap';

/**
 * Static personality traits, all 0..1. Dynamic values (fear, stress, trust)
 * live on the agent and start from the `initial*` fields here.
 *
 * This file is pure data: designers tune characters here without touching
 * behaviour code, the same role ScriptableObjects play in Unity.
 */
export interface Personality {
  id: string;
  name: string;
  role: string;
  /** Willingness to enter darkness / danger. */
  courage: number;
  /** Tendency to stop and assess before acting. Dampens reckless choices. */
  caution: number;
  /** Tendency to do what they are told. */
  obedience: number;
  /** Reads instructions word-for-word and keeps following them too long. */
  literalness: number;
  /** Acts on their own judgement when idle or when they disagree. */
  independence: number;
  /** Repair speed and quality. */
  technical: number;
  /** Notices details: noises, anomalies, oddities in transmissions. */
  awareness: number;
  /** Questions where an instruction came from. */
  suspicion: number;
  /** How well they absorb stress before making mistakes. */
  stressTolerance: number;
  /** Pride: understates fear in status reports. */
  pride: number;
  initialTrust: number;
  initialFear: number;
  /** Where they are when the shift starts. */
  startRoom: RoomId;
  /** Badge colour used for the UI channel and uniform trim. */
  color: string;
}

export const PERSONALITIES: readonly Personality[] = [
  {
    id: 'daniel',
    name: 'Daniel',
    role: 'Security Guard',
    courage: 0.9,
    caution: 0.15,
    obedience: 0.45,
    literalness: 0.2,
    independence: 0.85,
    technical: 0.3,
    awareness: 0.45,
    suspicion: 0.25,
    stressTolerance: 0.75,
    pride: 0.9,
    initialTrust: 0.6,
    initialFear: 0.05,
    startRoom: 'corridor',
    color: '#d9a441',
  },
  {
    id: 'emily',
    name: 'Emily',
    role: 'Research Scientist',
    courage: 0.2,
    caution: 0.7,
    obedience: 0.65,
    literalness: 0.3,
    independence: 0.3,
    technical: 0.95,
    awareness: 0.7,
    suspicion: 0.35,
    stressTolerance: 0.2,
    pride: 0.15,
    initialTrust: 0.7,
    initialFear: 0.2,
    startRoom: 'lab',
    color: '#5fb3c9',
  },
  {
    id: 'robert',
    name: 'Robert',
    role: 'Facilities Officer',
    courage: 0.5,
    caution: 0.5,
    obedience: 0.95,
    literalness: 0.95,
    independence: 0.05,
    technical: 0.55,
    awareness: 0.3,
    suspicion: 0.05,
    stressTolerance: 0.6,
    pride: 0.4,
    initialTrust: 0.85,
    initialFear: 0.1,
    startRoom: 'storage',
    color: '#9fb86a',
  },
  {
    id: 'lucas',
    name: 'Lucas',
    role: 'Systems Technician',
    courage: 0.55,
    caution: 0.65,
    obedience: 0.4,
    literalness: 0.25,
    independence: 0.55,
    technical: 0.75,
    awareness: 0.9,
    suspicion: 0.9,
    stressTolerance: 0.5,
    pride: 0.5,
    initialTrust: 0.5,
    initialFear: 0.1,
    startRoom: 'medical',
    color: '#c46a5a',
  },
];
