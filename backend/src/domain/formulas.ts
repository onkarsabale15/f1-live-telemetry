import { TyreCompound, CircuitBounds, TrackReferencePoint } from './models';

// Tyre compound relative pace offset (seconds per lap theoretical advantage)
export const COMPOUND_PACE_RANK: Record<TyreCompound, number> = {
  SOFT: 0.8,
  MEDIUM: 0.4,
  HARD: 0.0,
  INTERMEDIATE: 0.0,
  WET: -0.5,
  UNKNOWN: 0.0,
};

// Sigmoid squashing function
export function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z));
}

/**
 * Calculates closing rate (seconds gained per lap) between chaser and defender
 * Protects against gap <= 0, division by zero, and non-finite values.
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
 * Calculates overtake probability based on live track metrics
 * @param gap Current gap in seconds to the car ahead
 * @param closingRate Rate at which chaser is catching (seconds per lap)
 * @param chaserCompound Tyre compound of chaser
 * @param chaserTyreAge Laps on chaser's current tyre
 * @param defenderCompound Tyre compound of defender
 * @param defenderTyreAge Laps on defender's current tyre
 * @param chaserSpeed Current speed of chaser (km/h)
 * @param defenderSpeed Current speed of defender (km/h)
 */
export function calculateOvertakeProbability(
  gap: number,
  closingRate: number,
  chaserCompound: TyreCompound,
  chaserTyreAge: number,
  defenderCompound: TyreCompound,
  defenderTyreAge: number,
  chaserSpeed: number = 300,
  defenderSpeed: number = 300
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
  // Closer than 1.0s gives huge boost (DRS threshold)
  const drsEligible = safeGap <= 1.0;
  const gapFactor = Math.max(0, Math.min(1.5, (1.8 - safeGap) / 1.8));

  // 2. Closing Rate Factor (-1.0 to 1.5)
  // Gaining 0.5s per lap is a massive advantage
  const closingFactor = Math.max(-1.0, Math.min(1.5, safeClosing / 0.4));

  // 3. DRS Zone Factor
  const drsFactor = drsEligible ? 1.0 : 0.0;

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

export const predictOvertake = calculateOvertakeProbability;

/**
 * Computes bounding box for circuit coordinates
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
 * Normalizes raw world track coordinate (x, y) to a standard SVG/Canvas coordinate space [padding, size-padding]
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
