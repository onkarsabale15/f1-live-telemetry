import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import { z } from 'zod';
import { ServerToClientEvents, ClientToServerEvents, InterServerEvents, SocketData, ReplayState } from './event.types';
import { simulationEngine } from '../services/simulation.service';
import { messageBus } from '../db/redis.client';
import { RaceSnapshot, SessionMeta } from '../domain/models';
import { ENV } from '../config/env';
import {
  resolveSession,
  loadArchivedReplayMeta,
  ensureSessionArchiving,
  buildReplaySnapshot,
} from '../services/replay-session.service';

const SubscribeDriverSchema = z.object({
  driverNumber: z.number().int().positive().max(99),
});

const PlaybackControlSchema = z.object({
  action: z.enum(['play', 'pause', 'seek']),
  speed: z.union([z.literal(1), z.literal(2), z.literal(4)]).optional(),
  progress: z
    .number()
    .refine((val) => Number.isFinite(val), { message: 'Progress must be a finite number' })
    .refine((val) => val >= 0.0 && val <= 1.0, { message: 'Progress must be between 0.0 and 1.0' })
    .optional(),
});

const LoadSessionSchema = z.object({
  sessionKey: z.number().int().positive().optional(),
});

// Same cadence as the old shared replay ticker — decoupled per socket now,
// so one viewer's scrub/play/pause never touches another's.
const REPLAY_TICK_MS = 1000;
const SEEK_DEBOUNCE_MS = 300;

type AppSocket = Socket<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;

/**
 * Socket.IO gateway — owns per-connection replay state (see `ReplayState` in
 * event.types.ts) so each browser tab can independently browse a different
 * session and scrub position, while every socket watching a genuinely live
 * session shares one broadcast (the 'live' room) fed by the single
 * `simulationEngine` poll loop.
 */
export class F1WebSocketGateway {
  private io: Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;

  constructor(httpServer: HttpServer) {
    const allowedOrigins = ENV.NODE_ENV === 'production'
      ? [ENV.CORS_ORIGIN]
      : [ENV.CORS_ORIGIN, 'http://localhost:3000', 'http://127.0.0.1:3000'];

    this.io = new Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>(httpServer, {
      cors: {
        origin: allowedOrigins,
        methods: ['GET', 'POST'],
        credentials: true,
      },
      pingInterval: 10000,
      pingTimeout: 5000,
    });

    this.setupListeners();
    this.setupRedisSubscriber();
  }

  /** Shapes a socket's ReplayState into the PlaybackState the frontend expects. */
  private buildPlaybackState(replay: ReplayState): any {
    const totalLaps = replay.lapsCache.reduce((max: number, l: any) => Math.max(max, l.lap_number || 0), 0);
    return {
      isPlaying: replay.isLive ? true : replay.isPlaying,
      isLive: replay.isLive,
      speed: replay.speed,
      currentTick: totalLaps, // recomputed properly once a snapshot lands; fine as an initial estimate
      totalTicks: totalLaps,
      sessionKey: replay.sessionKey,
      sessionStartMs: replay.sessionStartMs,
      sessionEndMs: replay.sessionEndMs,
      positionMs: replay.isLive ? Date.now() : replay.positionMs,
    };
  }

  /** Clears a socket's replay ticker and pending seek-debounce timer, if any — called before loading a new session and on disconnect. */
  private clearTimers(socket: AppSocket): void {
    if (socket.data.tickTimer) clearInterval(socket.data.tickTimer);
    if (socket.data.seekDebounceTimer) clearTimeout(socket.data.seekDebounceTimer);
    socket.data.tickTimer = undefined;
    socket.data.seekDebounceTimer = undefined;
  }

  /** Emits a fresh grid snapshot + playback state for this socket's current replay position. */
  private async emitReplaySnapshot(socket: AppSocket): Promise<void> {
    const replay = socket.data.replay;
    if (!replay || replay.isLive) return;
    try {
      const snapshot = await buildReplaySnapshot({
        sessionKey: replay.sessionKey,
        atMs: replay.positionMs,
        drivers: replay.drivers,
        lapsCache: replay.lapsCache,
        stintsCache: replay.stintsCache,
        hasGapData: replay.hasGapData,
        intervalHistory: replay.intervalHistory,
      });
      if (!socket.connected) return;
      socket.emit('f1:v1:grid_snapshot', snapshot as RaceSnapshot);
      const playback = this.buildPlaybackState(replay);
      playback.currentTick = snapshot.lapNumber;
      socket.emit('f1:v1:playback_state', playback);
    } catch (err: any) {
      console.error(`Replay snapshot failed for socket ${socket.id}:`, err?.message);
    }
  }

  /** Starts (restarting if one is already running) this socket's own 1-second replay tick — independent of every other connection's. */
  private startTicker(socket: AppSocket): void {
    if (socket.data.tickTimer) clearInterval(socket.data.tickTimer);
    socket.data.tickTimer = setInterval(() => {
      const replay = socket.data.replay;
      if (!replay || replay.isLive || !replay.isPlaying) return;

      replay.positionMs = Math.min(replay.sessionEndMs, replay.positionMs + REPLAY_TICK_MS * replay.speed);
      if (replay.positionMs >= replay.sessionEndMs) replay.isPlaying = false;

      this.emitReplaySnapshot(socket).catch(() => {});
    }, REPLAY_TICK_MS);
  }

  /**
   * Resolves and loads a session for THIS socket only — the core of per-tab
   * independence. A live session joins the shared 'live' broadcast room
   * (one OpenF1 poll serves every viewer); an archived session gets its own
   * DB-backed ticker; a completed-but-not-yet-archived session triggers
   * archival and tells the client to wait.
   */
  private async loadSessionForSocket(socket: AppSocket, sessionKey?: number): Promise<void> {
    this.clearTimers(socket);
    socket.leave('live');

    const resolved = await resolveSession(sessionKey);
    if (!resolved) {
      socket.emit('f1:v1:load_error', { message: 'No session available.' });
      return;
    }

    if (resolved.isUpcoming) {
      const placeholderMeta: SessionMeta = {
        sessionKey: resolved.session.session_key,
        circuitKey: resolved.session.circuit_key,
        circuitShortName: resolved.session.circuit_short_name,
        countryName: resolved.session.country_name,
        location: resolved.session.location,
        year: resolved.session.year,
        sessionName: resolved.session.session_name,
        sessionType: resolved.session.session_type,
        hasGapData: resolved.hasGapData,
        hasDrs: resolved.hasDrs,
        bounds: { minX: 0, maxX: 1000, minY: 0, maxY: 1000, width: 1000, height: 1000 },
        trackPath: [],
      };
      socket.data.replay = undefined;
      socket.emit('f1:v1:session_init', {
        sessionMeta: placeholderMeta,
        drivers: [],
        playback: {
          isPlaying: false, isLive: false, speed: 1, currentTick: 0, totalTicks: 0,
          sessionKey: resolved.session.session_key, sessionStartMs: 0, sessionEndMs: 0, positionMs: 0,
        } as any,
      });
      return;
    }

    if (resolved.isLive) {
      socket.join('live');
      socket.data.replay = {
        sessionKey: resolved.session.session_key,
        isLive: true,
        isPlaying: true,
        speed: 1,
        positionMs: Date.now(),
        sessionStartMs: 0,
        sessionEndMs: 0,
        drivers: simulationEngine.getDrivers(),
        lapsCache: [],
        stintsCache: [],
        hasGapData: resolved.hasGapData,
        hasDrs: resolved.hasDrs,
        intervalHistory: new Map(),
      };

      const sessionMeta = simulationEngine.getSessionMeta();
      if (sessionMeta) {
        socket.emit('f1:v1:session_init', {
          sessionMeta,
          drivers: simulationEngine.getDrivers(),
          playback: simulationEngine.getPlaybackState(),
        });
      }
      try {
        const cached = await messageBus.get(`f1:session:${resolved.session.session_key}:snapshot`);
        if (cached && socket.connected) socket.emit('f1:v1:grid_snapshot', JSON.parse(cached));
      } catch {}
      return;
    }

    if (resolved.isArchived) {
      const meta = await loadArchivedReplayMeta(resolved.session.session_key);
      if (!meta) {
        socket.emit('f1:v1:load_error', { message: 'Session data unavailable.' });
        return;
      }
      socket.data.replay = {
        sessionKey: resolved.session.session_key,
        isLive: false,
        isPlaying: false,
        speed: 1,
        positionMs: meta.sessionEndMs,
        sessionStartMs: meta.sessionStartMs,
        sessionEndMs: meta.sessionEndMs,
        drivers: meta.drivers,
        lapsCache: meta.lapsCache,
        stintsCache: meta.stintsCache,
        hasGapData: resolved.hasGapData,
        hasDrs: resolved.hasDrs,
        intervalHistory: new Map(),
      };
      socket.emit('f1:v1:session_init', {
        sessionMeta: meta.sessionMeta,
        drivers: meta.drivers,
        playback: this.buildPlaybackState(socket.data.replay),
      });
      this.startTicker(socket);
      await this.emitReplaySnapshot(socket);
      return;
    }

    // Completed, not archived yet: kick off archival and hand back whatever
    // metadata we can build immediately — the client's existing
    // ingest-status poll (see PlaybackBar) shows progress from here.
    const archiving = await ensureSessionArchiving(resolved);
    if (archiving) {
      socket.data.replay = {
        sessionKey: resolved.session.session_key,
        isLive: false,
        isPlaying: false,
        speed: 1,
        positionMs: archiving.sessionEndMs,
        sessionStartMs: archiving.sessionStartMs,
        sessionEndMs: archiving.sessionEndMs,
        drivers: archiving.drivers,
        lapsCache: [],
        stintsCache: [],
        hasGapData: resolved.hasGapData,
        hasDrs: resolved.hasDrs,
        intervalHistory: new Map(),
      };
      socket.emit('f1:v1:session_init', {
        sessionMeta: archiving.sessionMeta,
        drivers: archiving.drivers,
        playback: this.buildPlaybackState(socket.data.replay),
      });
    } else {
      // Another viewer already triggered this — try once more shortly;
      // if it's now archived this resolves normally on retry.
      socket.emit('f1:v1:load_error', { message: 'This session is still being archived — check back shortly.' });
    }
  }

  /** Registers the connection handler and every client-to-server event listener (load_session, playback_control, driver subscribe/unsubscribe). */
  private setupListeners(): void {
    this.io.on('connection', (socket: AppSocket) => {
      console.log(`🔌 Client connected: ${socket.id}`);

      // Default subscribe to the race leader (driver #1)
      socket.data.focusedDriver = 1;
      socket.join(`driver:1`);

      // A brand-new tab defaults to "whatever's currently most relevant"
      // (live if there is one, otherwise the latest completed session) —
      // same default the app has always opened to, just resolved per-socket
      // now instead of once globally at server startup.
      this.loadSessionForSocket(socket).catch((err: any) => {
        console.error(`Initial session load failed for ${socket.id}:`, err?.message);
      });

      socket.on('client:v1:load_session', (rawPayload: any) => {
        const parsed = LoadSessionSchema.safeParse(rawPayload || {});
        if (!parsed.success) {
          socket.emit('f1:v1:load_error', { message: 'Invalid load_session payload' });
          return;
        }
        this.loadSessionForSocket(socket, parsed.data.sessionKey).catch((err: any) => {
          console.error(`Session load failed for ${socket.id}:`, err?.message);
          socket.emit('f1:v1:load_error', { message: 'Failed to load session.' });
        });
      });

      socket.on('client:v1:subscribe_driver', (rawPayload: any) => {
        try {
          const parsed = SubscribeDriverSchema.safeParse(rawPayload);
          if (!parsed.success) {
            (socket as any).emit('error', {
              message: 'Invalid subscribe payload',
              details: parsed.error.issues,
            });
            return;
          }
          const { driverNumber } = parsed.data;
          if (socket.data.focusedDriver) {
            socket.leave(`driver:${socket.data.focusedDriver}`);
          }
          socket.data.focusedDriver = driverNumber;
          socket.join(`driver:${driverNumber}`);
          console.log(`🏎️ Client ${socket.id} focused on driver ${driverNumber}`);
        } catch (err: any) {
          console.error(`Error processing subscribe_driver from ${socket.id}:`, err?.message);
        }
      });

      socket.on('client:v1:unsubscribe_driver', (rawPayload: any) => {
        try {
          const parsed = SubscribeDriverSchema.safeParse(rawPayload);
          if (!parsed.success) {
            (socket as any).emit('error', {
              message: 'Invalid unsubscribe payload',
              details: parsed.error.issues,
            });
            return;
          }
          socket.leave(`driver:${parsed.data.driverNumber}`);
        } catch (err: any) {
          console.error(`Error processing unsubscribe_driver from ${socket.id}:`, err?.message);
        }
      });

      // Playback controls from client — scoped to this socket's own replay
      // state (see loadSessionForSocket), not any shared/global position.
      socket.on('client:v1:playback_control', (rawPayload: any) => {
        try {
          const parsed = PlaybackControlSchema.safeParse(rawPayload);
          if (!parsed.success) {
            (socket as any).emit('error', {
              message: 'Invalid playback control payload',
              details: parsed.error.issues,
            });
            return;
          }
          const { action, speed, progress } = parsed.data;
          const replay = socket.data.replay;
          if (!replay || replay.isLive) return; // no-op for live — you can't pause reality

          if (action === 'play') {
            if (replay.positionMs >= replay.sessionEndMs) replay.positionMs = replay.sessionStartMs;
            replay.isPlaying = true;
            socket.emit('f1:v1:playback_state', this.buildPlaybackState(replay));
          } else if (action === 'pause') {
            replay.isPlaying = false;
            socket.emit('f1:v1:playback_state', this.buildPlaybackState(replay));
          } else if (action === 'seek') {
            if (typeof progress !== 'number' || !Number.isFinite(progress) || progress < 0 || progress > 1) {
              (socket as any).emit('error', {
                message: 'Seek action requires a finite progress value between 0.0 and 1.0',
              });
              return;
            }
            if (replay.sessionEndMs <= replay.sessionStartMs) return;
            const targetMs = replay.sessionStartMs + progress * (replay.sessionEndMs - replay.sessionStartMs);
            replay.positionMs = targetMs;
            replay.intervalHistory.clear();
            socket.emit('f1:v1:playback_state', this.buildPlaybackState(replay));

            // Debounced per socket, same rationale as the old global seek:
            // a dragged slider fires many seeks per second, only the last
            // one after the pointer settles needs an actual DB round trip.
            if (socket.data.seekDebounceTimer) clearTimeout(socket.data.seekDebounceTimer);
            socket.data.seekDebounceTimer = setTimeout(() => {
              this.emitReplaySnapshot(socket).catch(() => {});
            }, SEEK_DEBOUNCE_MS);
          }

          if (speed !== undefined) {
            replay.speed = speed;
            socket.emit('f1:v1:playback_state', this.buildPlaybackState(replay));
          }
        } catch (err: any) {
          console.error(`Error processing playback_control from ${socket.id}:`, err?.message);
        }
      });

      socket.on('disconnect', () => {
        this.clearTimers(socket);
        console.log(`❌ Client disconnected: ${socket.id}`);
      });
    });
  }

  /**
   * Subscribes to Redis Pub/Sub message bus to broadcast the shared LIVE
   * feed to whichever sockets are currently watching it (the 'live' room) —
   * archived-session viewers each get their own snapshots from their own
   * per-socket ticker instead, so they're deliberately excluded here.
   *
   * No separate per-driver telemetry_tick broadcast: the frontend already
   * extracts the focused driver's data straight out of grid_snapshot (it
   * has every driver every tick), and a driver-room broadcast can't be
   * scoped to "live AND focused on this driver" with Socket.IO's room
   * union semantics without leaking live data to replay viewers who
   * happen to share a driver:X room for an unrelated session.
   */
  private setupRedisSubscriber(): void {
    messageBus.subscribe('f1:stream:global', (rawMsg: string) => {
      try {
        const snapshot: RaceSnapshot = JSON.parse(rawMsg);
        this.io.to('live').emit('f1:v1:grid_snapshot', snapshot);
      } catch (err: any) {
        console.error('Failed to parse and broadcast tick from Redis:', err.message);
      }
    });
  }

  /** Exposes the underlying Socket.IO server instance, e.g. for tests. */
  public getIO() {
    return this.io;
  }
}

export default F1WebSocketGateway;
