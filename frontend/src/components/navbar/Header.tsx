'use client';

import React from 'react';
import { SessionMeta } from '../../types/f1';
import { GoogleAuthWidget } from '../auth/GoogleSignInButton';
import { Gauge, Radio, CalendarDays, Users } from 'lucide-react';

interface HeaderProps {
  sessionMeta: SessionMeta | null;
  onOpenExplorer: () => void;
  onOpenComparison: () => void;
}

/** Top navbar — branding, the current session's name/circuit, and buttons to open Match Explorer / Driver Comparison. */
export const Header: React.FC<HeaderProps> = ({ sessionMeta, onOpenExplorer, onOpenComparison }) => {
  return (
    <header className="bg-[#0B0E14] border-b border-f1-border py-3 px-4 sm:px-8 flex items-center justify-between shadow-xl">
      {/* Left Branding */}
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 bg-f1-red rounded-lg flex items-center justify-center text-white shadow-lg shadow-red-900/50">
          <Gauge className="w-5 h-5" />
        </div>
        <div>
          <div className="flex items-center gap-2">
            <span className="text-base font-black font-mono tracking-tight text-white">
              APEX <span className="text-f1-red">//</span> F1 LIVE
            </span>
            <span className="text-[10px] font-mono font-bold bg-red-950 text-red-400 border border-red-800/80 px-1.5 py-0.2 rounded">
              PRO
            </span>
          </div>
          <p className="text-[11px] text-f1-textMuted font-mono hidden sm:block">
            High-Frequency Telemetry & Predictive Overtake Engine
          </p>
        </div>
      </div>

      {/* Center Circuit Pill */}
      {sessionMeta && (
        <div className="hidden md:flex items-center gap-2 bg-slate-900/80 border border-slate-700/80 px-3 py-1 rounded-full text-xs font-mono text-slate-300">
          <Radio className="w-3.5 h-3.5 text-emerald-400 animate-pulse" />
          <span>{sessionMeta.countryName}</span>
          <span className="text-slate-600">•</span>
          <span className="text-white font-bold">{sessionMeta.circuitShortName}</span>
        </div>
      )}

      {/* Right Controls */}
      <div className="flex items-center gap-1.5 sm:gap-2.5">
        <button
          onClick={onOpenExplorer}
          title="Match Explorer"
          className="flex items-center gap-1.5 p-2 sm:px-3 sm:py-1.5 bg-slate-900 hover:bg-slate-800 border border-slate-700/80 text-slate-200 rounded-lg text-xs font-mono font-semibold transition-colors"
        >
          <CalendarDays className="w-3.5 h-3.5" /> <span className="hidden sm:inline">Match Explorer</span>
        </button>
        <button
          onClick={onOpenComparison}
          title="Compare Drivers"
          className="flex items-center gap-1.5 p-2 sm:px-3 sm:py-1.5 bg-slate-900 hover:bg-slate-800 border border-slate-700/80 text-slate-200 rounded-lg text-xs font-mono font-semibold transition-colors"
        >
          <Users className="w-3.5 h-3.5" /> <span className="hidden sm:inline">Compare Drivers</span>
        </button>
        <GoogleAuthWidget />
      </div>
    </header>
  );
};

export default Header;
