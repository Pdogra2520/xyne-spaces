export type Stance = 'for' | 'against' | 'conditional' | 'unknown';

export interface Persona {
  name: string;
  role: string;
  goals: string;
  biases: string;
  redLines: string;
}

export interface Seat {
  id: string;
  label: string;
  kind: 'agent' | 'persona';
  agentSlug?: string;
  persona?: Persona;
  patternRole: string;
}

/** all = full transcript, own-side = only turns from the same role, none = blind round */
export type Visibility = 'all' | 'own-side' | 'none';

export interface RoundDef {
  name: string;
  speakers: string[];
  task: string;
  visibility: Visibility;
  parallel?: boolean;
}

export type OutcomeContract = 'go-no-go' | 'choose-one' | 'ranked-list' | 'risk-register' | 'recommendation';

export interface PatternRole {
  id: string;
  label: string;
  min: number;
  brief: string;
}

export interface Pattern {
  id: string;
  name: string;
  description: string;
  roles: PatternRole[];
  rounds: RoundDef[];
  repeat?: RoundDef[];
  maxRounds: number;
  stopWhenStable: boolean;
  defaultOutcome: OutcomeContract;
}

export interface Limits {
  maxSeats: number;
  maxRounds: number;
  maxRuns: number;
  turnTimeoutMs: number;
}

export interface RoomConfig {
  version: 1;
  title: string;
  question: string;
  context: string;
  constraints: string;
  channelId: string;
  patternId: string;
  outcome: OutcomeContract;
  options: string[];
  seats: Seat[];
  limits: Limits;
  judgeAgent: string;
  personaAgent: string;
}

export interface Turn {
  id: string; // R<round>-S<seat>
  round: number;
  roundName: string;
  seatId: string;
  seatLabel: string;
  patternRole: string;
  stance: Stance;
  changedMind: boolean;
  text: string;
  status: 'ok' | 'timeout' | 'error';
}

export interface Intervention {
  afterRound: number;
  text: string;
}

export interface DecisionRecord {
  decision: string;
  rationale: string;
  strongestFor: string[];
  strongestAgainst: string[];
  dissent: string[];
  openRisks: string[];
  confidence: 'low' | 'medium' | 'high';
  followUps: string[];
  citedTurns: string[];
}

export type RoomStatus = 'idle' | 'running' | 'paused' | 'judging' | 'done' | 'stopped' | 'failed';

export type RoomEvent =
  | { type: 'status'; status: RoomStatus; detail?: string }
  | { type: 'round-start'; round: number; roundName: string; seatIds: string[] }
  | { type: 'turn'; turn: Turn }
  | { type: 'runs'; used: number; max: number }
  | { type: 'decision'; record: DecisionRecord; canvasUrl: string | null }
  | { type: 'error'; message: string };

export const DEFAULT_LIMITS: Limits = { maxSeats: 8, maxRounds: 5, maxRuns: 50, turnTimeoutMs: 120_000 };
/** Users can lower limits, never raise them past these. */
export const HARD_LIMITS: Limits = { maxSeats: 8, maxRounds: 5, maxRuns: 50, turnTimeoutMs: 120_000 };
