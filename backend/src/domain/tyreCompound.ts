import { TyreCompound } from './models';

const VALID_COMPOUNDS: TyreCompound[] = ['SOFT', 'MEDIUM', 'HARD', 'INTERMEDIATE', 'WET'];

/**
 * Normalizes a raw OpenF1 compound string to a known TyreCompound, falling
 * back to UNKNOWN for anything unrecognized — the DB column is a Postgres
 * enum, so an un-normalized value would fail the insert outright rather
 * than silently being stored as free text.
 */
export function normalizeCompound(raw: any): TyreCompound {
  const compound = String(raw || 'UNKNOWN').toUpperCase() as TyreCompound;
  return VALID_COMPOUNDS.includes(compound) ? compound : 'UNKNOWN';
}
