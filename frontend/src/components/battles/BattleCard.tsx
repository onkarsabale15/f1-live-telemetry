'use client';

import React from 'react';
import { OvertakeBattle } from '../../types/f1';
import { Zap, Flame, ArrowUpRight } from 'lucide-react';
import { getTyreBadge } from '../../utils/f1Tyres';
import { getOvertakeAidLabels } from '../../utils/overtakeAid';

interface BattleCardProps {
  battle: OvertakeBattle;
  onFocusBattle: (driverNumber: number) => void;
  hasDrs?: boolean;
}

/** One predicted-overtake card — gap, closing rate, tyre/speed deltas, and an overtake-probability bar for a single chaser/defender pair. */
export const BattleCard: React.FC<BattleCardProps> = ({ battle, onFocusBattle, hasDrs = true }) => {
  const aid = getOvertakeAidLabels(hasDrs);
  const probColor =
    battle.probability >= 70
      ? 'from-red-500 to-amber-500 text-red-400'
      : battle.probability >= 45
      ? 'from-amber-400 to-yellow-500 text-amber-400'
      : 'from-blue-500 to-cyan-400 text-cyan-400';

  const chaserBadge = getTyreBadge(battle.chaser.compound);
  const defenderBadge = getTyreBadge(battle.defender.compound);

  return (
    <div
      onClick={() => onFocusBattle(battle.chaser.driverNumber)}
      className="bg-[#121620] hover:bg-[#181E2C] border border-f1-border hover:border-slate-600 rounded-xl p-3.5 transition-all duration-200 cursor-pointer shadow-lg group relative overflow-hidden"
    >
      {/* Top Banner: Duel Header */}
      <div className="flex items-center justify-between mb-2.5">
        <div className="flex items-center gap-2">
          <span className="flex h-2 w-2 relative">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500" />
          </span>
          <span className="text-[11px] font-mono font-bold uppercase tracking-wider text-slate-300">
            Battle for Position
          </span>
        </div>

        {/* DRS / Override Status: Active vs In Range */}
        {battle.drsActive ? (
          <span className="inline-flex items-center gap-1 text-[10px] font-mono font-black text-emerald-400 bg-emerald-950/80 px-2 py-0.5 rounded border border-emerald-500 shadow-sm shadow-emerald-500/30 animate-pulse">
            <Zap className="w-3 h-3" /> {aid.activeBadge}
          </span>
        ) : battle.drsEligible ? (
          <span className="inline-flex items-center gap-1 text-[10px] font-mono font-bold text-cyan-300 bg-cyan-950/60 px-2 py-0.5 rounded border border-cyan-700/60">
            <Zap className="w-3 h-3" /> {aid.inRangeBadge}
          </span>
        ) : null}
      </div>

      {/* Driver Matchup Row */}
      <div className="flex items-center justify-between my-2">
        {/* Chaser */}
        <div className="flex items-center gap-2">
          <div
            className="w-1.5 h-7 rounded-full"
            style={{ backgroundColor: battle.chaser.teamColor }}
          />
          <div>
            <div className="text-sm font-black text-white font-mono group-hover:text-amber-400 transition-colors">
              {battle.chaser.code}
            </div>
            <div className="flex items-center gap-1.5 mt-0.5">
              <span
                className="w-3.5 h-3.5 rounded-full border flex items-center justify-center text-[8px] font-black font-mono"
                style={{
                  borderColor: chaserBadge.hex,
                  color: chaserBadge.hex,
                  backgroundColor: `${chaserBadge.hex}25`,
                }}
              >
                {chaserBadge.code}
              </span>
              <span className="text-[10px] font-mono text-slate-400">
                {battle.chaser.tyreAge}L
              </span>
            </div>
          </div>
        </div>

        {/* Dynamic Gap Centerpiece */}
        <div className="flex flex-col items-center px-3">
          <span className="text-base font-mono font-black text-white tracking-tight">
            +{battle.gap.toFixed(3)}s
          </span>
          <span className="text-[10px] font-mono text-emerald-400 flex items-center">
            {battle.closingRate > 0 ? `-${battle.closingRate.toFixed(2)}s/lap` : '+0.0s'}
          </span>
        </div>

        {/* Defender */}
        <div className="flex items-center gap-2 text-right">
          <div>
            <div className="text-sm font-black text-slate-200 font-mono">
              {battle.defender.code}
            </div>
            <div className="flex items-center justify-end gap-1.5 mt-0.5">
              <span className="text-[10px] font-mono text-slate-400">
                {battle.defender.tyreAge}L
              </span>
              <span
                className="w-3.5 h-3.5 rounded-full border flex items-center justify-center text-[8px] font-black font-mono"
                style={{
                  borderColor: defenderBadge.hex,
                  color: defenderBadge.hex,
                  backgroundColor: `${defenderBadge.hex}25`,
                }}
              >
                {defenderBadge.code}
              </span>
            </div>
          </div>
          <div
            className="w-1.5 h-7 rounded-full"
            style={{ backgroundColor: battle.defender.teamColor }}
          />
        </div>
      </div>

      {/* Tactical Metrics Strip */}
      <div className="flex items-center justify-between text-[10px] font-mono text-slate-400 bg-slate-950/70 px-2.5 py-1.5 rounded-lg border border-slate-800/80 my-2">
        <span>
          Tyre Delta:{' '}
          <strong className="text-white">
            {battle.tyreDeltaFactor > 0 ? `+${battle.tyreDeltaFactor.toFixed(2)}s Tyre Delta` : 'Even Tyre Pace'}
          </strong>
        </span>
        {battle.speedDelta !== undefined && (
          <span>
            Speed:{' '}
            <strong className={battle.speedDelta >= 0 ? 'text-emerald-400' : 'text-slate-300'}>
              {battle.speedDelta >= 0 ? `+${battle.speedDelta}` : battle.speedDelta} km/h
            </strong>
          </span>
        )}
        <span>
          Confidence:{' '}
          <strong
            className={
              battle.confidence === 'HIGH'
                ? 'text-emerald-400'
                : battle.confidence === 'MEDIUM'
                ? 'text-amber-400'
                : 'text-slate-400'
            }
          >
            {battle.confidence}
          </strong>
        </span>
      </div>

      {/* Overtake Probability Bar */}
      <div className="mt-2.5">
        <div className="flex justify-between items-center text-[10px] font-mono font-bold mb-1">
          <span className="text-slate-400 flex items-center gap-1">
            <Flame className="w-3 h-3 text-amber-500" /> OVERTAKE PROBABILITY
          </span>
          <span className={probColor}>{battle.probability}%</span>
        </div>
        <div className="w-full h-2.5 bg-slate-950 rounded-full overflow-hidden border border-slate-800 p-0.5">
          <div
            className={`h-full rounded-full bg-gradient-to-r ${probColor} transition-all duration-300`}
            style={{ width: `${battle.probability}%` }}
          />
        </div>
      </div>

      {/* Footer Prediction Summary */}
      <div className="flex items-center justify-between text-[11px] font-mono text-slate-400 mt-2.5 pt-2 border-t border-slate-800/80">
        <span>
          Est. Pass:{' '}
          <strong className="text-white">
            {battle.estLapsToPass < 20
              ? `${battle.estLapsToPass} Laps${
                  battle.estTimeToPassSeconds != null ? ` (~${Math.round(battle.estTimeToPassSeconds)}s)` : ''
                }`
              : 'Stalemate'}
          </strong>
        </span>
        <span className="text-[10px] text-slate-500 flex items-center gap-0.5 group-hover:text-slate-300">
          Focus Telemetry <ArrowUpRight className="w-3 h-3" />
        </span>
      </div>
    </div>
  );
};

export default BattleCard;
