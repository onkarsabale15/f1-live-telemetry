import { DriverLiveState, DriverInfo, OvertakeBattle } from '../domain/models';
import { calculateOvertakeProbability, calculateClosingRate } from '../domain/formulas';

export type IntervalHistory = Map<number, { timestamp: number; interval: number }[]>;

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
   */
  public analyzeBattles(
    grid: DriverLiveState[],
    driversMap: Map<number, DriverInfo>,
    sampleTimeMs: number,
    intervalHistory: IntervalHistory
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

      // Compute closing rate (seconds gained per lap / per 30s)
      let closingRate = 0;
      if (history.length >= 5) {
        const oldest = history[0];
        const timeDiffSeconds = Math.max(1, (now - oldest.timestamp) / 1000);
        closingRate = calculateClosingRate(oldest.interval, gap, timeDiffSeconds, 80);
      }

      // If within battle window (<= 2.2 seconds and non-negative, including side-by-side gap = 0)
      if (Number.isFinite(gap) && gap >= 0 && gap <= 2.2) {
        const chaserInfo = driversMap.get(chaserState.driverNumber);
        const defenderInfo = driversMap.get(defenderState.driverNumber);

        if (chaserInfo && defenderInfo) {
          const { probability, estLapsToPass, drsEligible, tyreDeltaFactor } = calculateOvertakeProbability(
            gap,
            closingRate,
            chaserState.compound,
            chaserState.tyreAge,
            defenderState.compound,
            defenderState.tyreAge,
            chaserState.speed,
            defenderState.speed
          );

          let confidence: 'HIGH' | 'MEDIUM' | 'LOW' = 'MEDIUM';
          if (probability >= 70 || (drsEligible && closingRate > 0.2)) {
            confidence = 'HIGH';
          } else if (probability < 30) {
            confidence = 'LOW';
          }

          battles.push({
            battleId: `${chaserState.driverNumber}-${defenderState.driverNumber}`,
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
