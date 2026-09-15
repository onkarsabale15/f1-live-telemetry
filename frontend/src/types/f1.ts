/**
 * Shared frontend types — mirrors backend/src/domain/models.ts for the
 * shapes that travel over the socket/REST boundary, plus a few
 * frontend-only response shapes for the analytics panels.
 */

export type TyreCompound = 'SOFT' | 'MEDIUM' | 'HARD' | 'INTERMEDIATE' | 'WET' | 'UNKNOWN';

/** A driver's stable bio/identity — name, team, headshot. Keyed by their permanent race number. */
export interface DriverInfo {
  driverNumber: number;
  broadcastName: string;
  fullName: string;
  nameAcronym: string;
  teamName: string;
  teamColour: string;
  countryCode: string;
  headshotUrl?: string;
}

/** One driver's complete state at a single instant — position, telemetry, gaps, and current tyre. */
export interface DriverLiveState {
  driverNumber: number;
  position: number;
  x: number;
  y: number;
  z: number;
  speed: number;
  rpm: number;
  gear: number;
  throttle: number;
  brake: number;
  drs: boolean;
  gapToLeader: number;
  intervalToAhead: number;
  compound: TyreCompound;
  tyreAge: number;
}

/** A predicted overtake opportunity between two adjacent cars. */
export interface OvertakeBattle {
  battleId: string;
  chaser: {
    driverNumber: number;
    code: string;
    team: string;
    teamColor: string;
    compound: TyreCompound;
    tyreAge: number;
  };
  defender: {
    driverNumber: number;
    code: string;
    team: string;
    teamColor: string;
    compound: TyreCompound;
    tyreAge: number;
  };
  gap: number;
  closingRate: number;
  drsEligible: boolean;
  tyreDeltaFactor: number;
  probability: number;
  estLapsToPass: number;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  drsActive?: boolean;
  speedDelta?: number;
  /** Defender's last lap time minus chaser's (s/lap) — positive means the chaser is genuinely lapping faster right now. */
  paceDeltaPerLap?: number;
  /** estLapsToPass converted to a wall-clock estimate using the pair's own recent lap times. Undefined once estLapsToPass reads as a "stalemate". */
  estTimeToPassSeconds?: number;
}

/** Axis-aligned bounding box of a circuit's traced outline, used to scale it onto the canvas. */
export interface CircuitBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  width: number;
  height: number;
}

/** One point along the circuit's traced outline, in raw world-space coordinates. */
export interface TrackReferencePoint {
  x: number;
  y: number;
}

/** Static metadata for a session — circuit, timing, and which optional data/rules apply. */
export interface SessionMeta {
  sessionKey: number;
  circuitKey: number;
  circuitShortName: string;
  countryName: string;
  location: string;
  year: number;
  sessionName: string;
  sessionType: string;
  hasGapData: boolean;
  // 2026 regulations replaced DRS with a Manual Override Mode on the new
  // active-aero system — same proximity-gated overtake aid, new name.
  // true for 2025-and-earlier seasons, false from 2026 onward.
  hasDrs: boolean;
  bounds: CircuitBounds;
  trackPath: TrackReferencePoint[];
}

// --- Race Control ---

export type TrackStatus = 'GREEN' | 'YELLOW' | 'DOUBLE_YELLOW' | 'SC' | 'VSC' | 'RED' | 'CHEQUERED';

/** One race control event — a flag, safety car/VSC change, penalty, or investigation note. */
export interface RaceControlMessage {
  date: string;
  category: string;
  flag: string | null;
  scope: string | null;
  sector: number | null;
  driverNumber: number | null;
  lapNumber: number | null;
  message: string;
}

/** Response from GET /api/sessions/:sessionKey/race-control — the derived current track status plus the message feed. */
export interface RaceControlResult {
  sessionKey: number;
  trackStatus: TrackStatus;
  trackStatusMessage: string | null;
  messages: RaceControlMessage[];
}

/** Live/replay playback status for this tab's own session — see PlaybackBar and useF1Socket. */
export interface PlaybackState {
  isPlaying: boolean;
  isLive: boolean;
  speed: 1 | 2 | 4;
  currentTick: number;
  totalTicks: number;
  sessionKey: number;
  // Real wall-clock bounds of the session's recorded data (ms epoch) — used
  // to render a scrubbable time slider for completed sessions. Not
  // meaningful for a live session.
  sessionStartMs: number;
  sessionEndMs: number;
  // Current scrub position (completed session) or "now" (live session).
  positionMs: number;
}

/** A full grid snapshot at one instant — what the socket delivers on every tick (live or replay). */
export interface RaceSnapshot {
  sessionKey: number;
  timestamp: string;
  lapNumber: number;
  hasGapData: boolean;
  grid: DriverLiveState[];
  activeBattles: OvertakeBattle[];
}

// --- Match Explorer ---

/** One session row as listed by the Match Explorer — raw OpenF1 field names plus derived live/upcoming flags. */
export interface ExplorerSession {
  session_key: number;
  session_name: string;
  session_type: string;
  circuit_key: number;
  circuit_short_name: string;
  country_name: string;
  country_code: string;
  location: string;
  date_start: string;
  date_end: string;
  year: number;
  meeting_key: number;
  isLive: boolean;
  isUpcoming: boolean;
}

// --- Driver Comparison ---

/** One lap's timing — total and per-sector, when available. */
export interface LapTimeEntry {
  lap: number;
  time: number;
  sector1: number | null;
  sector2: number | null;
  sector3: number | null;
}

/** One tyre stint's lap range and compound, as shown on the strategy timeline. */
export interface TyreStintSummary {
  stintNumber: number;
  compound: TyreCompound;
  lapStart: number;
  lapEnd: number | null;
  tyreAgeAtStart: number;
}

/** One pit stop's lap number and duration (duration `null` if not yet known). */
export interface PitStopSummary {
  lap: number;
  duration: number | null;
}

/** Heuristic estimate of when a driver's current tyre is due for a change, and how confident that estimate is. */
export interface PredictedTyreChange {
  compound: TyreCompound;
  currentAge: number;
  typicalStintLife: number;
  degradationSlopeSecPerLap: number;
  estimatedLapsRemaining: number;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
}

/** One driver's full comparison data — pace, stints, pit stops, and a predicted next tyre change. */
export interface DriverComparisonSummary {
  driverNumber: number;
  info: DriverInfo | null;
  lapTimes: LapTimeEntry[];
  bestLap: LapTimeEntry | null;
  avgLap: number | null;
  stints: TyreStintSummary[];
  pitStops: PitStopSummary[];
  predictedTyreChange: PredictedTyreChange | null;
}

// --- Tyre Strategy Timeline (full grid) ---

/** One driver's full-race stint + pit-stop history, as shown on the timeline. */
export interface DriverTyreStrategy {
  driverNumber: number;
  info: DriverInfo | null;
  stints: TyreStintSummary[];
  pitStops: PitStopSummary[];
}

/** Response from GET /api/sessions/:sessionKey/tyre-strategy. */
export interface TyreStrategyResult {
  sessionKey: number;
  totalLaps: number;
  drivers: DriverTyreStrategy[];
}

/** Response from GET /api/sessions/:sessionKey/compare — up to 3 drivers' comparison data plus pace deltas. */
export interface ComparisonResult {
  sessionKey: number;
  drivers?: DriverComparisonSummary[];
  driver1: DriverComparisonSummary;
  driver2?: DriverComparisonSummary | null;
  driver3?: DriverComparisonSummary | null;
  paceDeltaBest: number | null;
  paceDeltaAvg: number | null;
}
