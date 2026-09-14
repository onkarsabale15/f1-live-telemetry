/**
 * Formats a lap time in seconds as F1-style "m:ss.sss" (e.g. 83.456 -> "1:23.456")
 */
export function formatLapTime(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—';
  const mins = Math.floor(seconds / 60);
  const secs = seconds - mins * 60;
  return `${mins}:${secs.toFixed(3).padStart(6, '0')}`;
}

/**
 * Formats a signed delta in seconds (e.g. -0.234 -> "-0.234s", 1.2 -> "+1.200s")
 */
export function formatDelta(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—';
  const sign = seconds > 0 ? '+' : seconds < 0 ? '-' : '';
  return `${sign}${Math.abs(seconds).toFixed(3)}s`;
}

/**
 * Formats a duration in milliseconds as "h:mm:ss" (or "m:ss" under an hour)
 * — used for the session replay scrubber's elapsed/total time labels.
 */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return '0:00';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

/**
 * Formats a pit stop duration. OpenF1's pit_duration measures pit-box entry
 * to exit — during a red flag or safety car the car can sit in the box for
 * several minutes, which is real data, not a bug, so render it as m:ss
 * instead of a misleading four-digit second count.
 */
export function formatPitDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—';
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return `${mins}m ${secs}s`;
}
