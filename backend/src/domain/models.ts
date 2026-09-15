/**
 * Core domain types shared across the backend — OpenF1-derived shapes, the
 * live/replay grid state broadcast to clients, and session metadata. These
 * mirror (and are kept in sync with) frontend/src/types/f1.ts.
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

/** One raw OpenF1 `/location` sample — a car's world-space (x, y, z) position at an instant. */
export interface CarLocationPoint {
  date: string;
  driverNumber: number;
  x: number;
  y: number;
  z: number;
}

/** One raw OpenF1 `/car_data` sample — engine/pedal telemetry at an instant. */
export interface CarTelemetryPoint {
  date: string;
  driverNumber: number;
  speed: number;
  rpm: number;
  gear: number;
  throttle: number; // 0 - 100
  brake: number; // 0 - 100
  drs: number; // 0, 8, 10, 12, 14 (OpenF1 DRS codes)
}

/** One tyre stint (a run on a single set of tyres between pit stops). */
export interface StintInfo {
  driverNumber: number;
  stintNumber: number;
  compound: TyreCompound;
  tyreAgeAtStart: number;
  lapsRun: number;
}

/** A driver's timing gaps as of a sample — to the car ahead and to the race leader. */
export interface IntervalInfo {
  driverNumber: number;
  gapToLeader: number;
  intervalToAhead: number;
}

/**
 * One driver's complete state at a single instant — the unit that makes up
 * a RaceSnapshot's `grid`. Combines position, car telemetry, timing gaps,
 * and current tyre into the shape every UI panel reads from.
 */
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

/** A predicted overtake opportunity between two adjacent cars, computed by OvertakePredictionService. */
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
  gap: number; // seconds
  closingRate: number; // seconds gained per lap (>0 means catching)
  drsEligible: boolean; // gap <= 1.0s
  tyreDeltaFactor: number;
  probability: number; // 0 - 100 %
  estLapsToPass: number; // e.g. 2.4
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  drsActive?: boolean;
  speedDelta?: number;
  /** Defender's last completed lap time minus chaser's (s/lap) — positive means the chaser is genuinely lapping faster right now. Undefined when either driver's last lap isn't known yet (early race, out-lap). */
  paceDeltaPerLap?: number;
  /** estLapsToPass converted to a wall-clock estimate using the battle's own recent lap times — undefined under the same conditions as estLapsToPass being a real (non-"stalemate") figure. */
  estTimeToPassSeconds?: number;
}

/** Axis-aligned bounding box of a circuit's traced reference points, used to scale it onto the canvas. */
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
  hasGapData: boolean; // Gaps/intervals only exist for Race & Sprint sessions
  // 2026 regulations removed traditional DRS in favor of a Manual Override
  // Mode on the new active-aero system — same proximity-gated overtake aid,
  // different name and (per OpenF1) no longer reported via car_data.drs.
  // true for 2025-and-earlier seasons, false from 2026 onward.
  hasDrs: boolean;
  bounds: CircuitBounds;
  trackPath: TrackReferencePoint[];
}

/** A full grid snapshot at one instant — what gets broadcast to clients on every tick (live or replay). */
export interface RaceSnapshot {
  sessionKey: number;
  timestamp: string;
  lapNumber: number;
  hasGapData: boolean;
  grid: DriverLiveState[];
  activeBattles: OvertakeBattle[];
}
