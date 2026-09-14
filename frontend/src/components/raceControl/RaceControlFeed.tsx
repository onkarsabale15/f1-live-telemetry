'use client';

import React, { useState } from 'react';
import { RaceControlResult } from '../../types/f1';
import { getTrackStatusStyle } from '../../utils/trackStatus';
import { Flag, ChevronDown } from 'lucide-react';

interface RaceControlFeedProps {
  data: RaceControlResult | null;
  loading: boolean;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '--:--:--';
  return d.toLocaleTimeString('en-GB', { hour12: false });
}

// Only these categories carry track-relevant signal for a race-day viewer —
// "CarEvent" rows are mostly telemetry-system chatter that would drown out
// the flags/SC/penalties that actually matter.
const VISIBLE_CATEGORIES = new Set(['FLAG', 'SAFETYCAR', 'OTHER']);

function dotColorFor(category: string, flag: string): string {
  if (category === 'SAFETYCAR') return '#FB923C';
  if (flag === 'RED') return '#E10600';
  if (flag === 'DOUBLE YELLOW' || flag === 'YELLOW') return '#EAB308';
  if (flag === 'GREEN' || flag === 'CLEAR') return '#22C55E';
  if (flag === 'CHEQUERED') return '#E5E7EB';
  return '#64748B';
}

/**
 * Collapsed by default to a single-line strip (status + latest message) —
 * the full scrollable history is opt-in via the toggle, so this doesn't
 * compete for vertical space with the panels below it.
 */
export const RaceControlFeed: React.FC<RaceControlFeedProps> = ({ data, loading }) => {
  const [expanded, setExpanded] = useState(false);
  const status = getTrackStatusStyle(data?.trackStatus);
  const messages = (data?.messages || []).filter((m) => VISIBLE_CATEGORIES.has(String(m.category).toUpperCase()));
  const latest = messages[0] || null;

  return (
    <div className="bg-[#0B0E14] border border-f1-border rounded-xl shadow-xl overflow-hidden">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-left hover:bg-slate-900/40 transition-colors"
      >
        <Flag className="w-3.5 h-3.5 text-red-400 shrink-0" />
        <div
          className={`flex items-center gap-1.5 px-2 py-0.5 rounded border font-mono font-black text-[10px] uppercase tracking-wide shrink-0 ${status.badgeClass}`}
        >
          <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: status.hex }} />
          {status.label}
        </div>

        <p className="flex-1 min-w-0 truncate text-[11px] font-mono text-slate-400">
          {loading && !data ? 'Loading race control feed...' : latest ? latest.message : 'No messages yet'}
        </p>

        <span className="shrink-0 text-[9px] font-mono text-slate-600">{messages.length} events</span>
        <ChevronDown className={`w-4 h-4 text-slate-500 shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`} />
      </button>

      {expanded && (
        <div className="border-t border-slate-800/80 px-2 py-2 space-y-0.5 max-h-[220px] overflow-y-auto">
          {messages.length === 0 ? (
            <div className="text-center py-4 text-slate-500 text-xs font-mono">No messages yet</div>
          ) : (
            messages.map((m, idx) => {
              const flag = String(m.flag || '').toUpperCase();
              const category = String(m.category).toUpperCase();
              return (
                <div
                  key={`${m.date}-${idx}`}
                  className="flex items-center gap-2 py-1 px-1.5 rounded hover:bg-slate-900/60 transition-colors text-[11px] font-mono"
                >
                  <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: dotColorFor(category, flag) }} />
                  <span className="text-slate-600 shrink-0 w-10">{m.lapNumber != null ? `L${m.lapNumber}` : ''}</span>
                  <span className="text-slate-600 shrink-0 w-16">{formatTime(m.date)}</span>
                  <span className="text-slate-300 truncate">{m.message}</span>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
};

export default RaceControlFeed;
