'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { ExplorerSession } from '../../types/f1';
import { X, CalendarDays, MapPin, Radio, Clock, Loader2 } from 'lucide-react';

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:4000';
const EARLIEST_YEAR = 2023; // OpenF1's historical data coverage begins here

interface MatchExplorerProps {
  isOpen: boolean;
  onClose: () => void;
  currentSessionKey: number;
  /** Loads a session for this tab only — other open tabs are unaffected. */
  onLoadSession: (sessionKey: number) => Promise<void>;
}

interface MeetingGroup {
  meetingKey: number;
  location: string;
  countryName: string;
  sessions: ExplorerSession[];
  latestDate: string;
}

/**
 * Picks the race weekend to auto-scroll to when a season's sessions load —
 * "the current one": if this weekend's first session (FP1) has already
 * started, that weekend; otherwise the most recently completed one (e.g.
 * Monday after a Sunday race, or any weekday before this weekend's FP1).
 * `meetings` is sorted newest-first (see groupByMeeting), so walking down
 * it and returning the first one whose first session is already in the
 * past finds exactly that.
 */
function findNearestMeetingKey(meetings: MeetingGroup[]): number | null {
  if (meetings.length === 0) return null;
  const now = Date.now();

  for (const m of meetings) {
    const firstSessionMs = new Date(m.sessions[0]?.date_start || m.latestDate).getTime();
    if (firstSessionMs <= now) return m.meetingKey;
  }

  // Nothing has started yet (e.g. browsing before the season opener) —
  // fall back to the soonest upcoming weekend, last in the newest-first list.
  return meetings[meetings.length - 1].meetingKey;
}

function groupByMeeting(sessions: ExplorerSession[]): MeetingGroup[] {
  const groups = new Map<number, MeetingGroup>();
  for (const s of sessions) {
    let group = groups.get(s.meeting_key);
    if (!group) {
      group = {
        meetingKey: s.meeting_key,
        location: s.location,
        countryName: s.country_name,
        sessions: [],
        latestDate: s.date_start,
      };
      groups.set(s.meeting_key, group);
    }
    group.sessions.push(s);
    if (s.date_start > group.latestDate) group.latestDate = s.date_start;
  }

  const list = Array.from(groups.values());
  list.forEach((g) => g.sessions.sort((a, b) => new Date(a.date_start).getTime() - new Date(b.date_start).getTime()));
  list.sort((a, b) => new Date(b.latestDate).getTime() - new Date(a.latestDate).getTime());
  return list;
}

export const MatchExplorer: React.FC<MatchExplorerProps> = ({ isOpen, onClose, currentSessionKey, onLoadSession }) => {
  const currentYear = new Date().getFullYear();
  const [year, setYear] = useState<number>(currentYear);
  const [sessions, setSessions] = useState<ExplorerSession[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadingKey, setLoadingKey] = useState<number | null>(null);
  const [sessionCache, setSessionCache] = useState<Record<number, ExplorerSession[]>>({});

  const years = useMemo(() => {
    const arr: number[] = [];
    for (let y = currentYear; y >= EARLIEST_YEAR; y--) arr.push(y);
    return arr;
  }, [currentYear]);

  useEffect(() => {
    if (!isOpen) return;

    // Use cached sessions if available to avoid redundant network calls and 429 rate limits
    if (sessionCache[year]) {
      setSessions(sessionCache[year]);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;

    const fetchSessions = async () => {
      setLoading(true);
      setError(null);
      try {
        const resp = await fetch(`${BACKEND_URL}/api/sessions/explorer?year=${year}`);
        const data = await resp.json();
        if (cancelled) return;
        if (!resp.ok || !data.success) {
          setError(data.error || 'Failed to load sessions.');
          setSessions([]);
          return;
        }
        const fetchedSessions = data.sessions || [];
        setSessions(fetchedSessions);
        setSessionCache((prev) => ({ ...prev, [year]: fetchedSessions }));
      } catch {
        if (!cancelled) {
          setError('Network error — could not reach the backend.');
          setSessions([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    fetchSessions();
    return () => {
      cancelled = true;
    };
  }, [isOpen, year, sessionCache]);

  const meetings = useMemo(() => groupByMeeting(sessions), [sessions]);

  // Auto-scroll to the current/most-recent race weekend whenever a season's
  // sessions finish loading (initial open, year tab switch, or a cache hit)
  // — otherwise the list opens at whatever meeting happens to be newest,
  // which for the current season is frequently a future weekend with no
  // data yet rather than the one actually relevant right now.
  useEffect(() => {
    if (!isOpen || loading || sessions.length === 0) return;
    const targetKey = findNearestMeetingKey(meetings);
    if (targetKey == null) return;

    const frame = requestAnimationFrame(() => {
      document.getElementById(`meeting-${targetKey}`)?.scrollIntoView({ block: 'center' });
    });
    return () => cancelAnimationFrame(frame);
  }, [isOpen, year, loading, sessions, meetings]);

  if (!isOpen) return null;

  const handleLoad = async (sessionKey: number) => {
    setLoadingKey(sessionKey);
    try {
      await onLoadSession(sessionKey);
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Failed to load session.');
    } finally {
      setLoadingKey(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="bg-[#0B0E14] border border-slate-700 rounded-2xl max-w-2xl w-full max-h-[85vh] overflow-hidden flex flex-col shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-slate-800">
          <div className="flex items-center gap-2">
            <CalendarDays className="w-4 h-4 text-amber-400" />
            <h2 className="text-sm font-black uppercase tracking-wider text-white font-mono">Match Explorer</h2>
          </div>
          <button onClick={onClose} className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Year selector */}
        <div className="flex items-center gap-2 px-5 py-3 border-b border-slate-800 overflow-x-auto">
          {years.map((y) => (
            <button
              key={y}
              onClick={() => setYear(y)}
              className={`px-3 py-1.5 rounded-lg text-xs font-mono font-bold whitespace-nowrap transition-colors ${
                y === year ? 'bg-f1-red text-white' : 'bg-slate-900 text-slate-400 hover:text-white border border-slate-800'
              }`}
            >
              {y}
            </button>
          ))}
        </div>

        {/* Session list */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {loading && (
            <div className="flex items-center justify-center py-10 text-slate-500 text-xs font-mono gap-2">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading {year} race weekends...
            </div>
          )}

          {!loading && error && (
            <div className="bg-red-950/40 border border-red-800/60 text-red-300 text-xs font-mono rounded-lg px-3 py-2">
              {error}
            </div>
          )}

          {!loading && !error && meetings.length === 0 && (
            <div className="text-center py-10 text-slate-500 text-xs font-mono">No sessions found for {year}.</div>
          )}

          {!loading &&
            meetings.map((meeting) => (
              <div
                key={meeting.meetingKey}
                id={`meeting-${meeting.meetingKey}`}
                className="bg-[#121620] border border-f1-border rounded-xl p-3.5 scroll-mt-3"
              >
                <div className="flex items-center gap-2 mb-2.5 text-xs font-mono text-slate-300">
                  <MapPin className="w-3.5 h-3.5 text-slate-500" />
                  <span className="font-bold text-white">{meeting.location}</span>
                  <span className="text-slate-600">•</span>
                  <span>{meeting.countryName}</span>
                </div>

                <div className="flex flex-wrap gap-2">
                  {meeting.sessions.map((s) => (
                    <div
                      key={s.session_key}
                      className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg border text-[11px] font-mono ${
                        s.session_key === currentSessionKey
                          ? 'border-amber-500/60 bg-amber-950/20'
                          : 'border-slate-800 bg-slate-950/50'
                      }`}
                    >
                      <span className="text-slate-300 font-semibold">{s.session_name}</span>

                      {s.isLive && (
                        <span className="flex items-center gap-1 text-red-400 font-bold">
                          <Radio className="w-3 h-3 animate-pulse" /> LIVE
                        </span>
                      )}
                      {!s.isLive && s.isUpcoming && (
                        <span className="flex items-center gap-1 text-slate-500">
                          <Clock className="w-3 h-3" /> Upcoming
                        </span>
                      )}

                      {s.isUpcoming ? (
                        <span className="text-slate-600 text-[10px]">No data yet</span>
                      ) : (
                        <button
                          onClick={() => handleLoad(s.session_key)}
                          disabled={loadingKey !== null}
                          className="px-2 py-0.5 bg-slate-800 hover:bg-f1-red disabled:opacity-50 text-white rounded transition-colors text-[10px] font-bold"
                        >
                          {loadingKey === s.session_key ? '...' : s.session_key === currentSessionKey ? 'Reload' : 'Load'}
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}
        </div>
      </div>
    </div>
  );
};

export default MatchExplorer;
