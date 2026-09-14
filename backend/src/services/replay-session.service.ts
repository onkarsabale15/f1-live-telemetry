import { DriverInfo, DriverLiveState, RaceSnapshot, SessionMeta, TyreCompound } from '../domain/models';
import { computeCircuitBounds } from '../domain/formulas';
import getPrismaClient from '../db/prisma.client';
import { openF1Service, OpenF1Session } from './openf1.service';
import { replayDbService } from './replay-db.service';
import { ingestionService } from './ingestion.service';
import { overtakePredictionService, IntervalHistory } from './prediction.service';

/**
 * Stateless per-request replay support — every function here takes whatever
 * it needs as a parameter instead of reading shared instance fields, so a
 * per-socket "viewer" can call these independently without stepping on any
 * other viewer's session or scrub position. This is what makes two browser
 * tabs able to browse two completely different races (or the same race at
 * two different points in time) without one affecting the other — unlike
 * the single shared SimulationEngine, which is now used only for the one
 * genuinely shared thing: the live broadcast (see socket.server.ts).
 */

/** The furthest lap number any driver had started by `targetMs`, per the session's cached lap-start timestamps. */
export function getLapAtTime(lapsCache: any[], targetMs: number): number {
  let maxLap = 0;
  for (const lap of lapsCache) {
    if (!lap.date_start) continue;
    const startMs = new Date(lap.date_start).getTime();
    if (startMs <= targetMs && (lap.lap_number || 0) > maxLap) {
      maxLap = lap.lap_number;
    }
  }
  return maxLap;
}

/** Each driver's active tyre stint (compound + age) as of `currentLap`, picking the latest stint that had already started by then. */
export function computeStintsAtLap(
  stintsCache: any[],
  currentLap: number
): Map<number, { compound: TyreCompound; age: number }> {
  const latestByDriver = new Map<number, any>();
  for (const stint of stintsCache) {
    if ((stint.lap_start || 0) > currentLap) continue;
    const existing = latestByDriver.get(stint.driver_number);
    if (!existing || stint.stint_number > existing.stint_number) {
      latestByDriver.set(stint.driver_number, stint);
    }
  }

  const validCompounds: TyreCompound[] = ['SOFT', 'MEDIUM', 'HARD', 'INTERMEDIATE', 'WET'];
  const result = new Map<number, { compound: TyreCompound; age: number }>();
  for (const [driverNum, stint] of latestByDriver) {
    const compound = (stint.compound || 'UNKNOWN').toUpperCase() as TyreCompound;
    const tyreAge = Math.max(
      0,
      (currentLap || stint.lap_end || 0) - (stint.lap_start || 0) + (stint.tyre_age_at_start || 0)
    );
    result.set(driverNum, { compound: validCompounds.includes(compound) ? compound : 'UNKNOWN', age: tyreAge });
  }
  return result;
}

export interface ReplaySnapshotParams {
  sessionKey: number;
  atMs: number;
  drivers: DriverInfo[];
  lapsCache: any[];
  stintsCache: any[];
  hasGapData: boolean;
  intervalHistory: IntervalHistory;
}

/** The DB-backed equivalent of SimulationEngine.buildSnapshot() — computed fresh per call, no shared state. */
export async function buildReplaySnapshot(params: ReplaySnapshotParams): Promise<RaceSnapshot> {
  const { sessionKey, atMs, drivers, lapsCache, stintsCache, hasGapData, intervalHistory } = params;
  const dbSnapshot = await replayDbService.getSnapshotAtTime(sessionKey, atMs);
  const currentLap = getLapAtTime(lapsCache, atMs);
  const stints = computeStintsAtLap(stintsCache, currentLap);

  const grid: DriverLiveState[] = [];
  for (const driver of drivers) {
    const num = driver.driverNumber;
    const loc = dbSnapshot.locations.get(num);
    if (!loc) continue;
    const tel = dbSnapshot.telemetry.get(num);
    const intv = dbSnapshot.intervals.get(num);
    const pos = dbSnapshot.positions.get(num);
    const stint = stints.get(num);
    grid.push({
      driverNumber: num,
      position: pos || 20,
      x: loc.x,
      y: loc.y,
      z: loc.z,
      speed: tel?.speed || 0,
      rpm: tel?.rpm || 0,
      gear: tel?.gear || 0,
      throttle: tel?.throttle || 0,
      brake: tel?.brake || 0,
      drs: tel?.drs || false,
      gapToLeader: intv?.gapToLeader || 0,
      intervalToAhead: intv?.interval || 0,
      compound: stint?.compound || 'UNKNOWN',
      tyreAge: stint?.age || 0,
    });
  }
  grid.sort((a, b) => a.position - b.position);

  const driversMap = new Map(drivers.map((d) => [d.driverNumber, d]));
  const activeBattles = hasGapData
    ? overtakePredictionService.analyzeBattles(grid, driversMap, atMs, intervalHistory)
    : [];
  const carMap = new Map(grid.map((c) => [c.driverNumber, c]));
  activeBattles.forEach((battle) => {
    const chaserCar = carMap.get(battle.chaser.driverNumber);
    const defenderCar = carMap.get(battle.defender.driverNumber);
    if (chaserCar) battle.drsActive = chaserCar.drs;
    if (chaserCar && defenderCar) battle.speedDelta = chaserCar.speed - defenderCar.speed;
  });

  return {
    sessionKey,
    timestamp: new Date().toISOString(),
    lapNumber: currentLap,
    hasGapData,
    grid,
    activeBattles,
  };
}

export interface ResolvedSession {
  session: OpenF1Session;
  isLive: boolean;
  isUpcoming: boolean;
  isArchived: boolean;
  hasGapData: boolean;
  hasDrs: boolean;
}

/** Looks up a session by key, or the latest one if no key given (the default a fresh tab opens to). */
export async function resolveSession(sessionKey?: number): Promise<ResolvedSession | null> {
  let session: OpenF1Session | null = null;
  if (sessionKey) session = await openF1Service.getSessionByKey(sessionKey);
  if (!session) session = await openF1Service.getLatestSession();
  if (!session) return null;

  const isLive = openF1Service.isSessionLive(session);
  const isUpcoming = openF1Service.isSessionUpcoming(session);
  const hasGapData = openF1Service.sessionHasGapData(session);
  const hasDrs = openF1Service.sessionHasDrs(session);
  const isArchived = !isLive && !isUpcoming && (await replayDbService.isFullyIngested(session.session_key));

  return { session, isLive, isUpcoming, isArchived, hasGapData, hasDrs };
}

export interface ArchivedReplayMeta {
  sessionMeta: SessionMeta;
  drivers: DriverInfo[];
  lapsCache: any[];
  stintsCache: any[];
  sessionStartMs: number;
  sessionEndMs: number;
}

/** Loads everything a per-tab replay viewer needs from Postgres — no OpenF1 calls. */
export async function loadArchivedReplayMeta(sessionKey: number): Promise<ArchivedReplayMeta | null> {
  const prisma = getPrismaClient();
  if (!prisma) return null;

  const row = await prisma.raceSession.findUnique({ where: { sessionKey }, include: { circuit: true } });
  if (!row || row.ingestStatus !== 'COMPLETE') return null;

  const trackPath = (row.trackPath as any) || [];
  const bounds = computeCircuitBounds(trackPath);
  const sessionMeta: SessionMeta = {
    sessionKey: row.sessionKey,
    circuitKey: row.circuitKey,
    circuitShortName: row.circuit.circuitShortName,
    countryName: row.circuit.countryName,
    location: row.circuit.location,
    year: row.year,
    sessionName: row.sessionName,
    sessionType: row.sessionType,
    hasGapData: row.hasGapData,
    hasDrs: row.hasDrs,
    bounds,
    trackPath,
  };

  const [drivers, { laps, stints }] = await Promise.all([
    replayDbService.getDriversInfo(sessionKey),
    replayDbService.getLapsAndStints(sessionKey),
  ]);

  return {
    sessionMeta,
    drivers: drivers as DriverInfo[],
    lapsCache: laps,
    stintsCache: stints,
    sessionStartMs: row.sessionStartMs ? Number(row.sessionStartMs) : 0,
    sessionEndMs: row.sessionEndMs ? Number(row.sessionEndMs) : 0,
  };
}

function realSessionStartMs(laps: any[], session: OpenF1Session): number {
  let earliestMs: number | null = null;
  for (const lap of laps) {
    if (!lap.date_start) continue;
    const start = new Date(lap.date_start).getTime();
    if (earliestMs === null || start < earliestMs) earliestMs = start;
  }
  return earliestMs ?? new Date(session.date_start).getTime();
}

function realSessionEndMs(laps: any[], session: OpenF1Session): number {
  let latestMs: number | null = null;
  for (const lap of laps) {
    if (!lap.date_start || typeof lap.lap_duration !== 'number') continue;
    const end = new Date(lap.date_start).getTime() + lap.lap_duration * 1000;
    if (latestMs === null || end > latestMs) latestMs = end;
  }
  return latestMs ?? new Date(session.date_end).getTime();
}

export interface ArchivingResult {
  sessionMeta: SessionMeta;
  drivers: DriverInfo[];
  sessionStartMs: number;
  sessionEndMs: number;
}

/**
 * A completed session nobody has ever opened yet has no RaceSession/Circuit/
 * Driver rows and hasn't started archiving. Creates the metadata row (same
 * shape SimulationEngine.upsertSessionRecord writes for the live/auto-follow
 * session) and kicks off archival, fire-and-forget. Building a full replay
 * grid from OpenF1 for this in-between moment isn't worth the extra
 * complexity — the client shows "archiving" and switches to the normal
 * DB-backed path once ensureIngested finishes (usually a few minutes).
 *
 * Returns the metadata just built (so the caller can send an immediate
 * session_init instead of waiting), or null if another trigger already has
 * this session covered — the caller should fall back to whatever partial
 * state already exists (e.g. re-poll ingest-status).
 */
export async function ensureSessionArchiving(resolved: ResolvedSession): Promise<ArchivingResult | null> {
  const prisma = getPrismaClient();
  if (!prisma) return null;
  const { session, hasGapData, hasDrs } = resolved;
  const sessionKey = session.session_key;

  const existing = await prisma.raceSession.findUnique({ where: { sessionKey }, select: { ingestStatus: true } });
  if (existing?.ingestStatus === 'COMPLETE' || existing?.ingestStatus === 'IN_PROGRESS') return null;

  const [drivers, laps] = await Promise.all([
    openF1Service.getDrivers(sessionKey),
    openF1Service.getLatestLaps(sessionKey),
  ]);

  const sessionStartMs = realSessionStartMs(laps, session);
  const sessionEndMs = realSessionEndMs(laps, session);
  if (sessionEndMs <= sessionStartMs) return null;

  // A small bounded window near the end of the session is enough to trace
  // the track shape — matches the approach used for the live/auto-follow
  // session, no need to pull the full unbounded location history just for this.
  const windowStart = new Date(sessionEndMs - 90_000).toISOString();
  const windowEnd = new Date(sessionEndMs).toISOString();
  const locations = await openF1Service.getLocations(sessionKey, windowStart, windowEnd);
  const trackPath = openF1Service.buildTrackPath(locations);
  const bounds = computeCircuitBounds(trackPath);

  await prisma.circuit.upsert({
    where: { circuitKey: session.circuit_key },
    create: {
      circuitKey: session.circuit_key,
      circuitShortName: session.circuit_short_name,
      countryName: session.country_name,
      location: session.location,
    },
    update: {
      circuitShortName: session.circuit_short_name,
      countryName: session.country_name,
      location: session.location,
    },
  });

  await prisma.raceSession.upsert({
    where: { sessionKey },
    create: {
      sessionKey,
      sessionName: session.session_name,
      sessionType: session.session_type,
      circuitKey: session.circuit_key,
      year: session.year,
      meetingKey: session.meeting_key,
      dateStart: new Date(session.date_start),
      dateEnd: new Date(session.date_end),
      hasGapData,
      hasDrs,
      trackPath: trackPath as any,
      sessionStartMs: BigInt(Math.round(sessionStartMs)),
      sessionEndMs: BigInt(Math.round(sessionEndMs)),
    },
    update: {
      hasGapData,
      hasDrs,
      trackPath: trackPath as any,
      sessionStartMs: BigInt(Math.round(sessionStartMs)),
      sessionEndMs: BigInt(Math.round(sessionEndMs)),
    },
  });

  for (const d of drivers) {
    await prisma.driver.upsert({
      where: { driverNumber: d.driverNumber },
      create: {
        driverNumber: d.driverNumber,
        broadcastName: d.broadcastName,
        fullName: d.fullName,
        nameAcronym: d.nameAcronym,
        countryCode: d.countryCode,
        headshotUrl: d.headshotUrl || null,
      },
      update: {
        broadcastName: d.broadcastName,
        fullName: d.fullName,
        nameAcronym: d.nameAcronym,
        countryCode: d.countryCode,
        headshotUrl: d.headshotUrl || null,
      },
    });
    await prisma.sessionDriver.upsert({
      where: { sessionKey_driverNumber: { sessionKey, driverNumber: d.driverNumber } },
      create: { sessionKey, driverNumber: d.driverNumber, teamName: d.teamName, teamColour: d.teamColour },
      update: { teamName: d.teamName, teamColour: d.teamColour },
    });
  }

  ingestionService
    .ensureIngested(sessionKey, { sessionStartMs, sessionEndMs, hasGapData })
    .catch((err: any) => console.error(`Failed to queue ingestion for session ${sessionKey}:`, err?.message));

  const sessionMeta: SessionMeta = {
    sessionKey,
    circuitKey: session.circuit_key,
    circuitShortName: session.circuit_short_name,
    countryName: session.country_name,
    location: session.location,
    year: session.year,
    sessionName: session.session_name,
    sessionType: session.session_type,
    hasGapData,
    hasDrs,
    bounds,
    trackPath,
  };

  return { sessionMeta, drivers, sessionStartMs, sessionEndMs };
}
