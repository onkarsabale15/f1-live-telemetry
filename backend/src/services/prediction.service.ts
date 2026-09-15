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
   */
  public analyzeBattles(
    grid: DriverLiveState[],
    driversMap: Map<number, DriverInfo>,
    sampleTimeMs: number = Date.now(),
    intervalHistory: IntervalHistory = new Map(),
    hasDrs: boolean = true,
    probabilityHistory: ProbabilityHistory = new Map()
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

      // If within battle window (<= 2.2 seconds and non-negative, including side-by-side gap = 0)
      if (Number.isFinite(gap) && gap >= 0 && gap <= 2.2) {
        const chaserInfo = driversMap.get(chaserState.driverNumber);
        const defenderInfo = driversMap.get(defenderState.driverNumber);

        if (chaserInfo && defenderInfo) {
          const { probability: rawProbability, estLapsToPass, drsEligible, tyreDeltaFactor } =
            calculateOvertakeProbability(
              gap,
              closingRate,
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
          if (probability >= 70 || (drsEligible && closingRate > 0.2)) {
            confidence = 'HIGH';
          } else if (probability < 30) {
            confidence = 'LOW';
          }

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
            closingRate,
            drsEligible,
            tyreDeltaFactor,
            probability,
            estLapsToPass,
            confidence,
            drsActive: chaserState.drs,
            speedDelta: chaserState.speed - defenderState.speed,
          });
        }
      }
    }

    // Sort by battle excitement: highest overtake probability first
    return battles.sort((a, b) => b.probability - a.probability);
  }
}

export const overtakePredictionService = new OvertakePredictionService();
export default overtakePredictionService;
