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

export interface CarLocationPoint {
  date: string;
  driverNumber: number;
  x: number;
  y: number;
  z: number;
}

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

export interface StintInfo {
  driverNumber: number;
  stintNumber: number;
  compound: TyreCompound;
  tyreAgeAtStart: number;
  lapsRun: number;
}

export interface IntervalInfo {
  driverNumber: number;
  gapToLeader: number;
  intervalToAhead: number;
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
  gap: number; // seconds
  closingRate: number; // seconds gained per lap (>0 means catching)
  drsEligible: boolean; // gap <= 1.0s
  tyreDeltaFactor: number;
  probability: number; // 0 - 100 %
  estLapsToPass: number; // e.g. 2.4
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
  hasGapData: boolean; // Gaps/intervals only exist for Race & Sprint sessions
  // 2026 regulations removed traditional DRS in favor of a Manual Override
  // Mode on the new active-aero system — same proximity-gated overtake aid,
  // different name and (per OpenF1) no longer reported via car_data.drs.
  // true for 2025-and-earlier seasons, false from 2026 onward.
  hasDrs: boolean;
  bounds: CircuitBounds;
  trackPath: TrackReferencePoint[];
}

export interface RaceSnapshot {
  sessionKey: number;
  timestamp: string;
  lapNumber: number;
  hasGapData: boolean;
  grid: DriverLiveState[];
  activeBattles: OvertakeBattle[];
}
