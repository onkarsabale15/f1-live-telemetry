import { EventEmitter } from 'events';
import { DriverLiveState, DriverInfo, SessionMeta, RaceSnapshot, TyreCompound } from '../domain/models';
import { computeCircuitBounds } from '../domain/formulas';
import { openF1Service, OpenF1Session } from './openf1.service';
import { overtakePredictionService, IntervalHistory, ProbabilityHistory } from './prediction.service';
import { messageBus } from '../db/redis.client';
import getPrismaClient from '../db/prisma.client';
import { ingestionService } from './ingestion.service';
import { replayDbService } from './replay-db.service';

export interface PlaybackState {
  isPlaying: boolean;
  isLive: boolean;
  speed: 1 | 2 | 4;
  currentTick: number;
  totalTicks: number;
  sessionKey: number;
  // Real wall-clock bounds of the session's recorded data — used by the
  // frontend to render a scrubbable time slider for completed sessions.
  // Meaningless for a live session (no fixed end yet).
  sessionStartMs: number;
  sessionEndMs: number;
  // Current playback position: the replay scrub position for a completed
  // session, or simply "now" for a live one.
  positionMs: number;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The replay/scrub position and its broadcast always advance once a second —
// this is the display cadence, and it's the same whether or not the session
// is fully archived yet. What differs is how often that tick is allowed to
// go fetch *new* data (see replayTick()): every tick when reading from
// Postgres (cheap, no external rate limit), but only every
// REPLAY_FETCH_TIER1/2_EVERY_N_TICKS-th tick when still falling back to
// OpenF1 — the ticks in between just re-broadcast the same last-known state,
// same as live polling already does between its own ~7.5s refreshes.
const REPLAY_TICK_MS = 1000;
const REPLAY_FETCH_TIER1_EVERY_N_TICKS = 8; // ~8s — location + car_data
const REPLAY_FETCH_TIER2_EVERY_N_TICKS = 15; // 15s — position + intervals
const SEEK_DEBOUNCE_MS = 300;

// Live polling runs on a 2.5s master tick, with each OpenF1 endpoint fetched
// only on the multiple of that tick matching its tier. This keeps sustained
// throughput under OpenF1's free-tier budget (observed: bursts above ~30
// req/min reliably trigger 429s):
//   Tier 1 — location + car_data   every 3 ticks (7.5s) -> 16 req/min
//   Tier 2 — position + intervals  every 6 ticks (15s)  ->  8 req/min
//   Tier 3 — laps + stints         every 24 ticks (60s) ->  2 req/min
//   Total: 26 req/min, ~13% under the 30/min budget.
const MASTER_TICK_MS = 2500;
const TIER1_EVERY_N_TICKS = 3;
const TIER2_EVERY_N_TICKS = 6;
const TIER3_EVERY_N_TICKS = 24;
// Spacing between sequential requests within one tick, so multiple tiers
// firing together (e.g. tick 24 = tier1 + tier2 + tier3 at once) never
// bursts past OpenF1's ~3 req/sec limit.
const REQUEST_STAGGER_MS = 500;
// ~75s at the 2.5s master tick — how often to check for a newer session.
const SESSION_RECHECK_TICKS = 30;

/**
 * The single shared engine that tracks whichever F1 session is currently
 * live and polls OpenF1 for it, publishing snapshots that every "watching
 * live" client shares (see socket.server.ts's 'live' room) — deliberately
 * one poll loop for everyone, not one per viewer, since OpenF1's rate limit
 * is a fixed budget regardless of how many people are watching.
 *
 * Historically this class also drove replay/scrub playback for a single
 * shared "current session," but that responsibility has moved to
 * replay-session.service.ts's stateless functions plus per-socket state in
 * socket.server.ts, so two browser tabs can browse two different past races
 * independently. The playback-control methods below (play/pause/seek/
 * setSpeed) are kept for reference and no longer called from any route —
 * per-tab replay reads Postgres directly instead.
 */
export class SimulationEngine extends EventEmitter {
  private pollTimer: NodeJS.Timeout | null = null;
  private pollIntervalMs = MASTER_TICK_MS;
  private sessionCheckCounter = 0;
  private liveTickCounter = 0;

  private sessionMeta: SessionMeta | null = null;
  private sessionData: OpenF1Session | null = null;
  private drivers: DriverInfo[] = [];
  private driversMap = new Map<number, DriverInfo>();
  private isLive = false;
  private isUpcoming = false;
  private hasGapData = false;
  private hasDrs = false;
  private isPinned = false;

  private driverLocations = new Map<number, { x: number; y: number; z: number }>();
  private driverTelemetry = new Map<number, { speed: number; rpm: number; gear: number; throttle: number; brake: number; drs: boolean }>();
  private driverIntervals = new Map<number, { interval: number; gapToLeader: number }>();
  private driverPositions = new Map<number, number>();
  private driverStints = new Map<number, { compound: TyreCompound; age: number }>();
  private intervalHistory: IntervalHistory = new Map();
  private probabilityHistory: ProbabilityHistory = new Map();

  private currentLap = 0;
  private totalLaps = 0;
  private lastPollDate: string | null = null;
  private hasReceivedData = false;

  // Full-session data cached once per load, reused for every scrub/seek so
  // dragging the timeline doesn't re-fetch these on every step. Laps and
  // stints are small (roughly one row per driver per lap/stint) even for a
  // full race, unlike location/car_data which stay windowed per seek.
  private lapsCache: any[] = [];
  private stintsCache: any[] = [];

  // Replay/scrub state — only meaningful for a completed session.
  private sessionStartMs = 0;
  private sessionEndMs = 0;
  private replayPositionMs = 0;
  private isReplayPlaying = false;
  private replaySpeed: 1 | 2 | 4 = 1;
  private replayTickCounter = 0;
  private replayTimer: NodeJS.Timeout | null = null;
  private seekDebounceTimer: NodeJS.Timeout | null = null;
  private pendingSeekMs: number | null = null;

  constructor() {
    super();
  }

  /**
   * @param sessionKey Load this specific session instead of auto-detecting.
   * @param pin When true (Match Explorer / explicit REST load), the
   *   periodic "hand off to a newer session" check backs off and leaves
   *   this session loaded until the user explicitly picks another one —
   *   otherwise it would silently revert to the latest session within
   *   ~75 seconds, undoing the user's choice to review an older race.
   */
  public async initialize(sessionKey?: number, pin: boolean = false): Promise<void> {
    console.log('Initializing Live Data Engine...');

    let session: OpenF1Session | null = null;
    let foundRequestedSession = false;

    if (sessionKey) {
      session = await openF1Service.getSessionByKey(sessionKey);
      foundRequestedSession = !!session;
    }

    if (!session) {
      session = await openF1Service.getLatestSession();
    }

    // Only actually pin if we ended up loading the caller's requested
    // session — an invalid/not-found sessionKey falls back to "latest"
    // above, which should stay in auto-follow mode, not get stuck pinned
    // to whatever "latest" happened to resolve to.
    this.isPinned = pin && foundRequestedSession;

    if (!session) {
      console.warn('No session found from OpenF1 API. Will keep checking...');
      this.sessionMeta = {
        sessionKey: 0, circuitKey: 0,
        circuitShortName: 'Connecting...',
        countryName: '', location: 'Waiting for OpenF1 API',
        year: new Date().getFullYear(),
        sessionName: 'No active session detected',
        sessionType: '',
        hasGapData: false,
        hasDrs: true,
        bounds: { minX: 0, maxX: 1000, minY: 0, maxY: 1000, width: 1000, height: 1000 },
        trackPath: [],
      };
      this.startPolling();
      return;
    }

    // Reset all per-session state — otherwise switching sessions (e.g. via
    // Match Explorer) would leak stale positions/telemetry from the
    // previous race into the new one until fresh data overwrites every key.
    this.driverLocations.clear();
    this.driverTelemetry.clear();
    this.driverIntervals.clear();
    this.driverPositions.clear();
    this.driverStints.clear();
    this.currentLap = 0;
    this.lastPollDate = null;
    this.hasReceivedData = false;
    this.sessionCheckCounter = 0;
    this.liveTickCounter = 0;
    this.replayTickCounter = 0;
    this.lapsCache = [];
    this.stintsCache = [];
    this.sessionStartMs = 0;
    this.sessionEndMs = 0;
    this.replayPositionMs = 0;
    this.isReplayPlaying = false;
    this.replaySpeed = 1;
    this.stopReplayTicker();
    if (this.seekDebounceTimer) {
      clearTimeout(this.seekDebounceTimer);
      this.seekDebounceTimer = null;
    }
    this.pendingSeekMs = null;
    this.intervalHistory.clear();
    this.probabilityHistory.clear();

    this.sessionData = session;
    this.isLive = openF1Service.isSessionLive(session);
    this.isUpcoming = openF1Service.isSessionUpcoming(session);
    this.hasGapData = openF1Service.sessionHasGapData(session);
    this.hasDrs = openF1Service.sessionHasDrs(session);

    console.log(`Session: ${session.session_name} at ${session.circuit_short_name}, ${session.country_name} (${session.year})`);
    console.log(`Status: ${this.isLive ? 'LIVE' : this.isUpcoming ? 'UPCOMING' : 'COMPLETED'}`);

    // Fetch drivers — skipped for an already-archived session, since
    // fetchInitialState() -> loadStateFromDb() below loads the roster from
    // Postgres instead (no OpenF1 call needed for a repeat visit).
    const isArchived =
      !this.isLive && !this.isUpcoming && (await replayDbService.isFullyIngested(session.session_key));
    if (!isArchived) {
      this.drivers = await openF1Service.getDrivers(session.session_key);
      this.driversMap.clear();
      this.drivers.forEach((d) => this.driversMap.set(d.driverNumber, d));
      console.log(`Loaded ${this.drivers.length} drivers`);
    }

    // Fetch initial data (staggered to avoid 429)
    await this.fetchInitialState(session.session_key);

    // Defensive fallback: the archived path above may not have populated
    // this.drivers (e.g. a transient DB issue) — don't leave the roster
    // empty for the rest of the session in that case.
    if (this.drivers.length === 0) {
      this.drivers = await openF1Service.getDrivers(session.session_key);
      this.driversMap.clear();
      this.drivers.forEach((d) => this.driversMap.set(d.driverNumber, d));
      console.log(`Loaded ${this.drivers.length} drivers`);
    }

    // Build session meta
    if (!this.sessionMeta || this.sessionMeta.sessionKey !== session.session_key) {
      this.sessionMeta = openF1Service.buildSessionMeta(session, []);
    }

    console.log(`Live Data Engine ready: ${this.driverLocations.size} drivers with position data, Lap ${this.currentLap}`);
    this.startPolling();

    // Notify already-connected clients (e.g. Match Explorer loaded a
    // different race weekend) — new connections get this via session_init.
    this.emit('sessionChanged', {
      sessionMeta: this.sessionMeta,
      drivers: this.drivers,
      playback: this.getPlaybackState(),
    });
  }

  /**
   * Returns the ISO timestamp to anchor "recent data" queries from, for a
   * LIVE session only — anchored to wall-clock time.
   */
  private getAnchorDate(windowMs: number = 120_000): string {
    return new Date(Date.now() - windowMs).toISOString();
  }

  /**
   * The real recorded end-of-race timestamp (last lap's date_start +
   * lap_duration), independent of any window — used as the reference point
   * for both the start and end bounds of "final state" queries, and as one
   * end of the scrub timeline.
   */
  private getRealSessionEndMs(laps: any[]): number {
    let latestMs: number | null = null;
    for (const lap of laps) {
      if (!lap.date_start || typeof lap.lap_duration !== 'number') continue;
      const end = new Date(lap.date_start).getTime() + lap.lap_duration * 1000;
      if (latestMs === null || end > latestMs) latestMs = end;
    }
    if (latestMs !== null) return latestMs;
    // No usable lap timing — fall back to the scheduled session end.
    return this.sessionData ? new Date(this.sessionData.date_end).getTime() : Date.now();
  }

  /**
   * The real recorded start timestamp (earliest lap's date_start) — the
   * other end of the scrub timeline.
   */
  private getRealSessionStartMs(laps: any[]): number {
    let earliestMs: number | null = null;
    for (const lap of laps) {
      if (!lap.date_start) continue;
      const start = new Date(lap.date_start).getTime();
      if (earliestMs === null || start < earliestMs) earliestMs = start;
    }
    if (earliestMs !== null) return earliestMs;
    return this.sessionData ? new Date(this.sessionData.date_start).getTime() : Date.now();
  }

  /**
   * The furthest lap number reached by any driver at or before targetMs —
   * used to label the scrub position ("Lap X") and to pick the tyre stint
   * that was actually active at that point in the race.
   */
  private getLapAtTime(targetMs: number): number {
    let maxLap = 0;
    for (const lap of this.lapsCache) {
      if (!lap.date_start) continue;
      const startMs = new Date(lap.date_start).getTime();
      if (startMs <= targetMs && (lap.lap_number || 0) > maxLap) {
        maxLap = lap.lap_number;
      }
    }
    return maxLap;
  }

  /** ISO timestamp `windowMs` before the session's real recorded end — the anchor for "final state" queries on a completed session. */
  private getCompletedAnchor(laps: any[], windowMs: number): string {
    return new Date(this.getRealSessionEndMs(laps) - windowMs).toISOString();
  }

  /**
   * Replaces every per-driver map with the DB's "latest at or before atMs"
   * answer — the fast path used once a session is fully archived.
   */
  private async applyDbSnapshot(sessionKey: number, atMs: number): Promise<void> {
    const snapshot = await replayDbService.getSnapshotAtTime(sessionKey, atMs);
    this.driverLocations = new Map(snapshot.locations);
    this.driverTelemetry = new Map(snapshot.telemetry);
    this.driverIntervals = new Map(snapshot.intervals);
    this.driverPositions = new Map(snapshot.positions);
    this.currentLap = this.getLapAtTime(atMs);
    this.driverStints.clear();
    this.updateStints(this.stintsCache);
  }

  private publishSnapshot(sessionKey: number): void {
    const snapshot = this.buildSnapshot();
    this.emit('tick', snapshot);
    messageBus.publish('f1:stream:global', JSON.stringify(snapshot)).catch(() => {});
    messageBus.set(`f1:session:${sessionKey}:snapshot`, JSON.stringify(snapshot), 30).catch(() => {});
  }

  private async fetchInitialState(sessionKey: number): Promise<void> {
    if (this.isUpcoming) {
      // No data exists yet for a session that hasn't started
      return;
    }

    // A completed session that's already been fully archived to Postgres
    // (see ingestion.service.ts) can be served entirely from the database —
    // no OpenF1 calls, no rate limit, and session metadata (track path,
    // roster, timeline bounds) is already known too. This is what makes a
    // second visit to a past race instant regardless of OpenF1's mood.
    if (!this.isLive) {
      const loadedFromDb = await this.loadStateFromDb(sessionKey);
      if (loadedFromDb) {
        this.hasReceivedData = this.driverLocations.size > 0;
        return;
      }
    }

    // Laps are fetched first: they're cheap (one row per driver per lap),
    // give us the current lap count, and — for a completed session — the
    // real recorded finish time to anchor every other windowed query to,
    // plus the full scrub timeline bounds.
    const laps = await openF1Service.getLatestLaps(sessionKey);
    this.lapsCache = laps;
    if (laps.length > 0) {
      this.currentLap = Math.max(...laps.map((l: any) => l.lap_number || 0));
    }
    if (!this.isLive) {
      this.sessionStartMs = this.getRealSessionStartMs(laps);
      this.sessionEndMs = this.getRealSessionEndMs(laps);
      // Default the scrub position to the end (final classification) —
      // matches what users saw before scrubbing existed; they can drag
      // backward from there.
      this.replayPositionMs = this.sessionEndMs;
    }
    await wait(500);

    const recentDate = this.isLive ? this.getAnchorDate(180_000) : this.getCompletedAnchor(laps, 180_000);

    // For a completed session, car_data/location keep recording for a while
    // after the checkered flag as cars idle back to parc fermé — an
    // unbounded "since" query would pick up that parked, near-zero-speed
    // telemetry as each driver's "latest" point instead of their actual
    // racing pace. Bounding the end just past the real finish keeps the
    // snapshot representative of live racing.
    const untilDate = this.isLive ? undefined : new Date(this.getRealSessionEndMs(laps) + 45_000).toISOString();

    // Position changes are event-driven (rare), not sampled at high frequency —
    // a backmarker's last position update can be many minutes old. For a
    // completed session the full dataset is small (~1-2k rows for a whole
    // race), so fetch it unbounded to get every driver's true final position
    // rather than defaulting missing ones to the back of the grid.
    const positions = this.isLive
      ? await openF1Service.getPositions(sessionKey, recentDate)
      : await openF1Service.getPositions(sessionKey);
    this.updatePositions(positions);
    await wait(500);

    // Gaps/intervals only exist for Race & Sprint sessions (OpenF1 404s the
    // endpoint for Qualifying/Practice) — skip it entirely otherwise so we
    // don't render a misleading "everyone is 0.01s apart" battle radar.
    // For a completed session, fetch unbounded (same reasoning as
    // positions): a driver who retired early would otherwise have no
    // interval record inside a narrow recent-only window, defaulting their
    // gap to 0 and fabricating a "battle" with whoever's classified next to
    // them.
    if (this.hasGapData) {
      const intervals = this.isLive
        ? await openF1Service.getIntervals(sessionKey, recentDate)
        : await openF1Service.getIntervals(sessionKey);
      this.updateIntervals(intervals);
      await wait(500);
    }

    // Fetch locations (heavier)
    const locations = await openF1Service.getLocations(sessionKey, recentDate, untilDate);
    this.updateLocations(locations);
    await wait(500);

    // Build track path from a bounded window (~90s) of one driver's data —
    // fetching the full unbounded session can time out on long sessions.
    if (locations.length > 0) {
      const sampleDriver = locations[0].driver_number;
      const windowStart = recentDate;
      const windowEnd = new Date(new Date(recentDate).getTime() + 90_000).toISOString();
      const driverLocations = await openF1Service.getLocations(sessionKey, windowStart, windowEnd, sampleDriver);
      if (driverLocations.length > 0) {
        const trackPath = openF1Service.buildTrackPath(driverLocations);
        if (trackPath.length > 0) {
          const bounds = computeCircuitBounds(trackPath);
          this.sessionMeta = {
            sessionKey,
            circuitKey: this.sessionData?.circuit_key || 0,
            circuitShortName: this.sessionData?.circuit_short_name || '',
            countryName: this.sessionData?.country_name || '',
            location: this.sessionData?.location || '',
            year: this.sessionData?.year || new Date().getFullYear(),
            sessionName: this.sessionData?.session_name || '',
            sessionType: this.sessionData?.session_type || '',
            hasGapData: this.hasGapData,
            hasDrs: this.hasDrs,
            bounds,
            trackPath,
          };
        }
      }
    }
    await wait(500);

    // Fetch car telemetry
    const carData = await openF1Service.getCarData(sessionKey, recentDate, untilDate);
    this.updateCarData(carData);
    await wait(500);

    // Fetch stints
    const stints = await openF1Service.getStints(sessionKey);
    this.stintsCache = stints;
    this.updateStints(stints);

    // If OpenF1 has no location data yet (session just started, or a 401
    // lockdown during a live race), `driverLocations` stays empty and
    // `hasReceivedData` below is false — buildSnapshot() then has nothing
    // to broadcast. That's the correct, honest outcome: showing invented
    // car positions/speeds/tyres here would be indistinguishable on screen
    // from the real thing. The frontend renders an explicit "awaiting live
    // feed" state instead of a populated-but-fake grid.
    this.hasReceivedData = this.driverLocations.size > 0;

    // A completed session with real data and no DB archive yet: save its
    // metadata now and kick off a background ingestion of its full
    // telemetry history, so every future load/replay of this exact session
    // skips OpenF1 entirely (see loadStateFromDb() above). Fire-and-forget —
    // this must not block the caller, who's already showing the "final
    // state" snapshot fetched just above.
    if (!this.isLive && this.hasReceivedData && this.sessionEndMs > this.sessionStartMs) {
      this.upsertSessionRecord(sessionKey)
        .then(() =>
          ingestionService.ensureIngested(sessionKey, {
            sessionStartMs: this.sessionStartMs,
            sessionEndMs: this.sessionEndMs,
            hasGapData: this.hasGapData,
          })
        )
        .catch((err: any) => console.error(`Failed to queue ingestion for session ${sessionKey}:`, err?.message));
    }
  }

  /**
   * Saves/refreshes this session's metadata row in Postgres — everything
   * ingestion and future DB-only loads need (track path, driver roster,
   * timeline bounds), independent of the raw telemetry tables.
   *
   * Circuit (stable per physical venue) and Driver (stable per person, keyed
   * by their permanent race number) are upserted separately from the
   * session/roster join, instead of being re-copied onto every session row —
   * see schema.prisma for why. SessionDriver captures exactly what's
   * genuinely per-weekend: which team each driver raced for here, so a
   * reserve standing in for an injured regular is just their own Driver row
   * plus their own SessionDriver row for this one session.
   */
  private async upsertSessionRecord(sessionKey: number): Promise<void> {
    const prisma = getPrismaClient();
    if (!prisma || !this.sessionData || !this.sessionMeta) return;

    try {
      await prisma.circuit.upsert({
        where: { circuitKey: this.sessionData.circuit_key },
        create: {
          circuitKey: this.sessionData.circuit_key,
          circuitShortName: this.sessionData.circuit_short_name,
          countryName: this.sessionData.country_name,
          location: this.sessionData.location,
        },
        update: {
          circuitShortName: this.sessionData.circuit_short_name,
          countryName: this.sessionData.country_name,
          location: this.sessionData.location,
        },
      });

      await prisma.raceSession.upsert({
        where: { sessionKey },
        create: {
          sessionKey,
          sessionName: this.sessionData.session_name,
          sessionType: this.sessionData.session_type,
          circuitKey: this.sessionData.circuit_key,
          year: this.sessionData.year,
          meetingKey: this.sessionData.meeting_key,
          dateStart: new Date(this.sessionData.date_start),
          dateEnd: new Date(this.sessionData.date_end),
          hasGapData: this.hasGapData,
          hasDrs: this.hasDrs,
          trackPath: this.sessionMeta.trackPath as any,
          sessionStartMs: BigInt(Math.round(this.sessionStartMs)),
          sessionEndMs: BigInt(Math.round(this.sessionEndMs)),
        },
        update: {
          hasGapData: this.hasGapData,
          hasDrs: this.hasDrs,
          trackPath: this.sessionMeta.trackPath as any,
          sessionStartMs: BigInt(Math.round(this.sessionStartMs)),
          sessionEndMs: BigInt(Math.round(this.sessionEndMs)),
        },
      });

      for (const d of this.drivers) {
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
    } catch (err: any) {
      console.error(`Failed to upsert session record ${sessionKey}:`, err?.message);
    }
  }

  /**
   * Loads everything fetchInitialState() would otherwise fetch from OpenF1
   * — session metadata, the final-state snapshot, and the laps/stints
   * caches — from Postgres instead. Returns false if this session hasn't
   * been (fully) archived yet, so the caller falls back to OpenF1.
   */
  private async loadStateFromDb(sessionKey: number): Promise<boolean> {
    const prisma = getPrismaClient();
    if (!prisma) return false;

    const row = await prisma.raceSession.findUnique({ where: { sessionKey }, include: { circuit: true } });
    if (!row || row.ingestStatus !== 'COMPLETE') return false;

    console.log(`Session ${sessionKey} already archived — loading from database (no OpenF1 calls).`);

    this.sessionStartMs = row.sessionStartMs ? Number(row.sessionStartMs) : 0;
    this.sessionEndMs = row.sessionEndMs ? Number(row.sessionEndMs) : 0;
    this.replayPositionMs = this.sessionEndMs;
    this.hasGapData = row.hasGapData;
    this.hasDrs = row.hasDrs;

    const trackPath = (row.trackPath as any) || [];
    const bounds = computeCircuitBounds(trackPath);
    this.sessionMeta = {
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

    const driversInfo = await replayDbService.getDriversInfo(sessionKey);
    if (driversInfo.length > 0) {
      this.drivers = driversInfo as DriverInfo[];
      this.driversMap.clear();
      this.drivers.forEach((d) => this.driversMap.set(d.driverNumber, d));
    }

    const { laps, stints } = await replayDbService.getLapsAndStints(sessionKey);
    this.lapsCache = laps;
    this.stintsCache = stints;
    if (laps.length > 0) {
      this.currentLap = Math.max(...laps.map((l: any) => l.lap_number || 0));
    }

    const snapshot = await replayDbService.getSnapshotAtTime(sessionKey, this.sessionEndMs);
    this.driverLocations = new Map(snapshot.locations);
    this.driverTelemetry = new Map(snapshot.telemetry);
    this.driverIntervals = new Map(snapshot.intervals);
    this.driverPositions = new Map(snapshot.positions);
    this.updateStints(this.stintsCache);

    return true;
  }

  /** Starts (restarting if already running) the master tiered-polling loop that drives the live feed. */
  private startPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => {
      this.pollAndBroadcast().catch((err) => {
        console.error('Poll error:', err.message);
      });
    }, this.pollIntervalMs);
  }

  private async pollAndBroadcast(): Promise<void> {
    // Periodically re-check for new sessions (e.g., next session starting).
    // Skipped entirely while a session is pinned (user explicitly loaded it
    // via Match Explorer) — otherwise this would silently revert their
    // choice back to "latest" within ~75 seconds.
    this.sessionCheckCounter++;
    if (this.sessionCheckCounter >= SESSION_RECHECK_TICKS) {
      this.sessionCheckCounter = 0;

      if (!this.isPinned) {
        const newSession = await openF1Service.getLatestSession();
        if (newSession && newSession.session_key !== this.sessionData?.session_key) {
          console.log(`New session detected: ${newSession.session_name} at ${newSession.circuit_short_name}`);
          await this.initialize(newSession.session_key);
          return;
        }
      }

      // Re-check if the current session (pinned or not) changed phase —
      // relevant both when a pinned upcoming session just started, and when
      // a live session we've been polling just finished (which needs a
      // fetchInitialState() re-run to trigger its one-time DB archival —
      // see the ensureIngested() call at the end of that method).
      if (this.sessionData) {
        const wasUpcoming = this.isUpcoming;
        const wasLive = this.isLive;
        this.isLive = openF1Service.isSessionLive(this.sessionData);
        this.isUpcoming = openF1Service.isSessionUpcoming(this.sessionData);
        if ((wasUpcoming && !this.isUpcoming) || (wasLive && !this.isLive)) {
          console.log(
            wasLive ? 'Session has ended — archiving to database...' : 'Session is now live! Re-fetching initial state...'
          );
          await this.fetchInitialState(this.sessionData.session_key);
        }
      }
    }

    // While the user is actively scrubbing/playing back a completed
    // session, the replay ticker (or seek()) owns fetching and broadcasting
    // — this periodic poll would otherwise rebuild a snapshot mid-fetch
    // from partially-updated maps. Just skip this tick; the next one will
    // pick up whatever the replay last settled on.
    if (!this.isLive && (this.isReplayPlaying || this.seekDebounceTimer)) {
      return;
    }

    const sessionKey = this.sessionData?.session_key || this.sessionMeta?.sessionKey || 0;
    if (!sessionKey) return;

    if (this.sessionData) {
      this.isLive = openF1Service.isSessionLive(this.sessionData);
    }

    // For a completed session there is no new data to fetch — polling with
    // wall-clock timestamps would query a time range that never occurred.
    // Just re-broadcast the current in-memory state (cheap, no API calls)
    // so late-joining clients still receive it via Redis.
    if (!this.isLive && !this.isUpcoming && this.hasReceivedData) {
      const snapshot = this.buildSnapshot();
      this.emit('tick', snapshot);
      messageBus.publish('f1:stream:global', JSON.stringify(snapshot)).catch(() => {});
      messageBus.set(`f1:session:${sessionKey}:snapshot`, JSON.stringify(snapshot), 30).catch(() => {});
      return;
    }

    if (this.isUpcoming) return;

    // Tiered live polling: each endpoint is only fetched on the master-tick
    // multiple matching its tier, instead of every endpoint every tick —
    // see the MASTER_TICK_MS / TIER*_EVERY_N_TICKS constants for the budget
    // this keeps us under. `since` covers back to whichever tier fired
    // longest ago (tier 1, every 7.5s) so no gap opens up between fetches.
    this.liveTickCounter++;
    const tick = this.liveTickCounter;
    const since = this.lastPollDate || this.getAnchorDate(10_000);
    let latestDate = this.lastPollDate || '';
    let fetchedAnything = false;

    if (tick % TIER1_EVERY_N_TICKS === 0) {
      const locations = await openF1Service.getLocations(sessionKey, since);
      if (locations.length > 0) {
        this.updateLocations(locations);
        const maxDate = locations.reduce((max: string, l: any) => l.date > max ? l.date : max, '');
        if (maxDate > latestDate) latestDate = maxDate;
        this.hasReceivedData = true;
        fetchedAnything = true;
      }
      await wait(REQUEST_STAGGER_MS);

      const carData = await openF1Service.getCarData(sessionKey, since);
      if (carData.length > 0) {
        this.updateCarData(carData);
        const maxDate = carData.reduce((max: string, d: any) => d.date > max ? d.date : max, '');
        if (maxDate > latestDate) latestDate = maxDate;
        fetchedAnything = true;
      }
    }

    if (tick % TIER2_EVERY_N_TICKS === 0) {
      if (fetchedAnything) await wait(REQUEST_STAGGER_MS);
      const positions = await openF1Service.getPositions(sessionKey, since);
      if (positions.length > 0) {
        this.updatePositions(positions);
        fetchedAnything = true;
      }

      if (this.hasGapData) {
        await wait(REQUEST_STAGGER_MS);
        const intervals = await openF1Service.getIntervals(sessionKey, since);
        if (intervals.length > 0) {
          this.updateIntervals(intervals);
          fetchedAnything = true;
        }
      }
    }

    if (tick % TIER3_EVERY_N_TICKS === 0) {
      if (fetchedAnything) await wait(REQUEST_STAGGER_MS);
      const laps = await openF1Service.getLatestLaps(sessionKey);
      if (laps.length > 0) {
        this.lapsCache = laps;
        const maxLap = Math.max(...laps.map((l: any) => l.lap_number || 0));
        if (maxLap > this.currentLap) this.currentLap = maxLap;
        fetchedAnything = true;
      }

      await wait(REQUEST_STAGGER_MS);
      const stints = await openF1Service.getStints(sessionKey);
      if (stints.length > 0) {
        this.stintsCache = stints;
        this.updateStints(stints);
        fetchedAnything = true;
      }
    }

    if (latestDate) this.lastPollDate = latestDate;

    // Build and broadcast snapshot only when something actually changed —
    // no need to re-push an identical grid on ticks where no tier fired.
    if (this.hasReceivedData && fetchedAnything) {
      const snapshot = this.buildSnapshot();
      this.emit('tick', snapshot);
      messageBus.publish('f1:stream:global', JSON.stringify(snapshot)).catch(() => {});
      messageBus.set(`f1:session:${sessionKey}:snapshot`, JSON.stringify(snapshot), 30).catch(() => {});
    }
  }

  /**
   * Refetches state as of an arbitrary point in a completed session's
   * timeline and broadcasts it — the engine behind timeline scrubbing.
   * Positions/intervals are fetched "everything up to targetMs, keep the
   * latest per driver" (cheap for a whole race); locations/car_data use a
   * bounded window immediately before targetMs (too high-frequency to fetch
   * unbounded). All per-driver maps are cleared first since a seek can move
   * backward in time, unlike normal forward-only polling.
   */
  private async seekToTime(targetMs: number): Promise<void> {
    if (this.isLive || this.isUpcoming) return;
    const sessionKey = this.sessionData?.session_key || 0;
    if (!sessionKey) return;

    const clamped = Math.max(this.sessionStartMs, Math.min(this.sessionEndMs, targetMs));
    this.replayPositionMs = clamped;

    try {
      // Fully archived: answer instantly from Postgres, no OpenF1 calls and
      // no rate-limit exposure at all — this is the whole point of ingesting.
      if (await replayDbService.isFullyIngested(sessionKey)) {
        await this.applyDbSnapshot(sessionKey, clamped);
        this.hasReceivedData = this.driverLocations.size > 0;
        if (this.hasReceivedData) this.publishSnapshot(sessionKey);
        this.emit('stateChange', this.getPlaybackState());
        return;
      }

      const targetIso = new Date(clamped).toISOString();
      const windowStartIso = new Date(clamped - 60_000).toISOString();

      const positions = await openF1Service.getPositions(sessionKey, undefined, targetIso);
      this.driverPositions.clear();
      this.updatePositions(positions);
      await wait(REQUEST_STAGGER_MS);

      if (this.hasGapData) {
        const intervals = await openF1Service.getIntervals(sessionKey, undefined, targetIso);
        this.driverIntervals.clear();
        this.updateIntervals(intervals);
        await wait(REQUEST_STAGGER_MS);
      }

      const locations = await openF1Service.getLocations(sessionKey, windowStartIso, targetIso);
      this.driverLocations.clear();
      this.updateLocations(locations);
      await wait(REQUEST_STAGGER_MS);

      const carData = await openF1Service.getCarData(sessionKey, windowStartIso, targetIso);
      this.driverTelemetry.clear();
      this.updateCarData(carData);

      this.currentLap = this.getLapAtTime(clamped);
      this.driverStints.clear();
      this.updateStints(this.stintsCache);

      this.hasReceivedData = this.driverLocations.size > 0;

      if (this.hasReceivedData) this.publishSnapshot(sessionKey);
    } catch (err: any) {
      console.error('Seek fetch failed:', err.message);
    }

    this.emit('stateChange', this.getPlaybackState());
  }

  /**
   * Lighter-weight sibling of seekToTime(), used only by the auto-play
   * ticker. Runs every REPLAY_TICK_MS (1s) so the timeline/position always
   * advances smoothly — but actually fetching fresh data that often would
   * be ~120 req/min against OpenF1 (four times the sustained budget the
   * tiered live-polling scheduler targets), so when not yet fully archived
   * this only fetches on the REPLAY_FETCH_TIER*-gated ticks (~8s / ~15s,
   * same idea as live polling's own tiers) and just re-broadcasts the
   * last-known state on the ticks in between — the frontend's client-side
   * LERP (identical to how it smooths live polling's own ~7.5s refreshes)
   * keeps the motion looking continuous regardless. Once fully archived,
   * every tick reads fresh from Postgres — cheap, no external rate limit,
   * genuinely second-by-second. Laps/stints are never refetched here since
   * they're already cached and cheap to re-derive from `getLapAtTime`.
   */
  private async replayTick(targetMs: number): Promise<void> {
    if (this.isLive || this.isUpcoming) return;
    const sessionKey = this.sessionData?.session_key || 0;
    if (!sessionKey) return;

    const clamped = Math.max(this.sessionStartMs, Math.min(this.sessionEndMs, targetMs));
    this.replayPositionMs = clamped;

    this.replayTickCounter++;
    const tick = this.replayTickCounter;

    try {
      // Fully archived: every tick answers from Postgres — full resolution,
      // every tick, no tiering needed.
      if (await replayDbService.isFullyIngested(sessionKey)) {
        await this.applyDbSnapshot(sessionKey, clamped);
        this.hasReceivedData = this.driverLocations.size > 0;
        if (this.hasReceivedData) this.publishSnapshot(sessionKey);
        this.emit('stateChange', this.getPlaybackState());
        return;
      }

      // Background archival is actively running for this exact session —
      // its own chunked fetches already saturate the request budget, so
      // don't ALSO run the OpenF1-fallback tier fetches here: the two would
      // compete for the same ~30 req/min ceiling, making both slower (this
      // is what previously made position updates arrive far less often than
      // the intended ~8s tier). Just hold the last-known picture and keep
      // the timeline label advancing — full resolution returns the moment
      // ingestion finishes, which this pause also gets to sooner.
      if (ingestionService.isIngesting(sessionKey)) {
        this.currentLap = this.getLapAtTime(clamped);
        this.driverStints.clear();
        this.updateStints(this.stintsCache);
        if (this.hasReceivedData) this.publishSnapshot(sessionKey);
        this.emit('stateChange', this.getPlaybackState());
        return;
      }

      const targetIso = new Date(clamped).toISOString();
      const windowStartIso = new Date(clamped - 60_000).toISOString();
      let fetchedAnything = false;

      if (tick % REPLAY_FETCH_TIER1_EVERY_N_TICKS === 0) {
        const locations = await openF1Service.getLocations(sessionKey, windowStartIso, targetIso);
        this.driverLocations.clear();
        this.updateLocations(locations);
        fetchedAnything = true;
        await wait(REQUEST_STAGGER_MS);

        const carData = await openF1Service.getCarData(sessionKey, windowStartIso, targetIso);
        this.driverTelemetry.clear();
        this.updateCarData(carData);
      }

      if (tick % REPLAY_FETCH_TIER2_EVERY_N_TICKS === 0) {
        if (fetchedAnything) await wait(REQUEST_STAGGER_MS);
        const positions = await openF1Service.getPositions(sessionKey, undefined, targetIso);
        this.driverPositions.clear();
        this.updatePositions(positions);
        fetchedAnything = true;

        if (this.hasGapData) {
          await wait(REQUEST_STAGGER_MS);
          const intervals = await openF1Service.getIntervals(sessionKey, undefined, targetIso);
          this.driverIntervals.clear();
          this.updateIntervals(intervals);
        }
      }

      // currentLap/stints are cheap local re-derivations (no fetch), so
      // these are safe to recompute every tick regardless of fetchedAnything
      // — advancing the lap/tyre-age label smoothly even between real
      // OpenF1 refreshes.
      this.currentLap = this.getLapAtTime(clamped);
      this.driverStints.clear();
      this.updateStints(this.stintsCache);

      this.hasReceivedData = this.driverLocations.size > 0;

      if (this.hasReceivedData) this.publishSnapshot(sessionKey);
    } catch (err: any) {
      console.error('Replay tick fetch failed:', err.message);
    }

    this.emit('stateChange', this.getPlaybackState());
  }

  private startReplayTicker(): void {
    this.stopReplayTicker();
    this.replayTickCounter = 0;

    this.replayTimer = setInterval(() => {
      if (!this.isReplayPlaying) return;
      const nextMs = this.replayPositionMs + REPLAY_TICK_MS * this.replaySpeed;
      if (nextMs >= this.sessionEndMs) {
        this.isReplayPlaying = false;
        this.stopReplayTicker();
        this.seekToTime(this.sessionEndMs).catch((err) => console.error('Replay final seek failed:', err.message));
        return;
      }
      this.replayTick(nextMs).catch((err) => console.error('Replay tick failed:', err.message));
    }, REPLAY_TICK_MS);
  }

  private stopReplayTicker(): void {
    if (this.replayTimer) {
      clearInterval(this.replayTimer);
      this.replayTimer = null;
    }
  }

  // --- Merge helpers: fold a batch of raw OpenF1 rows into the per-driver
  // state Maps that buildSnapshot() reads from. Each keeps only the latest
  // value per driver_number. ---

  private updateLocations(data: any[]): void {
    for (const loc of data) {
      this.driverLocations.set(loc.driver_number, { x: loc.x, y: loc.y, z: loc.z || 0 });
    }
  }

  private updateCarData(data: any[]): void {
    for (const car of data) {
      this.driverTelemetry.set(car.driver_number, {
        speed: Math.max(0, car.speed || 0),
        rpm: Math.max(0, car.rpm || 0),
        gear: car.n_gear || 0,
        throttle: Math.max(0, Math.min(100, car.throttle || 0)),
        brake: Math.max(0, Math.min(100, car.brake || 0)),
        drs: car.drs >= 10,
      });
    }
  }

  private updateIntervals(data: any[]): void {
    // Explicitly track the latest date per driver rather than assuming the
    // API returns rows in chronological order — matters now that completed
    // sessions fetch this unbounded (thousands of rows across the race).
    const latestDateByDriver = new Map<number, string>();
    for (const int of data) {
      const num = int.driver_number;
      const date = int.date || '';
      const prevDate = latestDateByDriver.get(num);
      if (prevDate !== undefined && date < prevDate) continue;
      latestDateByDriver.set(num, date);
      this.driverIntervals.set(num, {
        interval: openF1Service.parseInterval(int.interval),
        gapToLeader: openF1Service.parseInterval(int.gap_to_leader),
      });
    }
  }

  private updatePositions(data: any[]): void {
    for (const pos of data) {
      this.driverPositions.set(pos.driver_number, pos.position);
    }
  }

  /**
   * Picks each driver's active tyre stint as of `this.currentLap` (not
   * simply their highest stint_number, which would always be their FINAL
   * stint regardless of where in the race we're currently seeked to).
   */
  private updateStints(data: any[]): void {
    const latestByDriver = new Map<number, any>();
    for (const stint of data) {
      if ((stint.lap_start || 0) > this.currentLap) continue;
      const existing = latestByDriver.get(stint.driver_number);
      if (!existing || stint.stint_number > existing.stint_number) {
        latestByDriver.set(stint.driver_number, stint);
      }
    }

    for (const [driverNum, stint] of latestByDriver) {
      const compound = (stint.compound || 'UNKNOWN').toUpperCase() as TyreCompound;
      const validCompounds: TyreCompound[] = ['SOFT', 'MEDIUM', 'HARD', 'INTERMEDIATE', 'WET'];
      const tyreAge = Math.max(0, (this.currentLap || stint.lap_end || 0) - (stint.lap_start || 0) + (stint.tyre_age_at_start || 0));
      this.driverStints.set(driverNum, {
        compound: validCompounds.includes(compound) ? compound : 'UNKNOWN',
        age: tyreAge,
      });
    }
  }

  /**
   * Each driver's most recently completed lap time (seconds) as of
   * `this.currentLap` — see replay-session.service.ts's
   * `computeLapTimesAtLap` (identical logic, duplicated here to match this
   * class's existing stateful-recompute pattern rather than the stateless
   * replay functions it otherwise mirrors, e.g. `updateStints`/`getLapAtTime`).
   */
  private getLapTimesAtCurrentLap(): Map<number, number> {
    const latestByDriver = new Map<number, any>();
    for (const lap of this.lapsCache) {
      if (typeof lap.lap_duration !== 'number' || lap.lap_duration <= 0) continue;
      if (lap.is_pit_out_lap) continue;
      if ((lap.lap_number || 0) >= this.currentLap) continue;
      const existing = latestByDriver.get(lap.driver_number);
      if (!existing || (lap.lap_number || 0) > (existing.lap_number || 0)) {
        latestByDriver.set(lap.driver_number, lap);
      }
    }
    const result = new Map<number, number>();
    for (const [driverNum, lap] of latestByDriver) {
      result.set(driverNum, lap.lap_duration);
    }
    return result;
  }

  private buildSnapshot(): RaceSnapshot {
    const liveGrid: DriverLiveState[] = [];

    for (const driver of this.drivers) {
      const num = driver.driverNumber;
      const loc = this.driverLocations.get(num);
      const tel = this.driverTelemetry.get(num);
      const intv = this.driverIntervals.get(num);
      const pos = this.driverPositions.get(num);
      const stint = this.driverStints.get(num);

      if (!loc) continue;

      liveGrid.push({
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

    liveGrid.sort((a, b) => a.position - b.position);

    // Overtake battles are derived from gap-to-ahead, which only exists for
    // Race/Sprint sessions — computing it for Qualifying/Practice would
    // treat "no data" (0) as "side by side", inventing 95%-probability
    // battles between cars that are actually laps apart.
    // Sample time is wall-clock for a live session, but the replay/scrub
    // position (race time) for a completed one — see analyzeBattles' doc
    // for why mixing the two produces nonsensical closing rates.
    const sampleTimeMs = this.isLive ? Date.now() : this.replayPositionMs;
    const activeBattles = this.hasGapData
      ? overtakePredictionService.analyzeBattles(
          liveGrid,
          this.driversMap,
          sampleTimeMs,
          this.intervalHistory,
          this.hasDrs,
          this.probabilityHistory,
          this.getLapTimesAtCurrentLap()
        )
      : [];

    return {
      sessionKey: this.sessionData?.session_key || this.sessionMeta?.sessionKey || 0,
      timestamp: new Date().toISOString(),
      lapNumber: this.currentLap,
      hasGapData: this.hasGapData,
      grid: liveGrid,
      activeBattles,
    };
  }

  // --- Playback controls ---
  // For a LIVE session these are no-ops (you can't pause or scrub reality);
  // for a completed session they drive the replay/scrub timeline.

  /** @deprecated No longer wired to any route — see the class-level doc comment above. */
  public play(): void {
    if (this.isLive || this.isUpcoming) {
      this.emit('stateChange', this.getPlaybackState());
      return;
    }
    if (this.replayPositionMs >= this.sessionEndMs) {
      this.replayPositionMs = this.sessionStartMs;
    }
    this.isReplayPlaying = true;
    this.emit('stateChange', this.getPlaybackState());
    this.startReplayTicker();
  }

  /** @deprecated No longer wired to any route — see the class-level doc comment above. */
  public pause(): void {
    this.isReplayPlaying = false;
    this.stopReplayTicker();
    this.emit('stateChange', this.getPlaybackState());
  }

  /** @deprecated No longer wired to any route — see the class-level doc comment above. */
  public setSpeed(speed: 1 | 2 | 4): void {
    this.replaySpeed = speed;
    this.emit('stateChange', this.getPlaybackState());
  }

  /**
   * Scrubs to a position in [0, 1] along the completed session's real
   * timeline. Debounced: rapid slider drags only trigger one fetch, ~300ms
   * after the last move, so dragging across a race doesn't fire dozens of
   * OpenF1 requests. Ignored for live/upcoming sessions — you can't scrub
   * a race that's still happening or hasn't started.
   * @deprecated No longer wired to any route — see the class-level doc comment above.
   */
  public seek(progressRatio: number): void {
    if (this.isLive || this.isUpcoming) return;
    if (typeof progressRatio !== 'number' || !Number.isFinite(progressRatio)) return;
    if (this.sessionEndMs <= this.sessionStartMs) return;

    const ratio = Math.max(0, Math.min(1, progressRatio));
    const targetMs = this.sessionStartMs + ratio * (this.sessionEndMs - this.sessionStartMs);

    // Optimistic immediate feedback so the slider tracks the pointer
    // smoothly while the debounced fetch is still pending.
    this.replayPositionMs = targetMs;
    this.emit('stateChange', this.getPlaybackState());

    this.pendingSeekMs = targetMs;
    if (this.seekDebounceTimer) clearTimeout(this.seekDebounceTimer);
    this.seekDebounceTimer = setTimeout(() => {
      const target = this.pendingSeekMs;
      this.pendingSeekMs = null;
      this.seekDebounceTimer = null;
      if (target !== null) {
        this.seekToTime(target).catch((err) => console.error('Seek error:', err.message));
      }
    }, SEEK_DEBOUNCE_MS);
  }

  /** Current playback/live status for the shared live engine — for a live session this is real-time; the replay fields are vestigial (see class doc comment). */
  public getPlaybackState(): PlaybackState {
    return {
      isPlaying: this.isLive ? true : this.isReplayPlaying,
      isLive: this.isLive,
      speed: this.replaySpeed,
      currentTick: this.currentLap,
      totalTicks: this.totalLaps,
      sessionKey: this.sessionData?.session_key || this.sessionMeta?.sessionKey || 0,
      sessionStartMs: this.sessionStartMs,
      sessionEndMs: this.sessionEndMs,
      positionMs: this.isLive ? Date.now() : this.replayPositionMs,
    };
  }

  /** Metadata for the session the shared live engine currently has loaded (the live/auto-follow session), or `null` before the first one resolves. */
  public getSessionMeta(): SessionMeta | null { return this.sessionMeta; }
  /** Driver roster for the shared live engine's currently loaded session. */
  public getDrivers(): DriverInfo[] { return this.drivers; }
}

export const simulationEngine = new SimulationEngine();
export default simulationEngine;
