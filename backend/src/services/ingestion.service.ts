import getPrismaClient from '../db/prisma.client';
import { openF1Service } from './openf1.service';
import { normalizeCompound } from '../domain/tyreCompound';

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Time window per chunked request for the two genuinely high-frequency
// endpoints (location, car_data — both sampled multiple times per second per
// driver). A full ~95-minute race split into 30-minute windows is ~3-4
// requests per endpoint (~7 total, down from ~10 at the previous 20-minute
// window); intervals/positions/laps/stints are lower-frequency enough to
// fetch unbounded in one call each (see runIngestion below), so this
// chunking no longer applies to them. A 20-minute car_data window measured
// ~100k rows and returned comfortably within the (now 35s) request timeout,
// so a 30-minute window (~150k rows) still has headroom.
const CHUNK_MS = 30 * 60 * 1000;

// 1 request every 2.1s = ~28.6 req/min, safely under OpenF1's ~30 req/min
// budget even with nothing else running concurrently for this session (the
// live poller has already stopped by the time a session is ingestible, since
// ingestion only ever targets a completed session).
const INGEST_STAGGER_MS = 2100;

export interface IngestSessionMeta {
  sessionStartMs: number;
  sessionEndMs: number;
  hasGapData: boolean;
}

/**
 * Downloads a completed session's full telemetry history from OpenF1 exactly
 * once and persists it to Postgres, so every future replay/scrub of that
 * session is served from the database instead of re-hitting the rate-limited
 * API. Runs in the background — callers should not await ensureIngested() on
 * the request path, just fire it and keep serving from OpenF1 (or a partial
 * DB result) until ingestStatus flips to COMPLETE.
 */
export class IngestionService {
  private activeSessions = new Set<number>();

  public isIngesting(sessionKey: number): boolean {
    return this.activeSessions.has(sessionKey);
  }

  /**
   * Kicks off ingestion for a session if it hasn't been ingested yet and
   * isn't currently being ingested. Safe to call on every session load —
   * it's a no-op once COMPLETE.
   */
  public async ensureIngested(sessionKey: number, meta: IngestSessionMeta): Promise<void> {
    const prisma = getPrismaClient();
    if (!prisma) return; // no DB configured — caller falls back to live OpenF1 fetching
    if (this.activeSessions.has(sessionKey)) return;
    if (meta.sessionEndMs <= meta.sessionStartMs) return; // no real timeline to ingest

    const existing = await prisma.raceSession.findUnique({
      where: { sessionKey },
      select: { ingestStatus: true, updatedAt: true },
    });
    if (existing?.ingestStatus === 'COMPLETE') return;

    // IN_PROGRESS normally means another call already has this session
    // covered — except this process isn't the one running it (checked
    // above via activeSessions) and the row hasn't been touched in a
    // while, which means whatever was running it died (e.g. a dev-server
    // restart) without ever reaching COMPLETE or FAILED. Treat that as
    // abandoned and retry, rather than leaving the session stuck forever.
    const STALE_MS = 3 * 60 * 1000;
    if (existing?.ingestStatus === 'IN_PROGRESS') {
      const age = existing.updatedAt ? Date.now() - existing.updatedAt.getTime() : Infinity;
      if (age < STALE_MS) return;
      console.warn(`Session ${sessionKey} ingestion looked IN_PROGRESS but stalled ${Math.round(age / 1000)}s ago — retrying.`);
    }

    this.runIngestion(sessionKey, meta).catch((err: any) => {
      console.error(`Ingestion failed for session ${sessionKey}:`, err?.message);
    });
  }

  private async runIngestion(sessionKey: number, meta: IngestSessionMeta): Promise<void> {
    const prisma = getPrismaClient();
    if (!prisma) return;

    this.activeSessions.add(sessionKey);
    console.log(`Starting full telemetry ingestion for session ${sessionKey}...`);

    await prisma.raceSession
      .update({ where: { sessionKey }, data: { ingestStatus: 'IN_PROGRESS', ingestProgress: 0, ingestError: null } })
      .catch(() => {});

    try {
      // Clear any partial rows from a previous failed attempt before redoing it.
      await Promise.all([
        prisma.carLocationSample.deleteMany({ where: { sessionKey } }),
        prisma.carTelemetrySample.deleteMany({ where: { sessionKey } }),
        prisma.intervalSample.deleteMany({ where: { sessionKey } }),
        prisma.positionSample.deleteMany({ where: { sessionKey } }),
        prisma.stintRecord.deleteMany({ where: { sessionKey } }),
        prisma.lapRecord.deleteMany({ where: { sessionKey } }),
        prisma.pitStopRecord.deleteMany({ where: { sessionKey } }),
        prisma.raceControlMessage.deleteMany({ where: { sessionKey } }),
      ]);

      const setProgress = (p: number) =>
        prisma.raceSession.update({ where: { sessionKey }, data: { ingestProgress: p } }).catch(() => {});

      // --- Small, unbounded endpoints first ---
      const laps = await openF1Service.getLatestLaps(sessionKey);
      await this.insertLaps(sessionKey, laps);
      await wait(INGEST_STAGGER_MS);
      await setProgress(5);

      const stints = await openF1Service.getStints(sessionKey);
      await this.insertStints(sessionKey, stints);
      await wait(INGEST_STAGGER_MS);
      await setProgress(8);

      const pits = await openF1Service.getPitStops(sessionKey);
      await this.insertPitStops(sessionKey, pits);
      await wait(INGEST_STAGGER_MS);
      await setProgress(10);

      const positions = await openF1Service.getPositions(sessionKey);
      await this.insertPositions(sessionKey, positions);
      await wait(INGEST_STAGGER_MS);
      await setProgress(13);

      const raceControl = await openF1Service.getRaceControl(sessionKey);
      await this.insertRaceControl(sessionKey, raceControl);
      await wait(INGEST_STAGGER_MS);
      await setProgress(15);

      // Intervals (Race/Sprint only) — event-driven, not continuous like
      // location/car_data, so one unbounded fetch is enough (same approach
      // already used for positions/laps/stints above) — 15% to 35%. CSV
      // (~62% smaller on the wire per OpenF1's docs — verified against this
      // exact dataset) cuts transfer + JSON.parse time on what can still be
      // tens of thousands of rows for a full race.
      if (meta.hasGapData) {
        const intervalData = await openF1Service.getIntervals(sessionKey, undefined, undefined, true);
        await this.insertIntervals(sessionKey, intervalData);
        await wait(INGEST_STAGGER_MS);
      }
      await setProgress(35);

      // --- Chunked: the two genuinely high-frequency endpoints ---
      const chunks: Array<[number, number]> = [];
      for (let t = meta.sessionStartMs; t < meta.sessionEndMs; t += CHUNK_MS) {
        chunks.push([t, Math.min(meta.sessionEndMs, t + CHUNK_MS)]);
      }

      // Locations — 35% to 65% — CSV (see above)
      for (let i = 0; i < chunks.length; i++) {
        const [start, end] = chunks[i];
        const data = await openF1Service.getLocations(
          sessionKey,
          new Date(start).toISOString(),
          new Date(end).toISOString(),
          undefined,
          true
        );
        await this.insertLocations(sessionKey, data);
        await wait(INGEST_STAGGER_MS);
        await setProgress(35 + Math.round(((i + 1) / chunks.length) * 30));
      }

      // Car telemetry — 65% to 98% — CSV (see above); this is the largest
      // dataset of the four, so it benefits the most from the smaller payload.
      for (let i = 0; i < chunks.length; i++) {
        const [start, end] = chunks[i];
        const data = await openF1Service.getCarData(
          sessionKey,
          new Date(start).toISOString(),
          new Date(end).toISOString(),
          true
        );
        await this.insertCarData(sessionKey, data);
        await wait(INGEST_STAGGER_MS);
        await setProgress(65 + Math.round(((i + 1) / chunks.length) * 33));
      }

      await prisma.raceSession.update({
        where: { sessionKey },
        data: { ingestStatus: 'COMPLETE', ingestProgress: 100, ingestedAt: new Date() },
      });
      console.log(`Ingestion complete for session ${sessionKey}.`);
    } catch (err: any) {
      await prisma.raceSession
        .update({ where: { sessionKey }, data: { ingestStatus: 'FAILED', ingestError: String(err?.message || err).slice(0, 500) } })
        .catch(() => {});
      throw err;
    } finally {
      this.activeSessions.delete(sessionKey);
    }
  }

  // --- Bulk insert helpers — skip rows missing required fields (bad/partial
  // API data), insert in batches to stay under Postgres's parameter limit. ---

  private async insertLocations(sessionKey: number, data: any[]): Promise<void> {
    const prisma = getPrismaClient();
    if (!prisma || data.length === 0) return;
    const rows = data
      .filter((d) => d.date && typeof d.x === 'number' && typeof d.y === 'number')
      .map((d) => ({
        sessionKey,
        driverNumber: d.driver_number,
        date: new Date(d.date),
        x: d.x,
        y: d.y,
        z: d.z || 0,
      }));
    // 6 columns/row -> up to 10922 stays under Postgres's 65535-param cap.
    await this.chunkedCreateMany((prisma as any).carLocationSample, rows, 10000);
  }

  private async insertCarData(sessionKey: number, data: any[]): Promise<void> {
    const prisma = getPrismaClient();
    if (!prisma || data.length === 0) return;
    const rows = data
      .filter((d) => d.date)
      .map((d) => ({
        sessionKey,
        driverNumber: d.driver_number,
        date: new Date(d.date),
        speed: Math.max(0, d.speed || 0),
        rpm: Math.max(0, d.rpm || 0),
        gear: d.n_gear || 0,
        throttle: Math.max(0, Math.min(100, d.throttle || 0)),
        brake: Math.max(0, Math.min(100, d.brake || 0)),
        drs: d.drs || 0,
      }));
    // 9 columns/row (the widest table) -> up to 7281 stays under the cap.
    await this.chunkedCreateMany((prisma as any).carTelemetrySample, rows, 7000);
  }

  private async insertIntervals(sessionKey: number, data: any[]): Promise<void> {
    const prisma = getPrismaClient();
    if (!prisma || data.length === 0) return;
    const rows = data
      .filter((d) => d.date)
      .map((d) => ({
        sessionKey,
        driverNumber: d.driver_number,
        date: new Date(d.date),
        interval: openF1Service.parseInterval(d.interval),
        gapToLeader: openF1Service.parseInterval(d.gap_to_leader),
      }));
    // 5 columns/row -> up to 13107 stays under the cap.
    await this.chunkedCreateMany((prisma as any).intervalSample, rows, 10000);
  }

  private async insertPositions(sessionKey: number, data: any[]): Promise<void> {
    const prisma = getPrismaClient();
    if (!prisma || data.length === 0) return;
    const rows = data
      .filter((d) => d.date && typeof d.position === 'number')
      .map((d) => ({
        sessionKey,
        driverNumber: d.driver_number,
        date: new Date(d.date),
        position: d.position,
      }));
    // 4 columns/row -> up to 16383 stays under the cap.
    await this.chunkedCreateMany((prisma as any).positionSample, rows, 12000);
  }

  private async insertStints(sessionKey: number, data: any[]): Promise<void> {
    const prisma = getPrismaClient();
    if (!prisma || data.length === 0) return;
    const rows = data.map((d) => ({
      sessionKey,
      driverNumber: d.driver_number,
      stintNumber: d.stint_number || 1,
      // compound is now a Postgres enum — an unrecognized value from OpenF1
      // would fail the whole insert rather than being stored as free text,
      // so fall back to UNKNOWN instead of trusting the raw string.
      compound: normalizeCompound(d.compound),
      lapStart: d.lap_start || 0,
      lapEnd: d.lap_end ?? null,
      tyreAgeAtStart: d.tyre_age_at_start || 0,
    }));
    await this.chunkedCreateMany((prisma as any).stintRecord, rows);
  }

  private async insertLaps(sessionKey: number, data: any[]): Promise<void> {
    const prisma = getPrismaClient();
    if (!prisma || data.length === 0) return;
    const rows = data.map((d) => ({
      sessionKey,
      driverNumber: d.driver_number,
      lapNumber: d.lap_number || 0,
      dateStart: d.date_start ? new Date(d.date_start) : null,
      lapDuration: typeof d.lap_duration === 'number' ? d.lap_duration : null,
      sector1: typeof d.duration_sector_1 === 'number' ? d.duration_sector_1 : null,
      sector2: typeof d.duration_sector_2 === 'number' ? d.duration_sector_2 : null,
      sector3: typeof d.duration_sector_3 === 'number' ? d.duration_sector_3 : null,
      isPitOutLap: !!d.is_pit_out_lap,
    }));
    await this.chunkedCreateMany((prisma as any).lapRecord, rows);
  }

  private async insertPitStops(sessionKey: number, data: any[]): Promise<void> {
    const prisma = getPrismaClient();
    if (!prisma || data.length === 0) return;
    const rows = data.map((d) => ({
      sessionKey,
      driverNumber: d.driver_number,
      lapNumber: d.lap_number || 0,
      date: d.date ? new Date(d.date) : null,
      pitDuration: typeof d.pit_duration === 'number' ? d.pit_duration : null,
    }));
    await this.chunkedCreateMany((prisma as any).pitStopRecord, rows);
  }

  private async insertRaceControl(sessionKey: number, data: any[]): Promise<void> {
    const prisma = getPrismaClient();
    if (!prisma || data.length === 0) return;
    const rows = data
      .filter((d) => d.date && d.message)
      .map((d) => ({
        sessionKey,
        date: new Date(d.date),
        category: d.category || 'Other',
        flag: d.flag || null,
        scope: d.scope || null,
        sector: typeof d.sector === 'number' ? d.sector : null,
        driverNumber: typeof d.driver_number === 'number' ? d.driver_number : null,
        lapNumber: typeof d.lap_number === 'number' ? d.lap_number : null,
        message: d.message,
      }));
    await this.chunkedCreateMany((prisma as any).raceControlMessage, rows);
  }

  // Postgres caps a single statement at 65535 bound parameters, so the safe
  // batch size (rows per createMany call) depends on each table's column
  // count — sized here per call site so the largest-volume tables (location,
  // car_data) get the biggest batches Postgres allows, instead of one
  // conservative size picked for the widest table and left unused headroom
  // on the rest. Fewer, larger batches means fewer network round-trips to
  // the remote DB for the ~100-150k row chunks car_data/location produce.
  private async chunkedCreateMany(
    model: { createMany: (args: any) => Promise<any> },
    rows: any[],
    batchSize: number = 5000
  ): Promise<void> {
    if (rows.length === 0) return;
    for (let i = 0; i < rows.length; i += batchSize) {
      await model.createMany({ data: rows.slice(i, i + batchSize), skipDuplicates: true });
    }
  }
}

export const ingestionService = new IngestionService();
export default ingestionService;
