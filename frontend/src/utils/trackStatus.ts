import { TrackStatus } from '../types/f1';

export interface TrackStatusStyle {
  label: string;
  hex: string;
  badgeClass: string;
  isHazard: boolean; // pulses on the circuit map; CHEQUERED/GREEN don't
}

/** Label/color/pulse styling per track status, used by both CircuitCanvas and RaceControlFeed. */
export const TRACK_STATUS_STYLES: Record<TrackStatus, TrackStatusStyle> = {
  GREEN: {
    label: 'TRACK CLEAR',
    hex: '#22C55E',
    badgeClass: 'bg-emerald-950/70 text-emerald-300 border-emerald-700/60',
    isHazard: false,
  },
  YELLOW: {
    label: 'YELLOW FLAG',
    hex: '#EAB308',
    badgeClass: 'bg-yellow-950/80 text-yellow-300 border-yellow-600/70',
    isHazard: true,
  },
  DOUBLE_YELLOW: {
    label: 'DOUBLE YELLOW',
    hex: '#EAB308',
    badgeClass: 'bg-yellow-950/80 text-yellow-300 border-yellow-500/70',
    isHazard: true,
  },
  VSC: {
    label: 'VIRTUAL SAFETY CAR',
    hex: '#FB923C',
    badgeClass: 'bg-amber-950/80 text-amber-300 border-amber-600/70',
    isHazard: true,
  },
  SC: {
    label: 'SAFETY CAR',
    hex: '#FB923C',
    badgeClass: 'bg-amber-950/80 text-amber-300 border-amber-600/70',
    isHazard: true,
  },
  RED: {
    label: 'RED FLAG',
    hex: '#E10600',
    badgeClass: 'bg-red-950/80 text-red-300 border-red-600/70',
    isHazard: true,
  },
  CHEQUERED: {
    label: 'CHEQUERED FLAG',
    hex: '#E5E7EB',
    badgeClass: 'bg-slate-800/80 text-slate-200 border-slate-500/70',
    isHazard: false,
  },
};

export function getTrackStatusStyle(status: TrackStatus | undefined | null): TrackStatusStyle {
  return TRACK_STATUS_STYLES[status || 'GREEN'];
}
