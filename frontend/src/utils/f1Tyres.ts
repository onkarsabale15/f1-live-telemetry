import { TyreCompound } from '../types/f1';

/** Visual styling (FIA colors, Tailwind classes) for one tyre compound's badge. */
export interface TyreBadgeStyle {
  code: string;
  name: string;
  badgeClass: string;
  textClass: string;
  borderClass: string;
  bgClass: string;
  hex: string;
}

/** Official FIA color/badge styling per tyre compound. */
export const FIA_TYRE_COMPOUNDS: Record<TyreCompound, TyreBadgeStyle> = {
  SOFT: {
    code: 'S',
    name: 'Soft',
    badgeClass: 'border-[#E10600] text-[#E10600] bg-[#E10600]/15',
    textClass: 'text-[#E10600]',
    borderClass: 'border-[#E10600]',
    bgClass: 'bg-[#E10600]/15',
    hex: '#E10600',
  },
  MEDIUM: {
    code: 'M',
    name: 'Medium',
    badgeClass: 'border-[#FFF500] text-[#FFF500] bg-[#FFF500]/15',
    textClass: 'text-[#FFF500]',
    borderClass: 'border-[#FFF500]',
    bgClass: 'bg-[#FFF500]/15',
    hex: '#FFF500',
  },
  HARD: {
    code: 'H',
    name: 'Hard',
    badgeClass: 'border-[#FFFFFF] text-[#FFFFFF] bg-[#FFFFFF]/15',
    textClass: 'text-[#FFFFFF]',
    borderClass: 'border-[#FFFFFF]',
    bgClass: 'bg-[#FFFFFF]/15',
    hex: '#FFFFFF',
  },
  INTERMEDIATE: {
    code: 'I',
    name: 'Inter',
    badgeClass: 'border-[#39B54A] text-[#39B54A] bg-[#39B54A]/15',
    textClass: 'text-[#39B54A]',
    borderClass: 'border-[#39B54A]',
    bgClass: 'bg-[#39B54A]/15',
    hex: '#39B54A',
  },
  WET: {
    code: 'W',
    name: 'Wet',
    badgeClass: 'border-[#0072CE] text-[#0072CE] bg-[#0072CE]/15',
    textClass: 'text-[#0072CE]',
    borderClass: 'border-[#0072CE]',
    bgClass: 'bg-[#0072CE]/15',
    hex: '#0072CE',
  },
  UNKNOWN: {
    code: '?',
    name: 'Unknown',
    badgeClass: 'border-[#64748B] text-[#64748B] bg-[#64748B]/15',
    textClass: 'text-[#64748B]',
    borderClass: 'border-[#64748B]',
    bgClass: 'bg-[#64748B]/15',
    hex: '#64748B',
  },
};

/**
 * Returns FIA badge styling and hex colors for a given tyre compound.
 */
export function getTyreBadge(compound: TyreCompound | string | undefined | null): TyreBadgeStyle {
  if (!compound) return FIA_TYRE_COMPOUNDS.UNKNOWN;
  const normalized = String(compound).trim().toUpperCase() as TyreCompound;
  return FIA_TYRE_COMPOUNDS[normalized] || FIA_TYRE_COMPOUNDS.UNKNOWN;
}
