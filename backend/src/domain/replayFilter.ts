/**
 * Trims OpenF1-shaped laps/stints/pits arrays down to "as of lap N" — used
 * so replay scrubbing/playback reveals race data progressively (pace,
 * tyre strategy, predicted pit windows) instead of always showing the
 * final, fully-raced state regardless of where the scrubber currently is.
 *
 * A stint whose recorded end lies beyond `uptoLap` is treated as still
 * open (lap_end -> null): as of `uptoLap`, that pit stop hasn't happened
 * yet from the replay's point of view, so downstream code that already
 * handles "ongoing stint" (lap_end == null) picks it up correctly.
 */
export function filterToLap(
  laps: any[],
  stints: any[],
  pits: any[],
  uptoLap: number | null
): { laps: any[]; stints: any[]; pits: any[] } {
  if (uptoLap == null) return { laps, stints, pits };

  const filteredLaps = laps.filter((l) => (l.lap_number || 0) <= uptoLap);
  const filteredStints = stints
    .filter((s) => (s.lap_start || 0) <= uptoLap)
    .map((s) => (s.lap_end != null && s.lap_end <= uptoLap ? s : { ...s, lap_end: null }));
  const filteredPits = pits.filter((p) => (p.lap_number || 0) <= uptoLap);

  return { laps: filteredLaps, stints: filteredStints, pits: filteredPits };
}
