import getPrismaClient from '../db/prisma.client';
import { TyreCompound } from '../domain/models';

export interface DbSnapshotData {
  locations: Map<number, { x: number; y: number; z: number }>;
  telemetry: Map<number, { speed: number; rpm: number; gear: number; throttle: number; brake: number; drs: boolean }>;
  intervals: Map<number, { interval: number; gapToLeader: number }>;
  positions: Map<number, number>;
}

interface LocationRow { driverNumber: number; x: number; y: number; z: number }
interface TelemetryRow { driverNumber: number; speed: number; rpm: number; gear: number; throttle: number; brake: number; drs: number }
interface IntervalRow { driverNumber: number; interval: number | null; gapToLeader: number | null }
interface PositionRow { driverNumber: number; position: number }

/**
 * Serves replay/scrub snapshots straight from Postgres once a session has
 * been fully ingested — no OpenF1 calls, no rate limit, cheap enough to
 * query on every tick for a near-continuous "second by second" scrub feel
 * instead of the ~7.5s cadence the tiered OpenF1-backed path is limited to.
 */
export class ReplayDbService {
  // isFullyIngested() is polled once per replay tick (every ~1s while a
  // replay is playing) — without caching that's a needless Postgres round
  // trip every second for the entire playback, competing with the DB's own
  // tight connection budget. COMPLETE is a terminal state (schema's
  // IngestStatus never reverts from it), so it's safe to cache forever;
  // anything else is re-checked at most every few seconds.
  private ingestedCache = new Set<number>();
  private notIngestedCacheExpiry = new Map<number, number>();
  private static readonly NOT_INGESTED_CACHE_MS = 10_000;

  /** Raw archival status/progress for a session, or `null` if it's never been seen before. */
  public async getIngestStatus(sessionKey: number): Promise<{ status: string; progress: number } | null> {
    const prisma = getPrismaClient();
    if (!prisma) return null;
    const row = await prisma.raceSession.findUnique({
      where: { sessionKey },
      select: { ingestStatus: true, ingestProgress: true },
    });
    if (!row) return null;
    return { status: row.ingestStatus, progress: row.ingestProgress };
  }

  /** Whether a session is fully archived and safe to serve from Postgres alone — see the field comments above for the caching strategy. */
  public async isFullyIngested(sessionKey: number): Promise<boolean> {
    if (this.ingestedCache.has(sessionKey)) return true;

    const cachedExpiry = this.notIngestedCacheExpiry.get(sessionKey);
    if (cachedExpiry && Date.now() < cachedExpiry) return false;

    const status = await this.getIngestStatus(sessionKey);
    const complete = status?.status === 'COMPLETE';
    if (complete) {
      this.ingestedCache.add(sessionKey);
      this.notIngestedCacheExpiry.delete(sessionKey);
    } else {
      this.notIngestedCacheExpiry.set(sessionKey, Date.now() + ReplayDbService.NOT_INGESTED_CACHE_MS);
    }
    return complete;
  }

  /**
   * "Latest value at or before `atMs`, per driver" for each high-frequency
   * table — a DISTINCT ON query, which Postgres can answer efficiently off
   * the (session_key, driver_number, date) index without scanning the whole
   * table.
   */
  public async getSnapshotAtTime(sessionKey: number, atMs: number): Promise<DbSnapshotData> {
    const empty: DbSnapshotData = {
      locations: new Map(),
      telemetry: new Map(),
      intervals: new Map(),
      positions: new Map(),
    };

    const prisma = getPrismaClient();
    if (!prisma) return empty;
    const at = new Date(atMs);

    const [locations, telemetry, intervals, positions] = await Promise.all([
      prisma.$queryRaw<LocationRow[]>`
        SELECT DISTINCT ON (driver_number) driver_number AS "driverNumber", x, y, z
        FROM car_location_samples
        WHERE session_key = ${sessionKey} AND date <= ${at}
        ORDER BY driver_number, date DESC
      `,
      prisma.$queryRaw<TelemetryRow[]>`
        SELECT DISTINCT ON (driver_number) driver_number AS "driverNumber", speed, rpm, gear, throttle, brake, drs
        FROM car_telemetry_samples
        WHERE session_key = ${sessionKey} AND date <= ${at}
        ORDER BY driver_number, date DESC
      `,
      prisma.$queryRaw<IntervalRow[]>`
        SELECT DISTINCT ON (driver_number) driver_number AS "driverNumber", interval, gap_to_leader AS "gapToLeader"
        FROM interval_samples
        WHERE session_key = ${sessionKey} AND date <= ${at}
        ORDER BY driver_number, date DESC
      `,
      prisma.$queryRaw<PositionRow[]>`
        SELECT DISTINCT ON (driver_number) driver_number AS "driverNumber", position
        FROM position_samples
        WHERE session_key = ${sessionKey} AND date <= ${at}
        ORDER BY driver_number, date DESC
      `,
    ]);

    return {
      locations: new Map(locations.map((r) => [r.driverNumber, { x: r.x, y: r.y, z: r.z }])),
      telemetry: new Map(
        telemetry.map((r) => [
          r.driverNumber,
          { speed: r.speed, rpm: r.rpm, gear: r.gear, throttle: r.throttle, brake: r.brake, drs: r.drs >= 10 },
        ])
      ),
      intervals: new Map(intervals.map((r) => [r.driverNumber, { interval: r.interval ?? 0, gapToLeader: r.gapToLeader ?? 0 }])),
      positions: new Map(positions.map((r) => [r.driverNumber, r.position])),
    };
  }

  /**
   * Full lap/stint history for a session — small enough (hundreds of rows,
   * not hundreds of thousands) to load once per session load and keep in
   * memory, same as the OpenF1-backed path already does with its caches.
   */
  public async getLapsAndStints(sessionKey: number): Promise<{ laps: any[]; stints: any[] }> {
    const prisma = getPrismaClient();
    if (!prisma) return { laps: [], stints: [] };

    const [lapRows, stintRows] = await Promise.all([
      prisma.lapRecord.findMany({ where: { sessionKey } }),
      prisma.stintRecord.findMany({ where: { sessionKey } }),
    ]);

    // Reshape back to the OpenF1 wire-format field names so the existing
    // getLapAtTime()/updateStints() logic (written against raw API shapes)
    // works unchanged regardless of which source fed it.
    const laps = lapRows.map((l) => ({
      driver_number: l.driverNumber,
      lap_number: l.lapNumber,
      date_start: l.dateStart ? l.dateStart.toISOString() : null,
      lap_duration: l.lapDuration,
      duration_sector_1: l.sector1,
      duration_sector_2: l.sector2,
      duration_sector_3: l.sector3,
      is_pit_out_lap: l.isPitOutLap,
    }));

    const stints = stintRows.map((s) => ({
      driver_number: s.driverNumber,
      stint_number: s.stintNumber,
      compound: s.compound as TyreCompound,
      lap_start: s.lapStart,
      lap_end: s.lapEnd,
      tyre_age_at_start: s.tyreAgeAtStart,
    }));

    return { laps, stints };
  }

  /**
   * Full pit-stop history for a session, reshaped to OpenF1 wire-format
   * field names (same rationale as getLapsAndStints).
   */
  public async getPitStops(sessionKey: number): Promise<any[]> {
    const prisma = getPrismaClient();
    if (!prisma) return [];
    const rows = await prisma.pitStopRecord.findMany({ where: { sessionKey } });
    return rows.map((p) => ({
      driver_number: p.driverNumber,
      lap_number: p.lapNumber,
      pit_duration: p.pitDuration,
    }));
  }

  /**
   * Full race control message history (flags, safety car / VSC periods,
   * penalties), reshaped to OpenF1 wire-format field names.
   */
  public async getRaceControlMessages(sessionKey: number): Promise<any[]> {
    const prisma = getPrismaClient();
    if (!prisma) return [];
    const rows = await prisma.raceControlMessage.findMany({
      where: { sessionKey },
      orderBy: { date: 'asc' },
    });
    return rows.map((m) => ({
      date: m.date.toISOString(),
      category: m.category,
      flag: m.flag,
      scope: m.scope,
      sector: m.sector,
      driver_number: m.driverNumber,
      lap_number: m.lapNumber,
      message: m.message,
    }));
  }

  /**
   * Driver roster for a session — joins SessionDriver (the genuinely
   * per-session fact: who raced, for which team) against Driver (stable
   * bio: name, country, headshot, shared across every session they've ever
   * raced) — avoids an extra OpenF1 call for archived sessions. A reserve
   * driver standing in for an injured regular shows up correctly here: they
   * have their own Driver row and their own SessionDriver row for just this
   * session, entirely independent of the regular driver's record.
   */
  public async getDriversInfo(sessionKey: number): Promise<any[]> {
    const prisma = getPrismaClient();
    if (!prisma) return [];
    const rows = await prisma.sessionDriver.findMany({
      where: { sessionKey },
      include: { driver: true },
    });
    return rows.map((sd) => ({
      driverNumber: sd.driverNumber,
      broadcastName: sd.driver.broadcastName,
      fullName: sd.driver.fullName,
      nameAcronym: sd.driver.nameAcronym,
      countryCode: sd.driver.countryCode,
      headshotUrl: sd.driver.headshotUrl,
      teamName: sd.teamName,
      teamColour: sd.teamColour,
    }));
  }
}

export const replayDbService = new ReplayDbService();
export default replayDbService;
