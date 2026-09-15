import { DriverLiveState, DriverInfo, OvertakeBattle } from '../domain/models';
import { calculateOvertakeProbability, calculateClosingRateTrend } from '../domain/formulas';

export type IntervalHistory = Map<number, { timestamp: number; interval: number }[]>;

/** Last smoothed probability per battle (keyed by `${chaserNumber}-${defenderNumber}`), owned by the caller — see `analyzeBattles`' probabilityHistory param. */
export type ProbabilityHistory = Map<string, number>;

// Exponential-moving-average weight applied to each tick's freshly computed
// probability against the previous smoothed value. Lower = steadier/less
// jittery display, higher = more responsive to a sudden real change (e.g.
// a lockup). 0.35 settles a step change in ~4-5 ticks while still damping
// single-sample noise from sparse OpenF1 gap updates.
const PROBABILITY_SMOOTHING_ALPHA = 0.35;

// How much of the "closing rate" fed into the probability model comes from
// the interval-history regression (reacts fast, but noisy — a single lapped
// car or one sparse sample can move it) vs. the lap-time pace delta (reacts
// only once per lap, but reflects genuinely sustained pace — the same
// signal broadcast "closing at X/lap" graphics are built from). Weighted
// toward pace on purpose: a car that is simply faster right now is a much
// more reliable predictor than one noisy gap sample.
const INTERVAL_TREND_WEIGHT = 0.4;
const PACE_DELTA_WEIGHT = 0.6;

// Only battles with a real chance of actually happening are worth
// surfacing — a pair merely sitting inside the scanning window is traffic,
// not a fight a broadcast would flag.
const HIGH_PROBABILITY_THRESHOLD = 70;

// Upper bound on how many battles are surfaced at once, sorted by
// probability — a safety net for the rare case where many pairs clear the
// probability bar simultaneously (e.g. a chaotic multi-car photo finish).
const MAX_SURFACED_BATTLES = 8;

/** Turns a grid of driver states into a ranked list of predicted overtake opportunities between adjacent cars. */
export class OvertakePredictionService {
  /**
   * Analyzes current live grid and calculates overtake predictions for active battles.
   *
   * @param sampleTimeMs The timestamp this snapshot represents — wall-clock
   *   `Date.now()` for a live session, or the replay/scrub position (race
   *   time, ms) for a completed session. Using wall-clock time for replay
   *   would divide a gap change measured in RACE time by an elapsed time
   *   measured in REAL time (e.g. a scrub jump of 20 race-minutes sampled
   *   1 real-second apart), producing nonsensical closing rates.
   * @param intervalHistory Recent gap-to-ahead samples per chaser, owned by
   *   the caller (not this service) — each live session and each
   *   independent replay viewer needs its own history, since interleaving
   *   two different timelines' samples (e.g. two clients scrubbing the same
   *   session at different positions) would corrupt the closing-rate trend.
   * @param hasDrs Whether this session's era reports DRS activation via
   *   telemetry (false for 2026+ Manual Override Mode) — see
   *   `calculateOvertakeProbability`'s `hasDrsTelemetry` param.
   * @param probabilityHistory Last smoothed probability per battle, owned by
   *   the caller for the same reason as `intervalHistory` — keeps the
   *   displayed probability from jittering tick to tick without mixing
   *   state across independent viewers. Clear it whenever the caller also
   *   clears `intervalHistory` (e.g. on a replay seek), since a smoothed
   *   value from a different point in the race is stale, not a trend.
   * @param lapTimes Each driver's most recently completed lap time (seconds)
   *   as of this snapshot — see `computeLapTimesAtLap` in
   *   replay-session.service.ts. Unlike `intervalHistory`/`probabilityHistory`
   *   this isn't cross-tick state the caller needs to own; it's recomputed
   *   fresh from the already-cached laps data every call.
   */
  public analyzeBattles(
    grid: DriverLiveState[],
    driversMap: Map<number, DriverInfo>,
    sampleTimeMs: number = Date.now(),
    intervalHistory: IntervalHistory = new Map(),
    hasDrs: boolean = true,
    probabilityHistory: ProbabilityHistory = new Map(),
    lapTimes: Map<number, number> = new Map()
  ): OvertakeBattle[] {
    const battles: OvertakeBattle[] = [];
    const now = sampleTimeMs;

    // Sort grid by track position (1st, 2nd, 3rd, ...)
    const sortedGrid = [...grid].sort((a, b) => a.position - b.position);

    for (let i = 1; i < sortedGrid.length; i++) {
      const chaserState = sortedGrid[i];
      const defenderState = sortedGrid[i - 1];

      const gap = chaserState.intervalToAhead;

      // Track interval history to calculate closing rate d(gap)/dt
      let history = intervalHistory.get(chaserState.driverNumber);
      if (!history) {
        history = [];
        intervalHistory.set(chaserState.driverNumber, history);
      }

      history.push({ timestamp: now, interval: gap });
      // Keep only last 30 seconds of history
      if (history.length > 30) history.shift();

      // Compute closing rate via regression over the whole history window
      // (not just a two-point diff) so a single noisy gap sample can't flip
      // the sign of the trend — see calculateClosingRateTrend's doc.
      let closingRate = 0;
      if (history.length >= 5) {
        closingRate = calculateClosingRateTrend(history, 80);
      }

      // Blend in actual lap-time pace, when both drivers have a completed
      // lap to compare — this is the same "who's genuinely faster right
      // now" signal a broadcast's overtake countdown is built from, and
      // it's far more stable than the interval trend alone (which reacts to
      // one lapped car or one noisy sample just as readily as a real pace
      // difference).
      const chaserLapTime = lapTimes.get(chaserState.driverNumber);
      const defenderLapTime = lapTimes.get(defenderState.driverNumber);
      const paceDeltaPerLap =
        chaserLapTime != null &&
        defenderLapTime != null &&
        Number.isFinite(chaserLapTime) &&
        Number.isFinite(defenderLapTime)
          ? Number((defenderLapTime - chaserLapTime).toFixed(3))
          : undefined;
      const effectiveClosingRate =
        paceDeltaPerLap != null
          ? Number((closingRate * INTERVAL_TREND_WEIGHT + paceDeltaPerLap * PACE_DELTA_WEIGHT).toFixed(2))
          : closingRate;

      // If within battle window (<= 2.2 seconds and non-negative, including side-by-side gap = 0)
      if (Number.isFinite(gap) && gap >= 0 && gap <= 2.2) {
        const chaserInfo = driversMap.get(chaserState.driverNumber);
        const defenderInfo = driversMap.get(defenderState.driverNumber);

        if (chaserInfo && defenderInfo) {
          const { probability: rawProbability, estLapsToPass, drsEligible, tyreDeltaFactor } =
            calculateOvertakeProbability(
              gap,
              effectiveClosingRate,
              chaserState.compound,
              chaserState.tyreAge,
              defenderState.compound,
              defenderState.tyreAge,
              chaserState.speed,
              defenderState.speed,
              chaserState.drs,
              hasDrs
            );

          const battleId = `${chaserState.driverNumber}-${defenderState.driverNumber}`;

          // Smooth the displayed probability against its own last value
          // (EMA) so it settles into a trend instead of jumping around on
          // every tick's fresh (and individually noisy) inputs.
          const prevSmoothed = probabilityHistory.get(battleId);
          const probability =
            prevSmoothed == null
              ? rawProbability
              : Math.round(prevSmoothed + PROBABILITY_SMOOTHING_ALPHA * (rawProbability - prevSmoothed));
          probabilityHistory.set(battleId, probability);

          let confidence: 'HIGH' | 'MEDIUM' | 'LOW' = 'MEDIUM';
          if (probability >= 70 || (drsEligible && effectiveClosingRate > 0.2)) {
            confidence = 'HIGH';
          } else if (probability < 30) {
            confidence = 'LOW';
          }

          // Convert the lap-count estimate into a wall-clock one too — "X
          // laps" and "~Ys" are the same broadcast-style prediction, just in
          // the two units viewers actually think in. Uses the pair's own
          // recent lap times when known, since a driver's average pace can
          // be meaningfully faster or slower than the 80s fallback the laps
          // formula otherwise assumes.
          const referenceLapTimeSeconds =
            chaserLapTime != null && defenderLapTime != null ? (chaserLapTime + defenderLapTime) / 2 : 80;
          const estTimeToPassSeconds =
            estLapsToPass < 20 ? Number((estLapsToPass * referenceLapTimeSeconds).toFixed(1)) : undefined;

          battles.push({
            battleId,
            chaser: {
              driverNumber: chaserState.driverNumber,
              code: chaserInfo.nameAcronym,
              team: chaserInfo.teamName,
              teamColor: chaserInfo.teamColour,
              compound: chaserState.compound,
              tyreAge: chaserState.tyreAge,
            },
            defender: {
              driverNumber: defenderState.driverNumber,
              code: defenderInfo.nameAcronym,
              team: defenderInfo.teamName,
              teamColor: defenderInfo.teamColour,
              compound: defenderState.compound,
              tyreAge: defenderState.tyreAge,
            },
            gap: gap <= 0 ? 0.01 : Number(gap.toFixed(2)),
            closingRate: effectiveClosingRate,
            drsEligible,
            tyreDeltaFactor,
            probability,
            estLapsToPass,
            confidence,
            drsActive: chaserState.drs,
            speedDelta: chaserState.speed - defenderState.speed,
            paceDeltaPerLap,
            estTimeToPassSeconds,
          });
        }
      }
    }

    // Only surface battles with a genuine (>70%) chance of an overtake —
    // the rest is capped as a safety net in case many pairs clear that bar
    // at once.
    const highProbabilityBattles = battles.filter((b) => b.probability > HIGH_PROBABILITY_THRESHOLD);

    return highProbabilityBattles.sort((a, b) => b.probability - a.probability).slice(0, MAX_SURFACED_BATTLES);
  }
}

export const overtakePredictionService = new OvertakePredictionService();
export default overtakePredictionService;
