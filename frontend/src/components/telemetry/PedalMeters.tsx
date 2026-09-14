'use client';

import React from 'react';

interface PedalMetersProps {
  throttle: number; // 0 - 100
  brake: number; // 0 - 100
}

export const PedalMeters: React.FC<PedalMetersProps> = ({ throttle, brake }) => {
  return (
    <div className="bg-[#121620] p-4 rounded-xl border border-f1-border flex flex-col justify-between">
      <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
        Pedal Pressure
      </div>

      <div className="space-y-3.5">
        {/* Throttle Bar */}
        <div>
          <div className="flex justify-between items-center text-[11px] font-mono mb-1">
            <span className="text-emerald-400 font-bold">THROTTLE</span>
            <span className="text-slate-300 font-bold">{throttle}%</span>
          </div>
          <div className="w-full h-4 bg-slate-950 rounded-md border border-slate-800 overflow-hidden p-0.5">
            <div
              className="h-full bg-emerald-500 rounded-sm transition-all duration-75 shadow-lg shadow-emerald-500/30"
              style={{ width: `${Math.min(100, Math.max(0, throttle))}%` }}
            />
          </div>
        </div>

        {/* Brake Bar */}
        <div>
          <div className="flex justify-between items-center text-[11px] font-mono mb-1">
            <span className="text-red-400 font-bold">BRAKE</span>
            <span className="text-slate-300 font-bold">{brake}%</span>
          </div>
          <div className="w-full h-4 bg-slate-950 rounded-md border border-slate-800 overflow-hidden p-0.5">
            <div
              className="h-full bg-red-600 rounded-sm transition-all duration-75 shadow-lg shadow-red-600/30"
              style={{ width: `${Math.min(100, Math.max(0, brake))}%` }}
            />
          </div>
        </div>
      </div>

      <div className="flex justify-between text-[10px] font-mono text-slate-500 mt-2">
        <span>0%</span>
        <span>50%</span>
        <span>100%</span>
      </div>
    </div>
  );
};

export default PedalMeters;
