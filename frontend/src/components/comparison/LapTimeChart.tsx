'use client';

import React, { useMemo, useRef, useState } from 'react';
import { LapTimeEntry, PitStopSummary } from '../../types/f1';
import { formatLapTime, formatDelta } from '../../utils/formatLapTime';

interface DriverSeries {
  code: string;
  teamColor: string;
  lapTimes: LapTimeEntry[];
  pitStops: PitStopSummary[];
}

interface LapTimeChartProps {
  drivers: DriverSeries[]; // 2-3 drivers
}

const VIEW_W = 800;
const VIEW_H = 320;
const PAD = { top: 16, right: 16, bottom: 32, left: 56 };
const PLOT_W = VIEW_W - PAD.left - PAD.right;
const PLOT_H = VIEW_H - PAD.top - PAD.bottom;

// Cycled onto repeated occurrences of the same team color (teammates) so
// overlapping lines stay distinguishable without needing a second hue.
const DASH_PATTERNS = [undefined, '6,4', '2,3'];
const PIT_DASH_PATTERNS = ['3,3', '1,3', '4,2'];

/** SVG lap-time line chart for 2-3 drivers, with pit-stop markers and a hover tooltip comparing lap times across drivers. */
export const LapTimeChart: React.FC<LapTimeChartProps> = ({ drivers }) => {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hoverLap, setHoverLap] = useState<number | null>(null);

  // Assign each driver a dash pattern based on how many earlier drivers in
  // the list already share their exact team color (teammates).
  const dashByIndex = useMemo(() => {
    const seenCounts = new Map<string, number>();
    return drivers.map((d) => {
      const key = d.teamColor.toLowerCase();
      const occurrence = seenCounts.get(key) || 0;
      seenCounts.set(key, occurrence + 1);
      return DASH_PATTERNS[occurrence] ?? DASH_PATTERNS[DASH_PATTERNS.length - 1];
    });
  }, [drivers]);

  const { minLap, maxLap, minTime, maxTime } = useMemo(() => {
    const allLaps = drivers.flatMap((d) => d.lapTimes);
    if (allLaps.length === 0) {
      return { minLap: 1, maxLap: 1, minTime: 0, maxTime: 1 };
    }
    const laps = allLaps.map((l) => l.lap);
    const times = allLaps.map((l) => l.time);
    const rawMin = Math.min(...times);
    const rawMax = Math.max(...times);
    const pad = Math.max(0.5, (rawMax - rawMin) * 0.08);
    return {
      minLap: Math.min(...laps),
      maxLap: Math.max(...laps),
      minTime: rawMin - pad,
      maxTime: rawMax + pad,
    };
  }, [drivers]);

  const xScale = (lap: number) => {
    if (maxLap === minLap) return PAD.left + PLOT_W / 2;
    return PAD.left + ((lap - minLap) / (maxLap - minLap)) * PLOT_W;
  };
  const yScale = (time: number) => {
    if (maxTime === minTime) return PAD.top + PLOT_H / 2;
    return PAD.top + PLOT_H - ((time - minTime) / (maxTime - minTime)) * PLOT_H;
  };

  const buildPath = (series: LapTimeEntry[]) => {
    if (series.length === 0) return '';
    const sorted = [...series].sort((a, b) => a.lap - b.lap);
    return sorted.map((l, i) => `${i === 0 ? 'M' : 'L'} ${xScale(l.lap).toFixed(1)} ${yScale(l.time).toFixed(1)}`).join(' ');
  };

  const paths = useMemo(() => drivers.map((d) => buildPath(d.lapTimes)), [drivers, minLap, maxLap, minTime, maxTime]);

  // Y-axis gridlines (5 bands)
  const gridLines = useMemo(() => {
    const lines: { y: number; value: number }[] = [];
    const steps = 5;
    for (let i = 0; i <= steps; i++) {
      const value = minTime + ((maxTime - minTime) * i) / steps;
      lines.push({ y: yScale(value), value });
    }
    return lines;
  }, [minTime, maxTime]);

  // X-axis ticks
  const xTicks = useMemo(() => {
    const totalLaps = maxLap - minLap;
    const tickCount = Math.min(10, Math.max(2, totalLaps));
    const step = Math.max(1, Math.round(totalLaps / tickCount));
    const ticks: number[] = [];
    for (let lap = minLap; lap <= maxLap; lap += step) ticks.push(lap);
    if (ticks[ticks.length - 1] !== maxLap) ticks.push(maxLap);
    return ticks;
  }, [minLap, maxLap]);

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const scaleX = VIEW_W / rect.width;
    const mouseX = (e.clientX - rect.left) * scaleX;
    if (mouseX < PAD.left || mouseX > VIEW_W - PAD.right) {
      setHoverLap(null);
      return;
    }
    const ratio = (mouseX - PAD.left) / PLOT_W;
    const lap = Math.round(minLap + ratio * (maxLap - minLap));
    setHoverLap(Math.max(minLap, Math.min(maxLap, lap)));
  };

  const atHover = drivers.map((d) => (hoverLap !== null ? d.lapTimes.find((l) => l.lap === hoverLap) : null));
  // A two-way delta reads naturally (who's faster, by how much); with three
  // drivers "delta from whom" gets ambiguous, so it's shown only for a
  // straight head-to-head.
  const hoverDelta = drivers.length === 2 && atHover[0] && atHover[1] ? atHover[0]!.time - atHover[1]!.time : null;

  const pitSetsByDriver = drivers.map((d) => new Set(d.pitStops.map((p) => p.lap)));
  const anyPitStops = pitSetsByDriver.some((s) => s.size > 0);

  return (
    <div className="w-full">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        className="w-full h-auto touch-none select-none"
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setHoverLap(null)}
      >
        {/* Gridlines */}
        {gridLines.map((g, i) => (
          <g key={i}>
            <line x1={PAD.left} x2={VIEW_W - PAD.right} y1={g.y} y2={g.y} stroke="#1E2635" strokeWidth={1} />
            <text x={PAD.left - 8} y={g.y + 3} textAnchor="end" fontSize="9" fill="#64748B" fontFamily="monospace">
              {formatLapTime(g.value)}
            </text>
          </g>
        ))}

        {/* X-axis ticks */}
        {xTicks.map((lap) => (
          <text key={lap} x={xScale(lap)} y={VIEW_H - PAD.bottom + 18} textAnchor="middle" fontSize="9" fill="#64748B" fontFamily="monospace">
            L{lap}
          </text>
        ))}
        <text x={PAD.left + PLOT_W / 2} y={VIEW_H - 4} textAnchor="middle" fontSize="9" fill="#475569" fontFamily="monospace">
          LAP NUMBER
        </text>

        {/* Pit stop markers, one dash style per driver */}
        {drivers.map((d, di) =>
          d.pitStops.map((p) => (
            <line
              key={`pit-${di}-${p.lap}`}
              x1={xScale(p.lap)}
              x2={xScale(p.lap)}
              y1={PAD.top}
              y2={VIEW_H - PAD.bottom}
              stroke={d.teamColor}
              strokeWidth={1}
              strokeDasharray={PIT_DASH_PATTERNS[di % PIT_DASH_PATTERNS.length]}
              opacity={0.35}
            />
          ))
        )}

        {/* Crosshair */}
        {hoverLap !== null && (
          <line x1={xScale(hoverLap)} x2={xScale(hoverLap)} y1={PAD.top} y2={VIEW_H - PAD.bottom} stroke="#475569" strokeWidth={1} />
        )}

        {/* Driver lines */}
        {drivers.map((d, di) => (
          <path
            key={di}
            d={paths[di]}
            fill="none"
            stroke={d.teamColor}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeDasharray={dashByIndex[di]}
          />
        ))}

        {/* Hover point markers */}
        {drivers.map((d, di) => {
          const pt = atHover[di];
          if (!pt) return null;
          return (
            <circle key={di} cx={xScale(pt.lap)} cy={yScale(pt.time)} r={4} fill={d.teamColor} stroke="#07090E" strokeWidth={1.5} />
          );
        })}
      </svg>

      {/* Legend */}
      <div className="flex items-center justify-center gap-6 mt-1 text-[11px] font-mono flex-wrap">
        {drivers.map((d, di) => (
          <div key={di} className="flex items-center gap-1.5">
            <span
              className="inline-block w-4 h-0.5 rounded-full"
              style={{
                backgroundColor: d.teamColor,
                backgroundImage: dashByIndex[di] ? 'repeating-linear-gradient(90deg, currentColor 0 4px, transparent 4px 7px)' : undefined,
              }}
            />
            <span className="text-slate-300 font-bold">{d.code}</span>
          </div>
        ))}
        {anyPitStops && <span className="text-slate-500">┊ dashed vertical = pit stop</span>}
      </div>

      {/* Tooltip / readout row */}
      <div className="mt-2 bg-slate-950/70 border border-slate-800 rounded-lg px-3 py-2 text-[11px] font-mono flex items-center justify-between gap-2 min-h-[34px] flex-wrap">
        {hoverLap !== null ? (
          <>
            <span className="text-slate-400">
              Lap <span className="text-white font-bold">{hoverLap}</span>
            </span>
            {drivers.map((d, di) => (
              <span key={di} style={{ color: d.teamColor }}>
                {d.code} {formatLapTime(atHover[di]?.time)}
                {pitSetsByDriver[di].has(hoverLap) && <span className="text-amber-400 ml-1">PIT</span>}
              </span>
            ))}
            {hoverDelta !== null && (
              <span className={hoverDelta < 0 ? 'text-emerald-400' : hoverDelta > 0 ? 'text-red-400' : 'text-slate-400'}>
                Δ {formatDelta(hoverDelta)}
              </span>
            )}
          </>
        ) : (
          <span className="text-slate-500 w-full text-center">Hover the chart to compare lap-by-lap times</span>
        )}
      </div>
    </div>
  );
};

export default LapTimeChart;
