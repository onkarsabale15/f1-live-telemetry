export type TrackStatus = 'GREEN' | 'YELLOW' | 'DOUBLE_YELLOW' | 'SC' | 'VSC' | 'RED' | 'CHEQUERED';

export interface TrackStatusResult {
  status: TrackStatus;
  message: string | null;
  date: string | null;
}

const SEVERITY: Record<TrackStatus, number> = {
  GREEN: 0,
  YELLOW: 1,
  DOUBLE_YELLOW: 2,
  VSC: 3,
  SC: 4,
  RED: 5,
  CHEQUERED: 6,
};

/**
 * Derives the current track status from a chronological (ascending-date)
 * OpenF1 race_control message list, up through whatever cutoff the caller
 * already filtered the list to.
 *
 * In practice most yellow flags are sector-scoped (localized to a marshal
 * post, not the whole track) — a real session's messages are overwhelmingly
 * `scope: "Sector"`, with full `scope: "Track"` flags reserved for race
 * start/finish, red flags, and safety car periods. So this tracks which
 * sectors currently have an active (not yet cleared) yellow/double-yellow,
 * and reports the worst live condition across sectors plus any track-wide
 * override (red flag, safety car, VSC) — not just the single latest message,
 * which would otherwise flip back to green the instant any one sector clears
 * while others are still flagged.
 */
function computeStatus(
  activeSectorFlags: Map<number, 'YELLOW' | 'DOUBLE_YELLOW'>,
  trackWideOverride: 'SC' | 'VSC' | 'RED' | 'CHEQUERED' | null
): TrackStatus {
  let worstSectorFlag: 'YELLOW' | 'DOUBLE_YELLOW' | null = null;
  for (const level of activeSectorFlags.values()) {
    if (level === 'DOUBLE_YELLOW') worstSectorFlag = 'DOUBLE_YELLOW';
    else if (!worstSectorFlag) worstSectorFlag = 'YELLOW';
  }

  const candidates: TrackStatus[] = ['GREEN'];
  if (worstSectorFlag) candidates.push(worstSectorFlag);
  if (trackWideOverride) candidates.push(trackWideOverride);

  return candidates.reduce((worst, s) => (SEVERITY[s] > SEVERITY[worst] ? s : worst), 'GREEN' as TrackStatus);
}

export function deriveTrackStatus(messagesAsc: any[]): TrackStatusResult {
  const activeSectorFlags = new Map<number, 'YELLOW' | 'DOUBLE_YELLOW'>();
  let trackWideOverride: 'SC' | 'VSC' | 'RED' | 'CHEQUERED' | null = null;
  let status: TrackStatus = 'GREEN';
  // Only updated when a message actually changes the computed status, so
  // the displayed reason always matches what's currently showing — e.g. a
  // sector clearing elsewhere shouldn't overwrite "SAFETY CAR DEPLOYED" as
  // the shown reason while the safety car is still out.
  let message: string | null = null;
  let date: string | null = null;

  for (const m of messagesAsc) {
    const category = String(m.category || '').toUpperCase();
    const text = String(m.message || '').toUpperCase();
    let changed = false;

    if (category === 'FLAG') {
      const scope = String(m.scope || 'TRACK').toUpperCase();
      const flag = String(m.flag || '').toUpperCase();
      const sector = typeof m.sector === 'number' ? m.sector : null;

      if (scope === 'SECTOR' && sector !== null) {
        if (flag === 'YELLOW') activeSectorFlags.set(sector, 'YELLOW');
        else if (flag === 'DOUBLE YELLOW') activeSectorFlags.set(sector, 'DOUBLE_YELLOW');
        else if (flag === 'CLEAR' || flag === 'GREEN') activeSectorFlags.delete(sector);
        else continue;
      } else if (scope === 'TRACK') {
        if (flag === 'RED') trackWideOverride = 'RED';
        else if (flag === 'CHEQUERED') trackWideOverride = 'CHEQUERED';
        else if (flag === 'GREEN' || flag === 'CLEAR') {
          // Full-course green cancels a red/SC/VSC override and clears every
          // outstanding sector flag — real marshalling always follows a
          // track-wide green with sector clears, but don't wait on those.
          trackWideOverride = null;
          activeSectorFlags.clear();
        } else continue;
      } else {
        continue; // driver-specific (blue, black, etc.) — no track effect
      }
      changed = true;
    } else if (category === 'SAFETYCAR') {
      // OpenF1 uses both the full phrase and the "VSC" abbreviation in
      // practice (observed: "VSC DEPLOYED", "VSC ENDING") — check both.
      const isVirtual = text.includes('VIRTUAL SAFETY CAR') || text.includes('VSC');
      const isEnding = text.includes('ENDING') || text.includes('IN THIS LAP');
      const isDeployed = text.includes('DEPLOYED');

      if (isDeployed) trackWideOverride = isVirtual ? 'VSC' : 'SC';
      else if (isEnding) trackWideOverride = null;
      else continue;
      changed = true;
    }

    if (!changed) continue;
    const newStatus = computeStatus(activeSectorFlags, trackWideOverride);
    if (newStatus !== status) {
      status = newStatus;
      message = m.message || null;
      date = m.date || null;
    }
  }

  return { status, message, date };
}
