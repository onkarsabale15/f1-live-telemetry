export type TyreCompound = 'SOFT' | 'MEDIUM' | 'HARD' | 'INTERMEDIATE' | 'WET' | 'UNKNOWN';

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
}

export interface CircuitBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  width: number;
  height: number;
}

export interface TrackReferencePoint {
  x: number;
  y: number;
}

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

export interface RaceControlResult {
  sessionKey: number;
  trackStatus: TrackStatus;
  trackStatusMessage: string | null;
  messages: RaceControlMessage[];
}

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

export interface RaceSnapshot {
  sessionKey: number;
  timestamp: string;
  lapNumber: number;
  hasGapData: boolean;
  grid: DriverLiveState[];
  activeBattles: OvertakeBattle[];
}

// --- Match Explorer ---

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

export interface LapTimeEntry {
  lap: number;
  time: number;
  sector1: number | null;
  sector2: number | null;
  sector3: number | null;
}

export interface TyreStintSummary {
  stintNumber: number;
  compound: TyreCompound;
  lapStart: number;
  lapEnd: number | null;
  tyreAgeAtStart: number;
}

export interface PitStopSummary {
  lap: number;
  duration: number | null;
}

export interface PredictedTyreChange {
  compound: TyreCompound;
  currentAge: number;
  typicalStintLife: number;
  degradationSlopeSecPerLap: number;
  estimatedLapsRemaining: number;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
}

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

export interface DriverTyreStrategy {
  driverNumber: number;
  info: DriverInfo | null;
  stints: TyreStintSummary[];
  pitStops: PitStopSummary[];
}

export interface TyreStrategyResult {
  sessionKey: number;
  totalLaps: number;
  drivers: DriverTyreStrategy[];
}

export interface ComparisonResult {
  sessionKey: number;
  drivers?: DriverComparisonSummary[];
  driver1: DriverComparisonSummary;
  driver2?: DriverComparisonSummary | null;
  driver3?: DriverComparisonSummary | null;
  paceDeltaBest: number | null;
  paceDeltaAvg: number | null;
}
