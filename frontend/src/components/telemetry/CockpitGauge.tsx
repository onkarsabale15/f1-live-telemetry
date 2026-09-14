'use client';

import React from 'react';
import { DriverLiveState, DriverInfo } from '../../types/f1';

interface CockpitGaugeProps {
  telemetry: DriverLiveState | null;
  driver: DriverInfo | undefined;
}

/** Speed/gear/RPM readout for the focused driver, with an authentic 15-LED shift-light bar calibrated to the 1.6L V6 hybrid PU's redline. */
export const CockpitGauge: React.FC<CockpitGaugeProps> = ({ telemetry, driver }) => {
  const speed = telemetry?.speed || 0;
  const rpm = telemetry?.rpm || 0;
  const rawGear = telemetry?.gear ?? 1;
  const gearDisplay = rawGear <= 0 ? 'R' : rawGear;

  // Authentic 1.6L V6 PCU-8D shift light calibration (15 LEDs in 5-5-5 layout)
  // Below 10,200 RPM: 0 LEDs lit (quiet zone)
  // 10,200 to 11,200 RPM: 5 Green LEDs
  // 11,200 to 11,900 RPM: 5 Red LEDs
  // 11,900 to 12,350 RPM: 5 Blue LEDs
  // >= 12,350 RPM: Redline strobe flash across all active LEDs
  const numLeds = 15;
  let activeLeds = 0;

  if (rpm >= 12350) {
    activeLeds = 15;
  } else if (rpm >= 11900) {
    const fraction = (rpm - 11900) / (12350 - 11900);
    activeLeds = 10 + Math.min(5, Math.floor(fraction * 5) + 1);
  } else if (rpm >= 11200) {
    const fraction = (rpm - 11200) / (11900 - 11200);
    activeLeds = 5 + Math.min(5, Math.floor(fraction * 5) + 1);
  } else if (rpm >= 10200) {
    const fraction = (rpm - 10200) / (11200 - 10200);
    activeLeds = Math.min(5, Math.floor(fraction * 5) + 1);
  } else {
    activeLeds = 0;
  }

  const isRedline = rpm >= 12350;

  return (
    <div className="bg-[#121620] p-4 rounded-xl border border-f1-border flex flex-col justify-between">
      {/* Header Driver Badge */}
      <div className="flex items-center justify-between border-b border-slate-800 pb-2.5 mb-3">
        <div className="flex items-center gap-2.5">
          <div
            className="w-2 h-6 rounded-full"
            style={{ backgroundColor: driver?.teamColour || '#FFFFFF' }}
          />
          <div>
            <div className="text-sm font-bold text-white tracking-wide">
              {driver?.fullName || 'Focused Car'}
            </div>
            <div className="text-[11px] text-f1-textMuted uppercase font-mono">
              {driver?.teamName || 'Formula 1 Team'} • #{driver?.driverNumber || telemetry?.driverNumber || '1'}
            </div>
          </div>
        </div>
        <div className="text-right">
          <span className="text-[11px] font-mono uppercase bg-slate-800/80 px-2 py-0.5 rounded text-slate-300">
            {telemetry ? `P${telemetry.position}` : '— No Data —'}
          </span>
        </div>
      </div>

      {/* RPM Tachometer Shift Lights */}
      <div className="mb-4">
        <div className="flex justify-between items-center text-[10px] font-mono text-slate-400 mb-1.5">
          <span>RPM TACHOMETER</span>
          <span className="font-bold text-slate-200">{rpm.toLocaleString()} RPM</span>
        </div>
        <div className="flex gap-1 bg-slate-950 p-1.5 rounded-lg border border-slate-800">
          {Array.from({ length: numLeds }).map((_, i) => {
            const isActive = i < activeLeds;
            let ledColor = 'bg-emerald-500 shadow-emerald-500/50';
            if (i >= 5 && i < 10) ledColor = 'bg-red-500 shadow-red-500/50';
            if (i >= 10) ledColor = 'bg-blue-500 shadow-blue-500/80';

            return (
              <div
                key={i}
                className={`flex-1 h-3.5 rounded-sm transition-all duration-75 ${
                  isActive
                    ? isRedline
                      ? 'bg-purple-400 shadow-lg shadow-purple-300 animate-pulse'
                      : `${ledColor} shadow-md`
                    : 'bg-slate-800/60'
                }`}
              />
            );
          })}
        </div>
      </div>

      {/* Speedometer and Gear Big Readout */}
      <div className="grid grid-cols-2 gap-3 bg-slate-950/60 p-4 rounded-xl border border-slate-800/80">
        <div className="flex flex-col items-center justify-center">
          <div className="flex items-baseline gap-1">
            <span className="text-5xl font-mono font-black text-white tracking-tighter">
              {speed}
            </span>
            <span className="text-xs font-mono font-bold text-slate-400 uppercase">
              KM/H
            </span>
          </div>
          <span className="text-[10px] font-mono text-slate-500 uppercase mt-1">SPEED</span>
        </div>
        <div className="flex flex-col items-center justify-center border-l border-slate-800">
          <span className="text-5xl font-mono font-black text-white tracking-tighter">
            {gearDisplay}
          </span>
          <span className="text-[10px] font-mono text-slate-500 uppercase mt-1">GEAR</span>
        </div>
      </div>
    </div>
  );
};

export default CockpitGauge;
