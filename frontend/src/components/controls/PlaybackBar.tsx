'use client';

import React, { useEffect, useState } from 'react';
import { PlaybackState } from '../../types/f1';
import { Activity, Radio, Satellite, Play, Pause, Database } from 'lucide-react';
import { formatDuration } from '../../utils/formatLapTime';

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:4000';

interface PlaybackBarProps {
  playback: PlaybackState;
  isConnected: boolean;
  onControl: (action: 'play' | 'pause' | 'seek', speed?: 1 | 2 | 4, progress?: number) => void;
  /** Called once when this session's archival job finishes, so the caller can reload it and pick up full replay data. */
  onArchivingComplete?: () => void;
}

/**
 * Top status bar — shows LIVE status or replay transport controls
 * (play/pause/speed/scrub) depending on `playback.isLive`, plus an
 * "ARCHIVING X%" badge while a completed session's one-time DB archival is
 * still running (see the ingest-status poll below).
 */
export const PlaybackBar: React.FC<PlaybackBarProps> = ({ playback, isConnected, onControl, onArchivingComplete }) => {
  const isReplayable = !playback.isLive && playback.sessionEndMs > playback.sessionStartMs;

  // Polls the one-time archival job's progress while a completed session
  // hasn't been fully archived yet — car motion pauses server-side during
  // this window (see replayTick()'s isIngesting guard) so ingestion gets
  // the full request budget instead of competing with replay's own fetches.
  const [ingestStatus, setIngestStatus] = useState<{ status: string; progress: number } | null>(null);

  useEffect(() => {
    if (!isReplayable || !playback.sessionKey) {
      setIngestStatus(null);
      return;
    }
    let cancelled = false;

    const poll = async () => {
      try {
        const resp = await fetch(`${BACKEND_URL}/api/sessions/${playback.sessionKey}/ingest-status`);
        const data = await resp.json();
        if (cancelled || !data.success) return;
        setIngestStatus((prev) => {
          if (prev && prev.status !== 'COMPLETE' && data.status === 'COMPLETE') {
            onArchivingComplete?.();
          }
          return { status: data.status, progress: data.progress };
        });
      } catch {
        // Non-critical — just skip this poll
      }
    };

    poll();
    const interval = setInterval(poll, 3000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [isReplayable, playback.sessionKey]);

  const isArchiving = ingestStatus?.status === 'IN_PROGRESS';

  const duration = playback.sessionEndMs - playback.sessionStartMs;
  const elapsed = Math.max(0, Math.min(duration, playback.positionMs - playback.sessionStartMs));
  const ratio = duration > 0 ? elapsed / duration : 0;

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newRatio = parseFloat(e.target.value);
    onControl('seek', undefined, newRatio);
  };

  const handleSpeed = (spd: 1 | 2 | 4) => {
    onControl(playback.isPlaying ? 'play' : 'pause', spd);
  };

  return (
    <div className="bg-[#0F1218] rounded-xl border border-f1-border p-3.5 flex flex-wrap items-center justify-between gap-4 shadow-xl">
      {/* Live badge + lap counter, OR replay controls */}
      {playback.isLive ? (
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 px-3 py-1.5 bg-red-600 text-white rounded-lg text-xs font-bold font-mono shadow-md shadow-red-900/40 animate-pulse">
            <Radio className="w-3.5 h-3.5" />
            LIVE
          </div>
          {playback.currentTick > 0 && (
            <div className="flex items-center gap-1.5 bg-slate-900 border border-slate-800 rounded-lg px-3 py-1.5">
              <span className="text-[11px] font-mono text-slate-400">LAP</span>
              <span className="text-sm font-mono font-black text-white">{playback.currentTick}</span>
            </div>
          )}
        </div>
      ) : isReplayable ? (
        <div className="flex-1 min-w-[240px] flex flex-wrap items-center gap-2.5 sm:gap-3">
          {/* Replay badge */}
          <div className="flex items-center gap-1.5 px-2.5 py-1.5 bg-slate-700 text-slate-200 rounded-lg text-[11px] font-bold font-mono whitespace-nowrap">
            <Satellite className="w-3.5 h-3.5" />
            REPLAY
          </div>

          {/* Archival progress — motion pauses on the map while this runs so
              ingestion gets the full OpenF1 request budget; full-resolution
              second-by-second replay kicks in the moment it completes. */}
          {isArchiving && (
            <div
              className="flex items-center gap-1.5 px-2.5 py-1.5 bg-amber-950/40 border border-amber-700/50 text-amber-300 rounded-lg text-[11px] font-bold font-mono whitespace-nowrap"
              title="Downloading this race's full telemetry once so future replays are instant — car motion resumes when this finishes."
            >
              <Database className="w-3.5 h-3.5 animate-pulse" />
              ARCHIVING {ingestStatus?.progress ?? 0}%
            </div>
          )}

          {/* Play / Pause */}
          <button
            onClick={() => onControl(playback.isPlaying ? 'pause' : 'play')}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-f1-red hover:bg-red-700 text-white rounded-lg text-xs font-bold font-mono transition-colors shadow-md shadow-red-900/30 whitespace-nowrap"
          >
            {playback.isPlaying ? (
              <>
                <Pause className="w-3.5 h-3.5" /> PAUSE
              </>
            ) : (
              <>
                <Play className="w-3.5 h-3.5" /> PLAY
              </>
            )}
          </button>

          {/* Speed toggles */}
          <div className="flex items-center bg-slate-900 border border-slate-800 rounded-lg p-0.5">
            {([1, 2, 4] as const).map((spd) => (
              <button
                key={spd}
                onClick={() => handleSpeed(spd)}
                className={`px-2 py-1 text-[11px] font-mono font-bold rounded ${
                  playback.speed === spd ? 'bg-slate-700 text-white shadow' : 'text-slate-400 hover:text-white'
                }`}
              >
                {spd}x
              </button>
            ))}
          </div>

          {/* Scrub slider */}
          <div className="basis-full sm:basis-auto flex-1 min-w-[140px] flex items-center gap-2">
            <span className="text-[11px] font-mono text-slate-400 whitespace-nowrap">
              {playback.currentTick > 0 ? `L${playback.currentTick}` : ''} {formatDuration(elapsed)}
            </span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.001}
              value={ratio}
              onChange={handleSeek}
              className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-f1-red"
            />
            <span className="text-[11px] font-mono text-slate-500 whitespace-nowrap">{formatDuration(duration)}</span>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2 px-3 py-1.5 bg-slate-700 text-slate-200 rounded-lg text-xs font-mono font-semibold">
          <Satellite className="w-3.5 h-3.5" />
          {playback.sessionKey ? 'LOADING SESSION...' : 'CONNECTING...'}
        </div>
      )}

      {/* Data Source Info */}
      <div className="flex items-center gap-2 text-[11px] font-mono text-slate-400">
        <span className="bg-slate-900/80 border border-slate-800 px-2.5 py-1 rounded text-emerald-400 font-semibold">
          OpenF1 API
        </span>
        <span className="text-slate-500 hidden sm:inline">Real-Time Data Feed</span>
      </div>

      {/* WebSocket Connection Status */}
      <div className="flex items-center gap-2">
        <span className="flex h-2 w-2 relative">
          <span
            className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${
              isConnected ? 'bg-emerald-400' : 'bg-red-400'
            }`}
          />
          <span
            className={`relative inline-flex rounded-full h-2 w-2 ${
              isConnected ? 'bg-emerald-500' : 'bg-red-500'
            }`}
          />
        </span>
        <span className="text-[11px] font-mono text-slate-300 flex items-center gap-1">
          <Activity className="w-3 h-3 text-slate-400" />
          {isConnected ? 'CONNECTED' : 'RECONNECTING'}
        </span>
      </div>
    </div>
  );
};

export default PlaybackBar;
