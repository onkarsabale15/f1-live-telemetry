import { RaceSnapshot, DriverLiveState, OvertakeBattle, SessionMeta, DriverInfo } from '../domain/models';
import { PlaybackState } from '../services/simulation.service';
import { IntervalHistory } from '../services/prediction.service';

export interface ServerToClientEvents {
  'f1:v1:session_init': (data: { sessionMeta: SessionMeta; drivers: DriverInfo[]; playback: PlaybackState }) => void;
  'f1:v1:grid_snapshot': (snapshot: RaceSnapshot) => void;
  'f1:v1:telemetry_tick': (telemetry: DriverLiveState) => void;
  'f1:v1:overtake_alert': (battles: OvertakeBattle[]) => void;
  'f1:v1:playback_state': (state: PlaybackState) => void;
  'f1:v1:load_error': (data: { message: string }) => void;
}

export interface ClientToServerEvents {
  'client:v1:subscribe_driver': (data: { driverNumber: number }) => void;
  'client:v1:unsubscribe_driver': (data: { driverNumber: number }) => void;
  'client:v1:playback_control': (data: { action: 'play' | 'pause' | 'seek'; speed?: 1 | 2 | 4; progress?: number }) => void;
  'client:v1:load_session': (data: { sessionKey?: number }) => void;
}

export interface InterServerEvents {
  ping: () => void;
}

// Per-connection replay state — this is what makes two tabs independent:
// each socket owns its own session choice, scrub position, and play state
// instead of sharing one global position. Only genuinely live sessions are
// shared (via the 'live' room), since sharing one OpenF1 poll across every
// viewer is required to stay under the rate-limit budget.
export interface ReplayState {
  sessionKey: number;
  isLive: boolean;
  isPlaying: boolean;
  speed: 1 | 2 | 4;
  positionMs: number;
  sessionStartMs: number;
  sessionEndMs: number;
  drivers: DriverInfo[];
  lapsCache: any[];
  stintsCache: any[];
  hasGapData: boolean;
  hasDrs: boolean;
  intervalHistory: IntervalHistory;
}

export interface SocketData {
  userId?: string;
  focusedDriver?: number;
  replay?: ReplayState;
  tickTimer?: ReturnType<typeof setInterval>;
  seekDebounceTimer?: ReturnType<typeof setTimeout>;
}
