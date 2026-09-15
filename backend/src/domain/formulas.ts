import { TyreCompound, CircuitBounds, TrackReferencePoint } from './models';

/** Tyre compound relative pace offset, in seconds per lap of theoretical advantage over HARD. */
export const COMPOUND_PACE_RANK: Record<TyreCompound, number> = {
  SOFT: 0.8,
  MEDIUM: 0.4,
  HARD: 0.0,
  INTERMEDIATE: 0.0,
  WET: -0.5,
  UNKNOWN: 0.0,
};

/** Standard logistic squashing function, mapping any real number into (0, 1). */
export function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z));
}

/**
 * Calculates closing rate (seconds gained per lap) between chaser and
 * defender. Protects against gap <= 0, division by zero, and non-finite
 * values, and clamps to a physically plausible range.
 * @param previousGap Interval-to-ahead (seconds) at the start of the sample window
 * @param currentGap Interval-to-ahead (seconds) now
 * @param timeDiffSeconds Elapsed time between the two samples
 * @param typicalLapTimeSeconds Reference lap time used to scale the per-window delta into a per-lap rate
 * @returns Seconds gained per lap (positive = chaser closing), clamped to ±15
 */
export function calculateClosingRate(
  previousGap: number,
  currentGap: number,
  timeDiffSeconds: number,
  typicalLapTimeSeconds: number = 80
): number {
  if (
    !Number.isFinite(previousGap) ||
    !Number.isFinite(currentGap) ||
    !Number.isFinite(timeDiffSeconds) ||
    timeDiffSeconds <= 0
  ) {
    return 0;
  }
  // When gap is 0 or negative (cars level/already passed), closing rate is 0
  if (currentGap <= 0) {
    return 0;
  }
  const gapDiff = previousGap - currentGap;
  const rate = (gapDiff / timeDiffSeconds) * typicalLapTimeSeconds;
  if (!Number.isFinite(rate)) return 0;

  // Real on-track pace deltas rarely exceed a few seconds per lap. A rate
  // beyond this is virtually always a data artifact — e.g. sparse gap
  // sampling for a backmarker, or OpenF1's interval flipping between an
  // actual second value and the "+1 LAP" placeholder (parsed as a flat 90s)
  // — not a genuine closing speed. Clamping keeps the UI honest instead of
  // reporting a four-digit "seconds per lap" that can't physically happen.
  const MAX_PLAUSIBLE_RATE = 15;
  const clamped = Math.max(-MAX_PLAUSIBLE_RATE, Math.min(MAX_PLAUSIBLE_RATE, rate));
  return Number(clamped.toFixed(2));
}

/**
 * Closing rate computed via least-squares linear regression across the
 * whole gap-history window, instead of a raw two-point diff. OpenF1's gap
 * samples are sparse and bursty (interval updates don't arrive on a fixed
 * clock), so a two-point diff can flip sign from one noisy sample alone —
 * regression over several samples smooths that out into a stable trend,
 * which is what actually makes the "closing rate" (and everything derived
 * from it downstream) look predictable instead of jittery in the UI.
 * @param history Recent {timestamp (ms), interval (s)} samples, oldest first
 * @param typicalLapTimeSeconds Reference lap time used to scale the per-second slope into a per-lap rate
 * @returns Seconds gained per lap (positive = chaser closing), clamped to ±15
 */
export function calculateClosingRateTrend(
  history: { timestamp: number; interval: number }[],
  typicalLapTimeSeconds: number = 80
): number {
  const finite = history.filter(
    (p) => Number.isFinite(p.timestamp) && Number.isFinite(p.interval) && p.interval >= 0
  );
  if (finite.length < 2) return 0;

  // Reject single-sample data artifacts (e.g. OpenF1's "+1 LAP" placeholder
  // parsed as a flat 90s — see calculateClosingRate's doc, and
  // openf1.service.ts's parseInterval) before fitting a trend line. A plain
  // regression is actually *more* exposed to this than a two-point diff
  // would be, since every sample — not just the two endpoints — pulls on
  // the fitted slope; one bad reading anywhere in the window (including the
  // newest one, which lands here often) can swing the whole trend.
  //
  // Uses a modified z-score against the median absolute deviation (MAD)
  // rather than a fixed cutoff, so it doesn't need to guess what a "normal"
  // range of gap movement looks like — that's legitimately different for a
  // tight midfield scrap vs. a lapped car rejoining. MAD-based detection
  // scales with how much the window's own samples actually vary, so a
  // genuinely smooth trend spanning several seconds survives untouched
  // while one point that jumps far outside that window's own spread gets
  // dropped. Skipped below 4 samples — too few to tell "trend" from "noise".
  let points = finite;
  if (finite.length >= 4) {
    const sortedIntervals = [...finite].map((p) => p.interval).sort((a, b) => a - b);
    const median = sortedIntervals[Math.floor(sortedIntervals.length / 2)];
    const sortedAbsDevs = finite.map((p) => Math.abs(p.interval - median)).sort((a, b) => a - b);
    const mad = sortedAbsDevs[Math.floor(sortedAbsDevs.length / 2)];
    const MAD_TO_STD_CONSTANT = 0.6745; // scales MAD to be comparable to a standard deviation for a normal distribution
    const OUTLIER_Z_THRESHOLD = 3.5; // standard modified-z-score cutoff (Iglewicz & Hoaglin)
    if (mad > 0) {
      const filtered = finite.filter((p) => Math.abs((MAD_TO_STD_CONSTANT * (p.interval - median)) / mad) <= OUTLIER_Z_THRESHOLD);
      if (filtered.length >= 2) points = filtered;
    } else {
      // Degenerate case: most samples are identical, so MAD collapses to 0
      // and any z-score would be infinite. Fall back to a small fixed
      // tolerance instead of rejecting every non-identical sample outright.
      const FLAT_WINDOW_TOLERANCE_S = 0.3;
      const filtered = finite.filter((p) => Math.abs(p.interval - median) <= FLAT_WINDOW_TOLERANCE_S);
      if (filtered.length >= 2) points = filtered;
    }
  }
  if (points.length < 2) return 0;

  // Fit interval = a + b*t (seconds since the window's first sample) via
  // ordinary least squares; b is the gap's rate of change in s/s.
  const t0 = points[0].timestamp;
  let sumT = 0;
  let sumGap = 0;
  let sumTGap = 0;
  let sumTT = 0;
  for (const p of points) {
    const t = (p.timestamp - t0) / 1000;
    sumT += t;
    sumGap += p.interval;
    sumTGap += t * p.interval;
    sumTT += t * t;
  }
  const n = points.length;
  const denom = n * sumTT - sumT * sumT;
  if (denom === 0) return 0; // all samples landed at the same timestamp

  const slopePerSecond = (n * sumTGap - sumT * sumGap) / denom;
  if (!Number.isFinite(slopePerSecond)) return 0;

  // A shrinking gap (negative slope) means the chaser is closing.
  const rate = -slopePerSecond * typicalLapTimeSeconds;
  if (!Number.isFinite(rate)) return 0;

  const MAX_PLAUSIBLE_RATE = 15;
  const clamped = Math.max(-MAX_PLAUSIBLE_RATE, Math.min(MAX_PLAUSIBLE_RATE, rate));
  return Number(clamped.toFixed(2));
}

/**
 * Calculates overtake probability based on live track metrics
 * @param gap Current gap in seconds to the car ahead
 * @param closingRate Rate at which chaser is catching (seconds per lap)
 * @param chaserCompound Tyre compound of chaser
 * @param chaserTyreAge Laps on chaser's current tyre
 * @param defenderCompound Tyre compound of defender
 * @param defenderTyreAge Laps on defender's current tyre
 * @param chaserSpeed Current speed of chaser (km/h)
 * @param defenderSpeed Current speed of defender (km/h)
 * @param chaserDrsOpen Ground-truth telemetry: is the chaser's DRS actually
 *   open right now (car_data.drs >= 10)? This is a stronger signal than
 *   proximity alone — a car can be within the 1.0s window without DRS
 *   deployed yet (still approaching the detection point, or DRS disabled
 *   under Safety Car/rain), so "eligible" and "active" are not the same
 *   thing.
 * @param hasDrsTelemetry Whether this session's era actually reports DRS
 *   activation via car_data — false for 2026+ (Manual Override Mode
 *   replaced traditional DRS and isn't reported the same way; see
 *   `SessionMeta.hasDrs` in domain/models.ts). When false, `chaserDrsOpen`
 *   can't be trusted, so the proximity estimate is used at reduced
 *   confidence instead of being treated as confirmed.
 */
export function calculateOvertakeProbability(
  gap: number,
  closingRate: number,
  chaserCompound: TyreCompound,
  chaserTyreAge: number,
  defenderCompound: TyreCompound,
  defenderTyreAge: number,
  chaserSpeed: number = 300,
  defenderSpeed: number = 300,
  chaserDrsOpen: boolean = false,
  hasDrsTelemetry: boolean = true
): { probability: number; estLapsToPass: number; drsEligible: boolean; tyreDeltaFactor: number } {
  const safeGap = Number.isFinite(gap) ? Math.max(0, gap) : 1.5;
  const safeClosing = Number.isFinite(closingRate) ? closingRate : 0;

  // If gap is wider than 2.5 seconds, probability is negligible
  if (safeGap > 2.5) {
    return {
      probability: Math.max(1, Math.round((1 / Math.max(0.1, safeGap * 2)) * 10)),
      estLapsToPass: safeClosing > 0 ? Math.min(99, Number((safeGap / safeClosing).toFixed(1))) : 99,
      drsEligible: false,
      tyreDeltaFactor: 0,
    };
  }

  // Side-by-side or already level (gap = 0):
  if (safeGap === 0) {
    return {
      probability: 95,
      estLapsToPass: 0,
      drsEligible: true,
      tyreDeltaFactor: 0,
    };
  }

  // 1. Proximity Factor (0.0 to 1.5)
  // Closer than 1.0s gives huge boost (DRS/Override-Mode threshold)
  const drsEligible = safeGap <= 1.0;
  const gapFactor = Math.max(0, Math.min(1.5, (1.8 - safeGap) / 1.8));

  // 2. Closing Rate Factor (-1.0 to 1.5)
  // Gaining 0.5s per lap is a massive advantage
  const closingFactor = Math.max(-1.0, Math.min(1.5, safeClosing / 0.4));

  // 3. DRS Zone Factor — full weight when telemetry confirms DRS is
  // actually open, half weight when we only know the car is *eligible*
  // (in range but not confirmed active, or this era doesn't report it).
  const drsConfirmedActive = hasDrsTelemetry && chaserDrsOpen;
  const drsFactor = drsConfirmedActive ? 1.0 : drsEligible ? 0.5 : 0.0;

  // 4. Tyre Delta Factor
  // Compound difference + degradation delta (assumed 0.025s per lap age difference)
  const compoundAdvantage = (COMPOUND_PACE_RANK[chaserCompound] || 0) - (COMPOUND_PACE_RANK[defenderCompound] || 0);
  const ageDelta = defenderTyreAge - chaserTyreAge; // positive means defender's tyres are older
  const tyreDeltaFactor = compoundAdvantage + ageDelta * 0.025;

  // 5. Speed trap / straight line advantage
  const safeChaserSpeed = Number.isFinite(chaserSpeed) ? chaserSpeed : 300;
  const safeDefenderSpeed = Number.isFinite(defenderSpeed) ? defenderSpeed : 300;
  const speedDeltaFactor = Math.max(-0.5, Math.min(0.5, (safeChaserSpeed - safeDefenderSpeed) / 15));

  // Weighted Linear Combination -> Logit
  // Base intercept tuned so 1.0s gap with equal pace = ~30%, 0.3s gap with DRS & faster tyres = ~85%
  const logit =
    -1.5 +
    gapFactor * 2.6 +
    closingFactor * 1.5 +
    drsFactor * 1.2 +
    tyreDeltaFactor * 1.0 +
    speedDeltaFactor * 0.5;

  const rawProb = sigmoid(logit) * 100;
  const probability = Math.max(5, Math.min(98, Math.round(rawProb)));

  // Estimated Laps to Pass (finite, non-negative, bounded [0, 99])
  let estLapsToPass = 99;
  if (safeClosing > 0) {
    const effectiveClosing = Math.max(0.04, safeClosing);
    const laps = safeGap / effectiveClosing;
    estLapsToPass = Number.isFinite(laps) ? Math.min(99, Math.max(0, Number(laps.toFixed(1)))) : 99;
  }

  return {
    probability,
    estLapsToPass,
    drsEligible,
    tyreDeltaFactor: Number(tyreDeltaFactor.toFixed(2)),
  };
}

/** Alias kept for callers that read better as "predict" than "calculate". */
export const predictOvertake = calculateOvertakeProbability;

/**
 * Computes the axis-aligned bounding box of a circuit's traced reference
 * points, used to scale/center the track on the canvas. Falls back to a
 * neutral 1000x1000 box when no points are available yet.
 */
export function computeCircuitBounds(points: TrackReferencePoint[]): CircuitBounds {
  if (!points || points.length === 0) {
    return { minX: 0, maxX: 1000, minY: 0, maxY: 1000, width: 1000, height: 1000 };
  }

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (const pt of points) {
    if (pt.x < minX) minX = pt.x;
    if (pt.x > maxX) maxX = pt.x;
    if (pt.y < minY) minY = pt.y;
    if (pt.y > maxY) maxY = pt.y;
  }

  const width = Math.max(1, maxX - minX);
  const height = Math.max(1, maxY - minY);

  return { minX, maxX, minY, maxY, width, height };
}

/**
 * Normalizes a raw world track coordinate (x, y) into canvas/SVG pixel space,
 * preserving aspect ratio and centering within the given padding.
 * @returns `{ u, v }` — the pixel-space coordinate (`v` already Y-flipped for canvas' top-left origin)
 */
export function normalizeTrackCoordinate(
  x: number,
  y: number,
  bounds: CircuitBounds,
  canvasWidth: number,
  canvasHeight: number,
  padding: number = 40
): { u: number; v: number } {
  const innerW = canvasWidth - padding * 2;
  const innerH = canvasHeight - padding * 2;

  // Preserve aspect ratio
  const scale = Math.min(innerW / bounds.width, innerH / bounds.height);

  const offsetX = (canvasWidth - bounds.width * scale) / 2;
  const offsetY = (canvasHeight - bounds.height * scale) / 2;

  const u = offsetX + (x - bounds.minX) * scale;
  // Invert Y because canvas origin (0,0) is top-left while GIS/math Y goes up
  const v = canvasHeight - (offsetY + (y - bounds.minY) * scale);

  return { u, v };
}
