'use client';

import React, { useEffect, useRef, useState } from 'react';
import { DriverInfo, ComparisonResult, TyreStintSummary, PredictedTyreChange } from '../../types/f1';
import { getTyreBadge } from '../../utils/f1Tyres';
import { formatLapTime, formatDelta, formatPitDuration } from '../../utils/formatLapTime';
import { LapTimeChart } from './LapTimeChart';
import { X, ArrowLeftRight, Gauge, Wrench } from 'lucide-react';

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:4000';

interface DriverComparisonProps {
  isOpen: boolean;
  onClose: () => void;
  sessionKey: number;
  drivers: DriverInfo[];
  defaultDriver1?: number;
  defaultDriver2?: number;
  currentLap?: number;
}

const TyreStintTimeline: React.FC<{ stints: TyreStintSummary[]; totalLaps: number }> = ({ stints, totalLaps }) => {
  if (stints.length === 0) {
    return <div className="text-[11px] font-mono text-slate-500 py-2">No stint data available.</div>;
  }
  const maxLap = Math.max(totalLaps, ...stints.map((s) => s.lapEnd || s.lapStart));

  return (
    <div>
      <div className="flex w-full h-6 rounded-md overflow-hidden border border-slate-800">
        {stints.map((s) => {
          const badge = getTyreBadge(s.compound);
          const end = s.lapEnd || maxLap;
          const widthPct = Math.max(2, ((end - s.lapStart + 1) / maxLap) * 100);
          return (
            <div
              key={s.stintNumber}
              style={{ width: `${widthPct}%`, backgroundColor: `${badge.hex}30`, borderColor: badge.hex }}
              className="border-r last:border-r-0 flex items-center justify-center"
              title={`${badge.name} — Laps ${s.lapStart}-${end}`}
            >
              <span className="text-[9px] font-black font-mono" style={{ color: badge.hex }}>
                {badge.code}
              </span>
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 mt-1.5 text-[10px] font-mono text-slate-400">
        {stints.map((s) => (
          <span key={s.stintNumber}>
            <span style={{ color: getTyreBadge(s.compound).hex }} className="font-bold">
              {getTyreBadge(s.compound).code}
            </span>{' '}
            L{s.lapStart}-{s.lapEnd || '?'}
          </span>
        ))}
      </div>
    </div>
  );
};

const PredictedTyreCard: React.FC<{ prediction: PredictedTyreChange | null; teamColor: string }> = ({ prediction, teamColor }) => {
  if (!prediction) {
    return <div className="text-[11px] font-mono text-slate-500 py-2">No active stint to predict from.</div>;
  }
  const badge = getTyreBadge(prediction.compound);
  const urgency =
    prediction.estimatedLapsRemaining <= 3
      ? 'text-red-400 border-red-500/40 bg-red-950/30'
      : prediction.estimatedLapsRemaining <= 8
      ? 'text-amber-400 border-amber-500/40 bg-amber-950/20'
      : 'text-emerald-400 border-emerald-500/40 bg-emerald-950/20';

  return (
    <div className={`rounded-lg border p-3 ${urgency}`}>
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[10px] font-mono uppercase tracking-wide text-slate-400 flex items-center gap-1">
          <Wrench className="w-3 h-3" /> Predicted Next Stop
        </span>
        <span
          className="text-[9px] font-mono font-bold px-1.5 py-0.5 rounded border"
          style={{ borderColor: badge.hex, color: badge.hex }}
        >
          {badge.name.toUpperCase()} · {prediction.currentAge}L OLD
        </span>
      </div>
      <div className="flex items-baseline gap-1.5">
        <span className="text-2xl font-mono font-black">
          {prediction.estimatedLapsRemaining <= 0 ? 'DUE' : `~${prediction.estimatedLapsRemaining}`}
        </span>
        {prediction.estimatedLapsRemaining > 0 && (
          <span className="text-[10px] font-mono text-slate-400">laps remaining</span>
        )}
      </div>
      <div className="flex items-center justify-between mt-1.5 text-[10px] font-mono text-slate-500">
        <span>
          Degradation:{' '}
          <span className="text-slate-300 font-bold">
            {prediction.degradationSlopeSecPerLap > 0 ? '+' : ''}
            {prediction.degradationSlopeSecPerLap.toFixed(3)}s/lap
          </span>
        </span>
        <span>
          Confidence: <span className="font-bold">{prediction.confidence}</span>
        </span>
      </div>
    </div>
  );
};

/**
 * On-demand 2-driver comparison modal — pick two drivers and click Compare
 * to fetch pace, stint, and predicted-tyre-change data as of the current
 * replay/live lap. Unlike LiveComparisonPanel this doesn't auto-refresh;
 * each click is a fresh snapshot "as of when you clicked".
 */
export const DriverComparison: React.FC<DriverComparisonProps> = ({
  isOpen,
  onClose,
  sessionKey,
  drivers,
  defaultDriver1,
  defaultDriver2,
  currentLap,
}) => {
  const sorted = [...drivers].sort((a, b) => a.driverNumber - b.driverNumber);
  const [driver1, setDriver1] = useState<number>(defaultDriver1 ?? sorted[0]?.driverNumber ?? 0);
  const [driver2, setDriver2] = useState<number>(defaultDriver2 ?? sorted[1]?.driverNumber ?? 0);
  const [result, setResult] = useState<ComparisonResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const initializedRef = useRef(false);

  // The modal is mounted once (hidden) before `drivers` loads over the
  // socket, so the useState initializers above run against an empty list —
  // re-derive sensible defaults the moment the modal actually opens with
  // real driver data, instead of leaving both selects pinned to the same
  // fallback driver forever.
  useEffect(() => {
    if (!isOpen) {
      initializedRef.current = false;
      return;
    }
    if (initializedRef.current || drivers.length === 0) return;

    const sortedNow = [...drivers].sort((a, b) => a.driverNumber - b.driverNumber);
    const d1 =
      defaultDriver1 && sortedNow.some((d) => d.driverNumber === defaultDriver1)
        ? defaultDriver1
        : sortedNow[0].driverNumber;
    const d2 =
      defaultDriver2 && defaultDriver2 !== d1 && sortedNow.some((d) => d.driverNumber === defaultDriver2)
        ? defaultDriver2
        : sortedNow.find((d) => d.driverNumber !== d1)?.driverNumber ?? sortedNow[0].driverNumber;

    setDriver1(d1);
    setDriver2(d2);
    initializedRef.current = true;
  }, [isOpen, drivers, defaultDriver1, defaultDriver2]);

  if (!isOpen) return null;

  const driverMap = new Map(drivers.map((d) => [d.driverNumber, d]));

  const runComparison = async () => {
    if (driver1 === driver2) {
      setError('Please select two different drivers.');
      return;
    }
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const uptoLapParam = currentLap != null ? `&uptoLap=${currentLap}` : '';
      const resp = await fetch(
        `${BACKEND_URL}/api/sessions/${sessionKey}/compare?driver1=${driver1}&driver2=${driver2}${uptoLapParam}`
      );
      const data = await resp.json();
      if (!resp.ok || !data.success) {
        setError(data.error || 'Failed to compare drivers.');
        return;
      }
      setResult(data);
    } catch (err) {
      setError('Network error — could not reach the backend.');
    } finally {
      setLoading(false);
    }
  };

  const d1Info = driverMap.get(driver1);
  const d2Info = driverMap.get(driver2);

  const totalLaps =
    result && result.driver1.lapTimes.length > 0
      ? Math.max(
          result.driver1.lapTimes[result.driver1.lapTimes.length - 1]?.lap || 0,
          result.driver2?.lapTimes[result.driver2.lapTimes.length - 1]?.lap || 0
        )
      : 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="bg-[#0B0E14] border border-slate-700 rounded-2xl max-w-4xl w-full max-h-[90vh] overflow-y-auto p-5 shadow-2xl relative">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Gauge className="w-4 h-4 text-amber-400" />
            <h2 className="text-sm font-black uppercase tracking-wider text-white font-mono">Driver Comparison</h2>
          </div>
          <button onClick={onClose} className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Driver Selectors */}
        <div className="flex flex-wrap items-center gap-3 mb-4">
          <select
            value={driver1}
            onChange={(e) => setDriver1(parseInt(e.target.value, 10))}
            className="bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-white flex-1 min-w-[160px]"
          >
            {sorted.map((d) => (
              <option key={d.driverNumber} value={d.driverNumber}>
                #{d.driverNumber} {d.nameAcronym} — {d.fullName}
              </option>
            ))}
          </select>

          <button
            onClick={() => {
              const tmp = driver1;
              setDriver1(driver2);
              setDriver2(tmp);
            }}
            className="p-2 text-slate-400 hover:text-white bg-slate-900 border border-slate-700 rounded-lg transition-colors"
            title="Swap drivers"
          >
            <ArrowLeftRight className="w-3.5 h-3.5" />
          </button>

          <select
            value={driver2}
            onChange={(e) => setDriver2(parseInt(e.target.value, 10))}
            className="bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-white flex-1 min-w-[160px]"
          >
            {sorted.map((d) => (
              <option key={d.driverNumber} value={d.driverNumber}>
                #{d.driverNumber} {d.nameAcronym} — {d.fullName}
              </option>
            ))}
          </select>

          <button
            onClick={runComparison}
            disabled={loading}
            className="px-4 py-2 bg-f1-red hover:bg-red-700 disabled:opacity-50 text-white rounded-lg text-xs font-bold font-mono transition-colors"
          >
            {loading ? 'Loading...' : 'Compare'}
          </button>
        </div>

        {error && (
          <div className="bg-red-950/40 border border-red-800/60 text-red-300 text-xs font-mono rounded-lg px-3 py-2 mb-4">
            {error}
          </div>
        )}

        {result && (
          <div className="space-y-4">
            {/* Pace Summary */}
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-[#121620] border border-f1-border rounded-xl p-3 text-center">
                <div className="text-[10px] font-mono text-slate-400 uppercase mb-1">Best Lap Δ</div>
                <div className="text-lg font-mono font-black text-white">
                  {formatDelta(result.paceDeltaBest)}
                </div>
                <div className="text-[10px] font-mono text-slate-500 mt-0.5">
                  {result.paceDeltaBest !== null && result.paceDeltaBest !== 0
                    ? `${result.paceDeltaBest < 0 ? d1Info?.nameAcronym : d2Info?.nameAcronym} faster`
                    : 'Even'}
                </div>
              </div>
              <div className="bg-[#121620] border border-f1-border rounded-xl p-3 text-center">
                <div className="text-[10px] font-mono text-slate-400 uppercase mb-1">Avg Lap Δ</div>
                <div className="text-lg font-mono font-black text-white">
                  {formatDelta(result.paceDeltaAvg)}
                </div>
                <div className="text-[10px] font-mono text-slate-500 mt-0.5">
                  {result.paceDeltaAvg !== null && result.paceDeltaAvg !== 0
                    ? `${result.paceDeltaAvg < 0 ? d1Info?.nameAcronym : d2Info?.nameAcronym} faster`
                    : 'Even'}
                </div>
              </div>
            </div>

            {/* Lap Time Chart */}
            <div className="bg-[#0F1218] border border-f1-border rounded-xl p-4">
              <div className="text-[11px] font-mono font-bold text-slate-300 uppercase tracking-wide mb-2">
                Lap Time Comparison
              </div>
              <LapTimeChart
                drivers={[
                  {
                    code: result.driver1.info?.nameAcronym || `#${result.driver1.driverNumber}`,
                    teamColor: result.driver1.info?.teamColour || '#FFFFFF',
                    lapTimes: result.driver1.lapTimes,
                    pitStops: result.driver1.pitStops,
                  },
                  {
                    code: result.driver2?.info?.nameAcronym || `#${result.driver2?.driverNumber || '2'}`,
                    teamColor: result.driver2?.info?.teamColour || '#94A3B8',
                    lapTimes: result.driver2?.lapTimes || [],
                    pitStops: result.driver2?.pitStops || [],
                  },
                ]}
              />
            </div>

            {/* Per-driver Tyre & Prediction panels */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {[result.driver1, result.driver2].filter((d): d is NonNullable<typeof d> => d != null).map((d) => {
                const info = d.info;
                return (
                  <div key={d.driverNumber} className="bg-[#0F1218] border border-f1-border rounded-xl p-3.5">
                    <div className="flex items-center gap-2 mb-2.5 pb-2 border-b border-slate-800">
                      <div className="w-1.5 h-5 rounded-full" style={{ backgroundColor: info?.teamColour || '#FFFFFF' }} />
                      <span className="text-xs font-black font-mono text-white">{info?.nameAcronym || `#${d.driverNumber}`}</span>
                      <span className="text-[10px] font-mono text-slate-500">{info?.teamName}</span>
                    </div>

                    <div className="flex items-center justify-between text-[11px] font-mono mb-3">
                      <span className="text-slate-400">
                        Best: <span className="text-white font-bold">{formatLapTime(d.bestLap?.time)}</span>
                        {d.bestLap && <span className="text-slate-600"> (L{d.bestLap.lap})</span>}
                      </span>
                      <span className="text-slate-400">
                        Avg: <span className="text-white font-bold">{formatLapTime(d.avgLap)}</span>
                      </span>
                    </div>

                    <div className="mb-3">
                      <div className="text-[10px] font-mono uppercase text-slate-500 mb-1">Tyre Stint History</div>
                      <TyreStintTimeline stints={d.stints} totalLaps={totalLaps} />
                    </div>

                    <PredictedTyreCard prediction={d.predictedTyreChange} teamColor={info?.teamColour || '#FFFFFF'} />

                    {d.pitStops.length > 0 && (
                      <div className="mt-2.5 text-[10px] font-mono text-slate-400">
                        <span className="text-slate-500 uppercase">Pit Stops: </span>
                        {d.pitStops.map((p, i) => (
                          <span key={i}>
                            L{p.lap} ({formatPitDuration(p.duration)})
                            {i < d.pitStops.length - 1 ? ', ' : ''}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {!result && !loading && !error && (
          <div className="text-center py-10 text-slate-500 text-xs font-mono">
            Select two drivers and press Compare to see pace, tyre strategy, and predicted pit windows.
          </div>
        )}
      </div>
    </div>
  );
};

export default DriverComparison;
