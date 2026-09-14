'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { DriverLiveState, TyreStrategyResult } from '../../types/f1';
import { getTyreBadge } from '../../utils/f1Tyres';
import { Layers } from 'lucide-react';

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:4000';

interface TyreStrategyTimelineProps {
  sessionKey: number;
  currentLap?: number;
  grid: DriverLiveState[];
  focusedDriverNumber?: number;
  onSelectDriver?: (driverNumber: number) => void;
}

export const TyreStrategyTimeline: React.FC<TyreStrategyTimelineProps> = ({
  sessionKey,
  currentLap,
  grid,
  focusedDriverNumber,
  onSelectDriver,
}) => {
  const [strategy, setStrategy] = useState<TyreStrategyResult | null>(null);
  const [loading, setLoading] = useState(false);

  // Re-fetches whenever the replay/live lap advances (or the scrubber jumps
  // to a different lap), so stints and pit stops fill in progressively
  // instead of always showing the session's final, fully-raced state.
  useEffect(() => {
    if (!sessionKey) return;
    let cancelled = false;

    const fetchStrategy = async () => {
      setLoading((prev) => (strategy ? prev : true));
      try {
        const uptoLapParam = currentLap != null ? `?uptoLap=${currentLap}` : '';
        const res = await fetch(`${BACKEND_URL}/api/sessions/${sessionKey}/tyre-strategy${uptoLapParam}`);
        if (!res.ok) throw new Error('Failed to load tyre strategy');
        const json = await res.json();
        if (!cancelled && json.success) setStrategy(json);
      } catch {
        if (!cancelled) setStrategy(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    fetchStrategy();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionKey, currentLap]);

  const positionMap = useMemo(() => {
    const map = new Map<number, number>();
    grid.forEach((g: DriverLiveState) => map.set(g.driverNumber, g.position));
    return map;
  }, [grid]);

  const sortedDrivers = useMemo(() => {
    if (!strategy) return [];
    return [...strategy.drivers].sort((a, b) => {
      const posA = positionMap.get(a.driverNumber) ?? 999;
      const posB = positionMap.get(b.driverNumber) ?? 999;
      if (posA !== posB) return posA - posB;
      return a.driverNumber - b.driverNumber;
    });
  }, [strategy, positionMap]);

  const totalLaps = strategy?.totalLaps || 0;
  const axisTicks = useMemo(() => {
    if (totalLaps <= 0) return [];
    const step = Math.max(1, Math.round(totalLaps / 6 / 5) * 5) || Math.max(1, Math.round(totalLaps / 6));
    const ticks: number[] = [];
    for (let lap = step; lap < totalLaps; lap += step) ticks.push(lap);
    ticks.push(totalLaps);
    return ticks;
  }, [totalLaps]);

  const currentLapPct =
    totalLaps > 0 && currentLap && currentLap > 0 ? Math.min(100, (currentLap / totalLaps) * 100) : null;

  return (
    <div className="bg-[#0B0E14] border border-f1-border rounded-xl p-4 shadow-xl">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800/80 pb-3 mb-3.5">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 bg-red-950/80 border border-red-800/70 rounded-lg flex items-center justify-center text-red-400 shadow">
            <Layers className="w-4 h-4" />
          </div>
          <div>
            <h3 className="text-xs font-black font-mono tracking-wider uppercase text-white">
              Tyre Strategy Timeline
            </h3>
            <p className="text-[10px] font-mono text-slate-500">
              Full-race stint history &amp; pit stops, every driver
            </p>
          </div>
        </div>

        {/* Compound Legend */}
        <div className="flex items-center gap-2.5 text-[10px] font-mono">
          {(['SOFT', 'MEDIUM', 'HARD', 'INTERMEDIATE', 'WET'] as const).map((c) => {
            const badge = getTyreBadge(c);
            return (
              <div key={c} className="flex items-center gap-1">
                <span className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: badge.hex }} />
                <span className="text-slate-400">{badge.code}</span>
              </div>
            );
          })}
        </div>
      </div>

      {loading && !strategy ? (
        <div className="text-center py-10 text-slate-500 text-xs font-mono">Loading tyre strategy...</div>
      ) : !strategy || sortedDrivers.length === 0 ? (
        <div className="text-center py-10 text-slate-500 text-xs font-mono">No stint data available yet</div>
      ) : (
        <div className="space-y-1.5">
          {/* Lap axis */}
          <div className="flex items-center gap-2 pl-[92px]">
            <div className="relative flex-1 h-4 text-[9px] font-mono text-slate-600">
              <span className="absolute left-0">L1</span>
              {axisTicks.map((lap) => (
                <span
                  key={lap}
                  className="absolute -translate-x-1/2"
                  style={{ left: `${(lap / totalLaps) * 100}%` }}
                >
                  {lap}
                </span>
              ))}
            </div>
          </div>

          {/* Rows */}
          <div className="relative">
            {/* Current lap marker, spanning all rows */}
            {currentLapPct !== null && (
              <div
                className="absolute top-0 bottom-0 w-px bg-cyan-400/70 z-10 pointer-events-none"
                style={{ left: `calc(92px + (100% - 92px) * ${(currentLapPct / 100).toFixed(4)})` }}
              />
            )}

            <div className="space-y-1 max-h-[420px] overflow-y-auto pr-1">
              {sortedDrivers.map((d) => {
                const isFocused = d.driverNumber === focusedDriverNumber;
                const teamColor = d.info?.teamColour || '#64748B';
                const position = positionMap.get(d.driverNumber);

                return (
                  <button
                    key={d.driverNumber}
                    onClick={() => onSelectDriver?.(d.driverNumber)}
                    className={`w-full flex items-center gap-2 rounded-lg py-1 pr-1 transition-colors text-left ${
                      isFocused ? 'bg-red-950/20' : 'hover:bg-slate-900/60'
                    }`}
                  >
                    {/* Driver label */}
                    <div className="w-[92px] shrink-0 flex items-center gap-1.5 pl-1">
                      <span
                        className="w-1.5 h-5 rounded-sm shrink-0"
                        style={{ backgroundColor: teamColor }}
                      />
                      <div className="min-w-0">
                        <div className="flex items-center gap-1 text-[11px] font-mono font-bold text-white truncate">
                          {position ? <span className="text-slate-500">P{position}</span> : null}
                          {d.info?.nameAcronym || `#${d.driverNumber}`}
                        </div>
                      </div>
                    </div>

                    {/* Stint bar */}
                    <div className="relative flex-1 h-5 bg-slate-900/80 rounded overflow-hidden border border-slate-800/80">
                      {d.stints.map((s) => {
                        if (totalLaps <= 0) return null;
                        // An open stint (no lap_end yet) means it's still
                        // running as of the current replay/live position —
                        // its bar should stop there, not at the race end.
                        const lapEnd = s.lapEnd ?? currentLap ?? totalLaps;
                        const leftPct = ((s.lapStart - 1) / totalLaps) * 100;
                        const widthPct = Math.max(0.5, ((lapEnd - s.lapStart + 1) / totalLaps) * 100);
                        const badge = getTyreBadge(s.compound);
                        return (
                          <div
                            key={s.stintNumber}
                            className="absolute top-0 bottom-0 flex items-center justify-center border-r border-black/40 last:border-r-0"
                            style={{ left: `${leftPct}%`, width: `${widthPct}%`, backgroundColor: badge.hex }}
                            title={`${badge.name} • Laps ${s.lapStart}-${lapEnd}${
                              s.tyreAgeAtStart ? ` (started on ${s.tyreAgeAtStart}-lap tyres)` : ''
                            }`}
                          >
                            {widthPct > 6 && (
                              <span
                                className="text-[9px] font-mono font-black"
                                style={{ color: badge.hex === '#FFFFFF' || badge.hex === '#FFF500' ? '#000' : '#fff' }}
                              >
                                {badge.code}
                              </span>
                            )}
                          </div>
                        );
                      })}

                      {/* Pit stop markers */}
                      {d.pitStops.map((p, idx) => {
                        if (totalLaps <= 0) return null;
                        const leftPct = (p.lap / totalLaps) * 100;
                        return (
                          <div
                            key={idx}
                            className="absolute top-0 bottom-0 w-[2px] bg-white/90 z-[5]"
                            style={{ left: `${leftPct}%` }}
                            title={`Pit stop, lap ${p.lap}${p.duration ? ` (${p.duration}s)` : ''}`}
                          />
                        );
                      })}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Footer legend */}
          <div className="flex items-center gap-3 pt-2 text-[9px] font-mono text-slate-500">
            <div className="flex items-center gap-1">
              <span className="w-[2px] h-3 bg-white/90 inline-block" />
              <span>Pit Stop</span>
            </div>
            {currentLapPct !== null && (
              <div className="flex items-center gap-1">
                <span className="w-px h-3 bg-cyan-400/70 inline-block" />
                <span>Current Lap</span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default TyreStrategyTimeline;
