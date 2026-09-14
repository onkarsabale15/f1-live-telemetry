'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { DriverInfo, DriverLiveState, ComparisonResult, DriverComparisonSummary } from '../../types/f1';
import { getTyreBadge } from '../../utils/f1Tyres';
import { formatLapTime } from '../../utils/formatLapTime';
import { getOvertakeAidLabels } from '../../utils/overtakeAid';
import { Users, Plus, X, Gauge, Wrench, Activity, ChevronDown, Trophy, Shield } from 'lucide-react';
import { LapTimeChart } from './LapTimeChart';

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:4000';

interface LiveComparisonPanelProps {
  sessionKey: number;
  drivers: DriverInfo[];
  grid: DriverLiveState[];
  focusedDriverNumber: number;
  currentLap?: number;
  hasDrs?: boolean;
  onSelectDriver: (driverNumber: number) => void;
}

export const LiveComparisonPanel: React.FC<LiveComparisonPanelProps> = ({
  sessionKey,
  drivers,
  grid,
  focusedDriverNumber,
  currentLap,
  hasDrs = true,
  onSelectDriver,
}) => {
  const aid = getOvertakeAidLabels(hasDrs);
  // Store up to 3 selected driver numbers
  const [selectedDrivers, setSelectedDrivers] = useState<number[]>([]);
  const [comparisonData, setComparisonData] = useState<ComparisonResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);

  // Initialize selected drivers once drivers are loaded
  useEffect(() => {
    if (drivers.length > 0 && selectedDrivers.length === 0) {
      // Pick top 2 or 3 drivers from live grid or default roster
      const sortedGrid = [...grid].sort((a, b) => a.position - b.position);
      if (sortedGrid.length >= 2) {
        const initial = sortedGrid.slice(0, 2).map((g) => g.driverNumber);
        if (focusedDriverNumber && !initial.includes(focusedDriverNumber) && initial.length < 3) {
          initial.push(focusedDriverNumber);
        }
        setSelectedDrivers(initial.slice(0, 3));
      } else {
        const topNums = drivers.slice(0, Math.min(3, drivers.length)).map((d) => d.driverNumber);
        setSelectedDrivers(topNums);
      }
    }
  }, [drivers, grid, focusedDriverNumber]);

  // Fetch comparison analytics whenever sessionKey, selectedDrivers, or the
  // current replay/live lap changes — keying on currentLap makes pace,
  // stints, and predicted tyre change fill in progressively during replay
  // instead of always reflecting the session's final, fully-raced state.
  useEffect(() => {
    if (!sessionKey || selectedDrivers.length === 0) return;
    let cancelled = false;

    const fetchComparison = async () => {
      setLoading(true);
      try {
        const query = selectedDrivers.join(',');
        const uptoLapParam = currentLap != null ? `&uptoLap=${currentLap}` : '';
        const res = await fetch(`${BACKEND_URL}/api/sessions/${sessionKey}/compare?drivers=${query}${uptoLapParam}`);
        if (!res.ok) throw new Error('Failed to load comparison data');
        const json = await res.json();
        if (!cancelled && json.success) {
          setComparisonData(json);
        }
      } catch {
        if (!cancelled) setComparisonData(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    fetchComparison();
    return () => {
      cancelled = true;
    };
  }, [sessionKey, selectedDrivers, currentLap]);

  // Fast lookups
  const driverInfoMap = useMemo(() => {
    return new Map(drivers.map((d) => [d.driverNumber, d]));
  }, [drivers]);

  const liveStateMap = useMemo(() => {
    return new Map(grid.map((g) => [g.driverNumber, g]));
  }, [grid]);

  const comparisonMap = useMemo(() => {
    const map = new Map<number, DriverComparisonSummary>();
    if (comparisonData?.drivers) {
      comparisonData.drivers.forEach((d) => map.set(d.driverNumber, d));
    }
    return map;
  }, [comparisonData]);

  // Drivers available to be added
  const availableToAdd = useMemo(() => {
    return drivers.filter((d) => !selectedDrivers.includes(d.driverNumber));
  }, [drivers, selectedDrivers]);

  // Actions
  const handleAddDriver = (num: number) => {
    if (selectedDrivers.length >= 3 || selectedDrivers.includes(num)) return;
    setSelectedDrivers([...selectedDrivers, num]);
    setIsDropdownOpen(false);
  };

  const handleRemoveDriver = (num: number) => {
    if (selectedDrivers.length <= 1) return; // Keep at least 1 driver
    setSelectedDrivers(selectedDrivers.filter((n) => n !== num));
  };

  const handlePresetTop3 = () => {
    const sorted = [...grid].sort((a, b) => a.position - b.position);
    if (sorted.length >= 1) {
      setSelectedDrivers(sorted.slice(0, 3).map((g) => g.driverNumber));
    }
  };

  const handlePresetTeammates = () => {
    const current = driverInfoMap.get(focusedDriverNumber);
    if (!current) return;
    const mates = drivers.filter((d) => d.teamName.toLowerCase() === current.teamName.toLowerCase());
    if (mates.length > 0) {
      setSelectedDrivers(mates.slice(0, 3).map((m) => m.driverNumber));
    }
  };

  // Find fastest bestLap among the selected drivers
  const fastestBestLap = useMemo(() => {
    let fastest: { driverNumber: number; time: number } | null = null;
    selectedDrivers.forEach((num) => {
      const summary = comparisonMap.get(num);
      if (summary?.bestLap?.time) {
        if (!fastest || summary.bestLap.time < fastest.time) {
          fastest = { driverNumber: num, time: summary.bestLap.time };
        }
      }
    });
    return fastest;
  }, [selectedDrivers, comparisonMap]);

  return (
    <div className="bg-[#0B0E14] border border-f1-border rounded-xl p-4 shadow-xl space-y-3.5">
      {/* Top Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800/80 pb-3">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 bg-red-950/80 border border-red-800/70 rounded-lg flex items-center justify-center text-red-400 shadow">
            <Users className="w-4 h-4" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-xs font-black font-mono tracking-wider uppercase text-white">
                Live Driver Comparison
              </h3>
              <span className="text-[9px] font-mono font-bold bg-slate-800 text-slate-300 border border-slate-700 px-1.5 py-0.5 rounded">
                MAX 3
              </span>
            </div>
            <p className="text-[10px] font-mono text-slate-500">
              Side-by-side telemetry, tyre degradation & pit windows
            </p>
          </div>
        </div>

        {/* Selected Driver Pills & Dropdown */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Presets */}
          <div className="flex items-center gap-1 bg-slate-900 border border-slate-800 p-0.5 rounded-lg text-[10px] font-mono">
            <button
              onClick={handlePresetTop3}
              className="flex items-center gap-1 px-2 py-1 text-slate-400 hover:text-white hover:bg-slate-800 rounded transition-colors"
              title="Compare Top 3 in Race"
            >
              <Trophy className="w-3 h-3 text-amber-400" /> Top 3
            </button>
            <button
              onClick={handlePresetTeammates}
              className="flex items-center gap-1 px-2 py-1 text-slate-400 hover:text-white hover:bg-slate-800 rounded transition-colors"
              title="Compare Teammates"
            >
              <Shield className="w-3 h-3 text-cyan-400" /> Teammates
            </button>
          </div>

          {/* Add Driver Dropdown */}
          {selectedDrivers.length < 3 && (
            <div className="relative">
              <button
                onClick={() => setIsDropdownOpen(!isDropdownOpen)}
                className="flex items-center gap-1.5 px-2.5 py-1.5 bg-red-950/40 hover:bg-red-900/50 border border-red-800/60 text-red-300 rounded-lg text-xs font-mono font-bold transition-colors"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Add Driver</span>
                <ChevronDown className="w-3 h-3 text-red-400" />
              </button>

              {isDropdownOpen && (
                <div className="absolute right-0 mt-1.5 w-64 max-h-72 overflow-y-auto bg-[#0F1218] border border-slate-700 rounded-xl shadow-2xl z-30 p-1 divide-y divide-slate-800/60">
                  <div className="px-3 py-1.5 text-[10px] font-mono text-slate-400 uppercase">
                    Select Driver to Compare
                  </div>
                  <div className="py-1">
                    {availableToAdd.map((d) => {
                      const live = liveStateMap.get(d.driverNumber);
                      return (
                        <button
                          key={d.driverNumber}
                          onClick={() => handleAddDriver(d.driverNumber)}
                          className="w-full flex items-center justify-between px-3 py-1.5 text-xs font-mono hover:bg-slate-800/80 rounded-lg transition-colors text-left"
                        >
                          <div className="flex items-center gap-2">
                            <span
                              className="w-2.5 h-2.5 rounded-full"
                              style={{ backgroundColor: d.teamColour }}
                            />
                            <span className="font-bold text-white">#{d.driverNumber} {d.nameAcronym}</span>
                            <span className="text-slate-400 text-[11px] truncate max-w-[100px]">{d.fullName}</span>
                          </div>
                          {live && (
                            <span className="text-[10px] bg-slate-900 px-1.5 py-0.5 rounded text-slate-300 font-bold">
                              P{live.position}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* 3-Column Comparison Grid */}
      <div className={`grid grid-cols-1 ${selectedDrivers.length === 2 ? 'md:grid-cols-2' : 'md:grid-cols-3'} gap-3`}>
        {selectedDrivers.map((driverNumber) => {
          const info = driverInfoMap.get(driverNumber);
          const live = liveStateMap.get(driverNumber);
          const summary = comparisonMap.get(driverNumber);
          const isFocused = driverNumber === focusedDriverNumber;
          const isFastest = Boolean(fastestBestLap && (fastestBestLap as { driverNumber: number }).driverNumber === driverNumber);
          const tyreAge = live?.tyreAge ?? summary?.predictedTyreChange?.currentAge ?? null;
          const tyreBadge = getTyreBadge(live?.compound || summary?.stints?.[summary.stints.length - 1]?.compound || 'UNKNOWN');
          const teamColor = info?.teamColour || '#E10600';

          return (
            <div
              key={driverNumber}
              className={`bg-[#0F1218] border rounded-xl p-3.5 transition-all relative flex flex-col justify-between ${
                isFocused ? 'border-red-600/80 shadow-lg shadow-red-950/20' : 'border-slate-800/80 hover:border-slate-700'
              }`}
              style={{ borderTop: `4px solid ${teamColor}` }}
            >
              {/* Card Header */}
              <div>
                <div className="flex items-start justify-between gap-2 mb-2.5">
                  <div className="flex items-center gap-2">
                    <span
                      className="w-6 h-6 rounded-md flex items-center justify-center font-mono font-black text-xs text-white shadow"
                      style={{ backgroundColor: teamColor }}
                    >
                      {live ? `P${live.position}` : '-'}
                    </span>
                    <div>
                      <div className="flex items-center gap-1.5">
                        <span className="text-base font-black font-mono text-white">
                          {info?.nameAcronym || `#${driverNumber}`}
                        </span>
                        <span className="text-xs font-mono text-slate-400">#{driverNumber}</span>
                        {isFocused && (
                          <span className="text-[9px] font-mono bg-red-950 text-red-400 border border-red-800/70 px-1 rounded font-bold">
                            FOCUS
                          </span>
                        )}
                      </div>
                      <p className="text-[10px] font-mono text-slate-400 truncate max-w-[140px]">
                        {info?.teamName || 'Formula 1 Team'}
                      </p>
                    </div>
                  </div>

                  {/* Actions: Focus & Remove */}
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => onSelectDriver(driverNumber)}
                      className="p-1 text-slate-500 hover:text-white hover:bg-slate-800 rounded transition-colors"
                      title="Focus Cockpit Gauges on Driver"
                    >
                      <Gauge className="w-3.5 h-3.5" />
                    </button>
                    {selectedDrivers.length > 1 && (
                      <button
                        onClick={() => handleRemoveDriver(driverNumber)}
                        className="p-1 text-slate-500 hover:text-red-400 hover:bg-slate-800 rounded transition-colors"
                        title="Remove from Comparison"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </div>

                {/* Live Speed & DRS/Override Bar */}
                <div className="bg-slate-900/90 border border-slate-800 rounded-lg p-2.5 mb-2.5">
                  <div className="flex items-baseline justify-between mb-1">
                    <span className="text-[10px] font-mono uppercase text-slate-400">Live Speed</span>
                    <div className="flex items-center gap-1.5">
                      {live?.drs ? (
                        <span className="text-[9px] font-mono font-black bg-emerald-950 text-emerald-300 border border-emerald-700/80 px-1 rounded animate-pulse">
                          {aid.activeBadge}
                        </span>
                      ) : (
                        <span className="text-[9px] font-mono text-slate-500">{aid.short} {aid.statusOff}</span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-baseline justify-between">
                    <div className="flex items-baseline gap-1">
                      <span className="text-2xl font-black font-mono text-white">
                        {live?.speed != null ? Math.round(live.speed) : '--'}
                      </span>
                      <span className="text-xs font-mono text-slate-400">km/h</span>
                    </div>
                    <div className="text-right">
                      <span className="text-[10px] font-mono text-slate-400">Gear / RPM</span>
                      <p className="text-xs font-mono font-bold text-slate-200">
                        G{live?.gear ?? '-'}{' '}
                        <span className="text-slate-500 font-normal">
                          {live?.rpm ? `${(live.rpm / 1000).toFixed(1)}k` : ''}
                        </span>
                      </p>
                    </div>
                  </div>

                  {/* Throttle / Brake Dual Bars */}
                  <div className="mt-2 space-y-1">
                    <div className="flex items-center gap-1.5 text-[9px] font-mono">
                      <span className="w-7 text-emerald-400 font-bold">THR</span>
                      <div className="flex-1 h-1.5 bg-slate-800 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-emerald-500 transition-all duration-150"
                          style={{ width: `${live?.throttle || 0}%` }}
                        />
                      </div>
                      <span className="w-7 text-right text-slate-400">{Math.round(live?.throttle || 0)}%</span>
                    </div>
                    <div className="flex items-center gap-1.5 text-[9px] font-mono">
                      <span className="w-7 text-rose-400 font-bold">BRK</span>
                      <div className="flex-1 h-1.5 bg-slate-800 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-rose-500 transition-all duration-150"
                          style={{ width: `${live?.brake || 0}%` }}
                        />
                      </div>
                      <span className="w-7 text-right text-slate-400">{Math.round(live?.brake || 0)}%</span>
                    </div>
                  </div>
                </div>

                {/* Timing & Intervals */}
                <div className="grid grid-cols-2 gap-2 mb-2.5">
                  <div className="bg-slate-900/60 border border-slate-800/80 rounded-lg p-2">
                    <span className="text-[9px] font-mono text-slate-500 uppercase block">Interval Ahead</span>
                    <span className="text-xs font-mono font-bold text-slate-200">
                      {live ? (live.position === 1 ? 'LEADER' : `+${live.intervalToAhead.toFixed(3)}s`) : '--'}
                    </span>
                  </div>
                  <div className="bg-slate-900/60 border border-slate-800/80 rounded-lg p-2">
                    <span className="text-[9px] font-mono text-slate-500 uppercase block">Gap to P1</span>
                    <span className="text-xs font-mono font-bold text-slate-200">
                      {live ? (live.position === 1 ? '--' : `+${live.gapToLeader.toFixed(3)}s`) : '--'}
                    </span>
                  </div>
                </div>

                {/* Tyre Stint & Predicted Stop */}
                <div className="bg-slate-900/60 border border-slate-800/80 rounded-lg p-2.5 mb-2.5 space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-mono text-slate-400 flex items-center gap-1">
                      <Activity className="w-3 h-3 text-slate-500" /> Current Tyre
                    </span>
                    <div className="flex items-center gap-1.5">
                      <span
                        className="text-[9px] font-black font-mono px-1.5 py-0.5 rounded border"
                        style={{ borderColor: tyreBadge.hex, color: tyreBadge.hex }}
                      >
                        {tyreBadge.code}
                      </span>
                      <span className="text-[11px] font-mono font-bold text-slate-300">
                        {tyreAge !== null ? `${tyreAge} Laps Old` : 'No Data'}
                      </span>
                    </div>
                  </div>

                  {summary?.predictedTyreChange && (
                    <div className="flex items-center justify-between pt-1 border-t border-slate-800 text-[10px] font-mono">
                      <span className="text-slate-500 flex items-center gap-1">
                        <Wrench className="w-3 h-3" /> Next Stop
                      </span>
                      <span
                        className={`font-bold ${
                          summary.predictedTyreChange.estimatedLapsRemaining <= 3
                            ? 'text-red-400'
                            : summary.predictedTyreChange.estimatedLapsRemaining <= 8
                            ? 'text-amber-400'
                            : 'text-emerald-400'
                        }`}
                      >
                        {summary.predictedTyreChange.estimatedLapsRemaining <= 0
                          ? 'DUE NOW'
                          : `~${summary.predictedTyreChange.estimatedLapsRemaining} Laps left`}
                      </span>
                    </div>
                  )}
                </div>
              </div>

              {/* Best Lap & Pace Analytics Footer */}
              <div className="pt-2 border-t border-slate-800/80 flex items-center justify-between text-[11px] font-mono">
                <div className="flex items-center gap-1">
                  <span className="text-slate-500">Best:</span>
                  <span className={`font-bold ${isFastest ? 'text-purple-400' : 'text-slate-200'}`}>
                    {summary?.bestLap ? formatLapTime(summary.bestLap.time) : '--:--.---'}
                  </span>
                  {isFastest && <span title="Fastest in Comparison">⚡</span>}
                </div>
                {summary?.avgLap != null && (
                  <div className="text-slate-400 text-[10px]">
                    Avg: <span className="font-semibold text-slate-300">{formatLapTime(summary.avgLap)}</span>
                  </div>
                )}
              </div>
            </div>
          );
        })}

        {/* Empty Slot Placeholder if fewer than 3 drivers */}
        {selectedDrivers.length < 3 && (
          <button
            onClick={() => setIsDropdownOpen(true)}
            className="border-2 border-dashed border-slate-800 hover:border-slate-700 hover:bg-slate-900/30 rounded-xl p-6 flex flex-col items-center justify-center text-center gap-2 transition-all min-h-[260px] group"
          >
            <div className="w-10 h-10 rounded-full bg-slate-900 border border-slate-800 flex items-center justify-center text-slate-500 group-hover:text-red-400 group-hover:border-red-900/60 transition-colors">
              <Plus className="w-5 h-5" />
            </div>
            <div>
              <p className="text-xs font-mono font-bold text-slate-400 group-hover:text-slate-200 transition-colors">
                Add 3rd Driver
              </p>
              <p className="text-[10px] font-mono text-slate-600 mt-0.5">
                Compare up to 3 cars head-to-head
              </p>
            </div>
          </button>
        )}
      </div>

      {/* Lap Time Comparison */}
      {selectedDrivers.length >= 2 && (
        <div className="pt-3.5 border-t border-slate-800/80">
          <div className="text-[11px] font-mono font-bold text-slate-300 uppercase tracking-wide mb-2">
            Lap Time Comparison
          </div>
          {loading && !comparisonData ? (
            <div className="text-center py-8 text-slate-500 text-xs font-mono">Loading lap times...</div>
          ) : (
            <LapTimeChart
              drivers={selectedDrivers.map((num) => {
                const info = driverInfoMap.get(num);
                const summary = comparisonMap.get(num);
                return {
                  code: info?.nameAcronym || `#${num}`,
                  teamColor: info?.teamColour || '#FFFFFF',
                  lapTimes: summary?.lapTimes || [],
                  pitStops: summary?.pitStops || [],
                };
              })}
            />
          )}
        </div>
      )}
    </div>
  );
};

export default LiveComparisonPanel;
