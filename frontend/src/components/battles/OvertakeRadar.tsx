'use client';

import React from 'react';
import { OvertakeBattle } from '../../types/f1';
import { BattleCard } from './BattleCard';
import { Crosshair } from 'lucide-react';

interface OvertakeRadarProps {
  battles: OvertakeBattle[];
  hasGapData: boolean;
  hasDrs?: boolean;
  onFocusBattle: (driverNumber: number) => void;
}

/** Lists every currently predicted overtake battle as BattleCards, with explicit empty states for non-Race sessions and "nothing in range yet". */
export const OvertakeRadar: React.FC<OvertakeRadarProps> = ({ battles, hasGapData, hasDrs = true, onFocusBattle }) => {
  return (
    <div className="bg-[#0F1218] rounded-xl border border-f1-border p-4 flex flex-col h-full shadow-2xl">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-slate-800 pb-3 mb-3">
        <div className="flex items-center gap-2">
          <Crosshair className="w-4 h-4 text-amber-400 animate-spin-slow" />
          <span className="text-xs font-bold uppercase tracking-wider text-slate-200">
            Predicted Overtakes Radar
          </span>
        </div>
        {hasGapData && (
          <span className="text-[11px] font-mono bg-amber-500/10 text-amber-400 border border-amber-500/30 px-2 py-0.5 rounded-full font-bold">
            {battles.length} Active {battles.length === 1 ? 'Duel' : 'Duels'}
          </span>
        )}
      </div>

      {/* Battles List */}
      <div className="space-y-3 overflow-y-auto max-h-[400px] pr-1">
        {!hasGapData ? (
          <div className="flex flex-col items-center justify-center py-12 text-center text-slate-500 text-xs font-mono">
            <Crosshair className="w-8 h-8 text-slate-600 mb-2 opacity-40" />
            Overtake battles are only tracked during Race &amp; Sprint sessions.
            <br />
            This session does not report gap data.
          </div>
        ) : battles.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center text-slate-500 text-xs font-mono">
            <Crosshair className="w-8 h-8 text-slate-600 mb-2 opacity-40" />
            No cars within 2.0s attack window.
            <br />
            Scanning circuit sectors...
          </div>
        ) : (
          battles.map((battle) => (
            <BattleCard
              key={battle.battleId}
              battle={battle}
              onFocusBattle={onFocusBattle}
              hasDrs={hasDrs}
            />
          ))
        )}
      </div>
    </div>
  );
};

export default OvertakeRadar;
