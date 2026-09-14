'use client';

import React from 'react';
import { DriverLiveState, DriverInfo } from '../../types/f1';
import { getTyreBadge } from '../../utils/f1Tyres';
import { Radio } from 'lucide-react';

interface LiveLeaderboardProps {
  grid: DriverLiveState[];
  drivers: DriverInfo[];
  hasGapData: boolean;
  focusedDriverNumber: number;
  onSelectDriver: (driverNumber: number) => void;
}

export const LiveLeaderboard: React.FC<LiveLeaderboardProps> = ({
  grid,
  drivers,
  hasGapData,
  focusedDriverNumber,
  onSelectDriver,
}) => {
  const driversMap = new Map<number, DriverInfo>();
  drivers.forEach((d) => driversMap.set(d.driverNumber, d));

  const sortedGrid = [...grid].sort((a, b) => a.position - b.position);

  return (
    <div className="bg-[#0F1218] rounded-xl border border-f1-border p-4 flex flex-col shadow-2xl">
      <div className="flex items-center justify-between border-b border-slate-800 pb-3 mb-3">
        <span className="text-xs font-bold uppercase tracking-wider text-slate-200">
          Live Race Standings
        </span>
        <span className="text-[11px] font-mono text-slate-400">
          {sortedGrid.length} Cars on Track
        </span>
      </div>

      {sortedGrid.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-10 text-center text-slate-500 text-xs font-mono gap-2">
          <Radio className="w-6 h-6 text-slate-700" />
          Awaiting live feed from OpenF1.
          <span className="text-slate-600">No fabricated data is shown while real telemetry is unavailable.</span>
        </div>
      ) : (
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs font-mono">
          <thead>
            <tr className="text-slate-500 border-b border-slate-800/80 text-[10px] uppercase">
              <th className="py-2 pl-2">Pos</th>
              <th className="py-2">Driver</th>
              <th className="py-2">Interval</th>
              <th className="py-2">Gap to P1</th>
              <th className="py-2">Speed</th>
              <th className="py-2 text-right pr-2">Tyre</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/40">
            {sortedGrid.map((car) => {
              const driver = driversMap.get(car.driverNumber);
              const isFocused = car.driverNumber === focusedDriverNumber;
              const tyreBadge = getTyreBadge(car.compound);

              return (
                <tr
                  key={car.driverNumber}
                  onClick={() => onSelectDriver(car.driverNumber)}
                  className={`hover:bg-slate-800/40 cursor-pointer transition-colors ${
                    isFocused ? 'bg-slate-800/80 font-bold' : ''
                  }`}
                >
                  {/* Position */}
                  <td className="py-2 pl-2">
                    <span
                      className={`inline-block w-5 text-center font-bold ${
                        car.position === 1
                          ? 'text-amber-400'
                          : car.position === 2
                          ? 'text-slate-300'
                          : car.position === 3
                          ? 'text-amber-600'
                          : 'text-slate-400'
                      }`}
                    >
                      {car.position}
                    </span>
                  </td>

                  {/* Driver & Team Stripe */}
                  <td className="py-2">
                    <div className="flex items-center gap-2">
                      <div
                        className="w-1 h-3.5 rounded-full"
                        style={{ backgroundColor: driver?.teamColour || '#FFFFFF' }}
                      />
                      <span className={isFocused ? 'text-amber-400 font-black' : 'text-white'}>
                        {driver?.nameAcronym || `#${car.driverNumber}`}
                      </span>
                      <span className="text-[10px] text-slate-500 hidden sm:inline truncate max-w-[90px]">
                        {driver?.fullName?.split(' ')[1] || ''}
                      </span>
                    </div>
                  </td>

                  {/* Interval */}
                  <td className="py-2 text-slate-300">
                    {!hasGapData ? '—' : car.position === 1 ? 'LEADER' : `+${car.intervalToAhead.toFixed(3)}s`}
                  </td>

                  {/* Gap to Leader */}
                  <td className="py-2 text-slate-400">
                    {!hasGapData ? '—' : car.position === 1 ? '-' : `+${car.gapToLeader.toFixed(3)}s`}
                  </td>

                  {/* Speed */}
                  <td className="py-2 text-slate-200">
                    {car.speed} <span className="text-[9px] text-slate-500">km/h</span>
                  </td>

                  {/* Tyre */}
                  <td className="py-2 text-right pr-2">
                    <div className="flex items-center justify-end gap-1.5">
                      <span
                        className="w-4 h-4 rounded-full border flex items-center justify-center text-[9px] font-black"
                        style={{
                          borderColor: tyreBadge.hex,
                          color: tyreBadge.hex,
                          backgroundColor: `${tyreBadge.hex}25`,
                        }}
                      >
                        {tyreBadge.code}
                      </span>
                      <span className="text-[10px] text-slate-400">
                        {car.tyreAge}L
                      </span>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      )}
    </div>
  );
};

export default LiveLeaderboard;
