'use client';

import React from 'react';
import { TyreCompound } from '../../types/f1';
import { getTyreBadge } from '../../utils/f1Tyres';
import { getOvertakeAidLabels } from '../../utils/overtakeAid';

interface GearDrsProps {
  gear: number;
  drs: boolean;
  compound: TyreCompound;
  tyreAge: number | null;
  hasDrs?: boolean;
}

export const GearDrsIndicator: React.FC<GearDrsProps> = ({ gear, drs, compound, tyreAge, hasDrs = true }) => {
  const tyreBadge = getTyreBadge(compound);
  const gearDisplay = gear <= 0 ? 'R' : gear;
  const aid = getOvertakeAidLabels(hasDrs);

  return (
    <div className="bg-[#121620] p-4 rounded-xl border border-f1-border flex flex-col justify-between">
      <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
        Gear &amp; {aid.short} Status
      </div>

      <div className="grid grid-cols-2 gap-3 my-auto">
        {/* Gear Box */}
        <div className="flex flex-col items-center justify-center bg-slate-950 p-3 rounded-lg border border-slate-800">
          <span className="text-[10px] font-mono font-bold text-slate-400 mb-1">GEAR</span>
          <span className="text-4xl font-mono font-black text-white">
            {gearDisplay}
          </span>
        </div>

        {/* DRS / Override Box */}
        <div
          className={`flex flex-col items-center justify-center p-3 rounded-lg border transition-all duration-150 ${
            drs
              ? 'bg-emerald-950/60 border-emerald-500 text-emerald-400 shadow-lg shadow-emerald-500/20'
              : 'bg-slate-950 border-slate-800 text-slate-500'
          }`}
        >
          <span className="text-[10px] font-mono font-bold mb-1">{aid.short}</span>
          <span className={`text-base font-black tracking-wider ${drs ? 'animate-pulse' : ''}`}>
            {drs ? aid.statusOpen : aid.statusOff}
          </span>
        </div>
      </div>

      {/* Tyre Stint Box */}
      <div className="flex items-center justify-between bg-slate-950/80 px-3 py-2 rounded-lg border border-slate-800/80 mt-3">
        <div className="flex items-center gap-2">
          <span
            className="w-6 h-6 rounded-full border-2 flex items-center justify-center text-xs font-black font-mono"
            style={{
              borderColor: tyreBadge.hex,
              color: tyreBadge.hex,
              backgroundColor: `${tyreBadge.hex}25`,
            }}
          >
            {tyreBadge.code}
          </span>
          <span className="text-xs font-bold text-slate-300 uppercase">{tyreBadge.name}</span>
        </div>
        <div className="text-xs font-mono text-slate-400">
          Age: <span className="text-white font-bold">{tyreAge !== null ? tyreAge : '—'}</span>{tyreAge !== null ? ' laps' : ''}
        </div>
      </div>
    </div>
  );
};

export default GearDrsIndicator;
