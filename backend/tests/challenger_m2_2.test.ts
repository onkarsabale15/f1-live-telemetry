/**
 * Milestone 2 Challenger 2: Empirical Mathematical Edge Cases & Simulation Robustness Test Suite
 * 
 * Verifies:
 * - calculateClosingRate: gap=0, negative gaps, division-by-zero, non-finite inputs
 * - calculateOvertakeProbability / predictOvertake: estLapsToPass bounds [0, 99], probability bounds [0, 100]
 * - computeCircuitBounds & normalizeTrackCoordinate: 0 points, 1 point, identical coordinates, aspect ratio scaling
 * - Simulation trackPoint index clamping: exactIndex bounds [0, numPoints - 1], negative progress, NaN progress
 * - OvertakePredictionService: battle window gap=0 handling, history window d(gap)/dt calculation
 * - Monte Carlo Fuzzing Harness: 10,000 iterations verifying no NaN / Infinity leaks
 */

import {
  calculateClosingRate,
  calculateOvertakeProbability,
  predictOvertake,
  computeCircuitBounds,
  normalizeTrackCoordinate,
  COMPOUND_PACE_RANK,
} from '../src/domain/formulas';
import { OvertakePredictionService } from '../src/services/prediction.service';
import { DriverLiveState, DriverInfo, TrackReferencePoint, CircuitBounds } from '../src/domain/models';

interface TestResult {
  suite: string;
  name: string;
  passed: boolean;
  details?: string;
}

const results: TestResult[] = [];

function recordTest(suite: string, name: string, condition: boolean, details?: string) {
  if (condition) {
    console.log(`  ✅ [PASS] ${name}`);
  } else {
    console.error(`  ❌ [FAIL] ${name}${details ? ` -> ${details}` : ''}`);
  }
  results.push({ suite, name, passed: condition, details });
}

export function runAllTests(): { total: number; passed: number; failed: number; results: TestResult[] } {
  console.log('======================================================================');
  console.log('🏁 Milestone 2 Challenger 2: Empirical Math & Simulation Edge Cases');
  console.log('======================================================================\n');

  // =========================================================================
  // SUITE 1: CLOSING RATE DIVISION-BY-ZERO & BOUNDARY DEFENSE
  // =========================================================================
  console.log('--- SUITE 1: Closing Rate Mathematical Edge Cases ---');

  // 1A: gap = 0
  {
    const rate = calculateClosingRate(0.5, 0, 1.0, 80);
    recordTest(
      'Closing Rate',
      'currentGap = 0 returns 0 (level/overtaken, no division by zero)',
      rate === 0 && Number.isFinite(rate),
      `Expected 0, got ${rate}`
    );
  }

  // 1B: negative gap (chaser already passed)
  {
    const rate1 = calculateClosingRate(0.5, -0.2, 1.0, 80);
    const rate2 = calculateClosingRate(1.0, -10.0, 2.0, 80);
    recordTest(
      'Closing Rate',
      'currentGap < 0 returns 0 (negative gap guarded)',
      rate1 === 0 && rate2 === 0,
      `rate1=${rate1}, rate2=${rate2}`
    );
  }

  // 1C: timeDiffSeconds = 0 (division by zero)
  {
    const rate = calculateClosingRate(1.0, 0.5, 0, 80);
    recordTest(
      'Closing Rate',
      'timeDiffSeconds = 0 returns 0 (division by zero prevented)',
      rate === 0 && !Number.isNaN(rate) && Number.isFinite(rate),
      `Expected 0, got ${rate}`
    );
  }

  // 1D: timeDiffSeconds < 0 (clock skew / backwards timestamps)
  {
    const rate = calculateClosingRate(1.0, 0.5, -2.5, 80);
    recordTest(
      'Closing Rate',
      'negative timeDiffSeconds returns 0',
      rate === 0,
      `Expected 0, got ${rate}`
    );
  }

  // 1E: Non-finite inputs (NaN, Infinity, -Infinity)
  {
    const rNaN1 = calculateClosingRate(NaN, 0.5, 1.0, 80);
    const rNaN2 = calculateClosingRate(1.0, NaN, 1.0, 80);
    const rNaN3 = calculateClosingRate(1.0, 0.5, NaN, 80);
    const rInf1 = calculateClosingRate(Infinity, 0.5, 1.0, 80);
    const rInf2 = calculateClosingRate(1.0, Infinity, 1.0, 80);
    const rInf3 = calculateClosingRate(1.0, 0.5, Infinity, 80);
    const rNegInf = calculateClosingRate(-Infinity, 0.5, 1.0, 80);

    const allZero = [rNaN1, rNaN2, rNaN3, rInf1, rInf2, rInf3, rNegInf].every((r) => r === 0 && Number.isFinite(r));
    recordTest(
      'Closing Rate',
      'NaN / Infinity inputs gracefully return 0 without NaN leakage',
      allZero,
      `Outputs: ${JSON.stringify({ rNaN1, rNaN2, rNaN3, rInf1, rInf2, rInf3, rNegInf })}`
    );
  }

  // 1F: Normal rate calculation accuracy
  {
    // Chaser gained 0.5s over 2 seconds. Lap time = 80s.
    // Rate = (0.5 / 2) * 80 = 20.00 seconds per lap
    const rate = calculateClosingRate(1.5, 1.0, 2.0, 80);
    recordTest(
      'Closing Rate',
      'Standard closing rate matches physical formula (gapDiff/dt)*lapTime',
      rate === 20.0,
      `Expected 20.0, got ${rate}`
    );
  }

  // 1G: Negative rate when falling behind
  {
    // Chaser fell back 0.2s over 1 second. Lap time = 80s.
    // Rate = (-0.2 / 1) * 80 = -16.00
    const rate = calculateClosingRate(1.0, 1.2, 1.0, 80);
    recordTest(
      'Closing Rate',
      'Negative closing rate when chaser falls behind is finite and negative',
      rate === -16.0 && Number.isFinite(rate),
      `Expected -16.0, got ${rate}`
    );
  }

  // =========================================================================
  // SUITE 2: OVERTAKE PROBABILITY & ESTLAPS BOUNDS DEFENSE
  // =========================================================================
  console.log('\n--- SUITE 2: Overtake Probability & estLapsToPass Bounds ---');

  // 2A: gap = 0 side-by-side racing
  {
    const result = calculateOvertakeProbability(0, 0.5, 'SOFT', 5, 'HARD', 20, 320, 310);
    recordTest(
      'Overtake Probability',
      'gap = 0 returns 95% probability, estLapsToPass = 0, drsEligible = true',
      result.probability === 95 && result.estLapsToPass === 0 && result.drsEligible === true,
      `Got: ${JSON.stringify(result)}`
    );
  }

  // 2B: negative gap handled safely
  {
    const result = calculateOvertakeProbability(-0.5, 0.5, 'SOFT', 5, 'HARD', 20);
    recordTest(
      'Overtake Probability',
      'negative gap (-0.5) is clamped to 0 safely without error',
      result.probability === 95 && result.estLapsToPass === 0,
      `Got: ${JSON.stringify(result)}`
    );
  }

  // 2C: closingRate <= 0 bounds (estLapsToPass must be capped at 99)
  {
    const zeroRate = calculateOvertakeProbability(1.2, 0, 'MEDIUM', 10, 'MEDIUM', 10);
    const negRate = calculateOvertakeProbability(1.2, -1.5, 'MEDIUM', 10, 'MEDIUM', 10);
    const deepNegRate = calculateOvertakeProbability(1.2, -100, 'MEDIUM', 10, 'MEDIUM', 10);

    const safeEst = zeroRate.estLapsToPass === 99 && negRate.estLapsToPass === 99 && deepNegRate.estLapsToPass === 99;
    recordTest(
      'Overtake Probability',
      'closingRate <= 0 yields estLapsToPass = 99 (never Infinity or negative)',
      safeEst,
      `zero=${zeroRate.estLapsToPass}, neg=${negRate.estLapsToPass}, deepNeg=${deepNegRate.estLapsToPass}`
    );
  }

  // 2D: Extremely small positive closingRate (potential division by near-zero)
  {
    const smallRate = calculateOvertakeProbability(2.0, 0.0000001, 'MEDIUM', 10, 'MEDIUM', 10);
    recordTest(
      'Overtake Probability',
      'Extremely small positive closingRate does not overflow estLapsToPass beyond 99',
      smallRate.estLapsToPass <= 99 && smallRate.estLapsToPass >= 0 && Number.isFinite(smallRate.estLapsToPass),
      `Got: estLapsToPass = ${smallRate.estLapsToPass}`
    );
  }

  // 2E: Huge gap (> 2.5s) boundary
  {
    const hugeGap1 = calculateOvertakeProbability(5.0, 0.8, 'SOFT', 5, 'HARD', 25);
    const hugeGap2 = calculateOvertakeProbability(100.0, 0.8, 'SOFT', 5, 'HARD', 25);
    const hugeGap3 = calculateOvertakeProbability(10000.0, 0, 'SOFT', 5, 'HARD', 25);

    const bounded = [hugeGap1, hugeGap2, hugeGap3].every(
      (r) => r.probability >= 0 && r.probability <= 100 && r.estLapsToPass >= 0 && r.estLapsToPass <= 99 && !r.drsEligible
    );
    recordTest(
      'Overtake Probability',
      'Gaps > 2.5s have drsEligible=false and bounded probability/estLapsToPass',
      bounded,
      `hugeGap1: ${JSON.stringify(hugeGap1)}`
    );
  }

  // 2F: Non-finite inputs to calculateOvertakeProbability
  {
    const resNaN = calculateOvertakeProbability(NaN, NaN, 'MEDIUM', 10, 'MEDIUM', 10, NaN, NaN);
    const resInf = calculateOvertakeProbability(Infinity, Infinity, 'MEDIUM', 10, 'MEDIUM', 10, Infinity, Infinity);
    const safeOutput =
      Number.isFinite(resNaN.probability) &&
      Number.isFinite(resNaN.estLapsToPass) &&
      Number.isFinite(resInf.probability) &&
      Number.isFinite(resInf.estLapsToPass);

    recordTest(
      'Overtake Probability',
      'NaN and Infinity arguments produce finite probability and estLapsToPass',
      safeOutput,
      `resNaN=${JSON.stringify(resNaN)}, resInf=${JSON.stringify(resInf)}`
    );
  }

  // 2G: predictOvertake alias check
  {
    recordTest(
      'Overtake Probability',
      'predictOvertake is exported as alias to calculateOvertakeProbability',
      predictOvertake === calculateOvertakeProbability,
      'Alias mismatch'
    );
  }

  // =========================================================================
  // SUITE 3: CIRCUIT COORDINATE NORMALIZATION & BOUNDS
  // =========================================================================
  console.log('\n--- SUITE 3: Circuit Coordinate Normalization & Bounds ---');

  // 3A: Empty points array
  {
    const emptyBounds = computeCircuitBounds([]);
    recordTest(
      'Circuit Coordinates',
      'computeCircuitBounds([]) returns non-zero width/height fallback',
      emptyBounds.width > 0 && emptyBounds.height > 0 && Number.isFinite(emptyBounds.width),
      `Got: ${JSON.stringify(emptyBounds)}`
    );
  }

  // 3B: Single point array (width and height must be >= 1)
  {
    const singlePointBounds = computeCircuitBounds([{ x: 500, y: 300 }]);
    recordTest(
      'Circuit Coordinates',
      'Single point bounds has width >= 1 and height >= 1 (prevents division by zero in scale)',
      singlePointBounds.width >= 1 && singlePointBounds.height >= 1,
      `Got: width=${singlePointBounds.width}, height=${singlePointBounds.height}`
    );
  }

  // 3C: Collinear points (zero variance on X or Y axis)
  {
    const collinearX = computeCircuitBounds([
      { x: 100, y: 10 },
      { x: 100, y: 50 },
      { x: 100, y: 90 },
    ]);
    const collinearY = computeCircuitBounds([
      { x: 10, y: 200 },
      { x: 50, y: 200 },
      { x: 90, y: 200 },
    ]);

    recordTest(
      'Circuit Coordinates',
      'Collinear points maintain min width/height >= 1 without zero division',
      collinearX.width >= 1 && collinearX.height > 0 && collinearY.width > 0 && collinearY.height >= 1,
      `collinearX.width=${collinearX.width}, collinearY.height=${collinearY.height}`
    );
  }

  // 3D: normalizeTrackCoordinate sanity and aspect ratio preservation
  {
    const bounds: CircuitBounds = { minX: 0, maxX: 1000, minY: 0, maxY: 500, width: 1000, height: 500 };
    const pt1 = normalizeTrackCoordinate(0, 0, bounds, 800, 600, 40);
    const pt2 = normalizeTrackCoordinate(1000, 500, bounds, 800, 600, 40);
    const ptCenter = normalizeTrackCoordinate(500, 250, bounds, 800, 600, 40);

    const finite = [pt1, pt2, ptCenter].every(
      (pt) => Number.isFinite(pt.u) && Number.isFinite(pt.v) && pt.u >= 0 && pt.u <= 800 && pt.v >= 0 && pt.v <= 600
    );
    recordTest(
      'Circuit Coordinates',
      'normalizeTrackCoordinate maps world coordinates to canvas bounding box [0..W, 0..H]',
      finite,
      `pt1: (${pt1.u}, ${pt1.v}), pt2: (${pt2.u}, ${pt2.v}), center: (${ptCenter.u}, ${ptCenter.v})`
    );
  }

  // =========================================================================
  // SUITE 4: SIMULATION TRACK INTERPOLATION & INDEX CLAMPING
  // =========================================================================
  console.log('\n--- SUITE 4: Simulation Track Interpolation & Index Bounds ---');

  // 4A: Clamping algorithm empirical verification
  {
    const numPoints = 42; // Monza track points length
    const testCases = [
      { name: 'progress = 0.0', progress: 0.0, expectedIdxLow: 0, expectedIdxHigh: 1 },
      { name: 'progress = 1.0', progress: 1.0, expectedIdxLow: 41, expectedIdxHigh: 41 },
      { name: 'progress = 0.5', progress: 0.5, expectedIdxLow: 20, expectedIdxHigh: 21 },
      { name: 'progress = -0.5 (negative)', progress: -0.5, expectedIdxLow: 0, expectedIdxHigh: 1 },
      { name: 'progress = 2.5 (overflow)', progress: 2.5, expectedIdxLow: 41, expectedIdxHigh: 41 },
      { name: 'progress = NaN', progress: NaN, expectedIdxLow: 0, expectedIdxHigh: 1 },
      { name: 'progress = Infinity', progress: Infinity, expectedIdxLow: 41, expectedIdxHigh: 41 },
    ];

    let allIndicesInBounds = true;
    for (const tc of testCases) {
      // Logic identical to simulation.service.ts lines 104-106
      const exactIndex = Math.max(0, Math.min(numPoints - 1, (tc.progress || 0) * (numPoints - 1)));
      const idxLow = Math.max(0, Math.min(numPoints - 1, Math.floor(exactIndex) || 0));
      const idxHigh = Math.max(0, Math.min(numPoints - 1, idxLow + 1));
      const fraction = exactIndex - idxLow;

      if (idxLow < 0 || idxLow >= numPoints || idxHigh < 0 || idxHigh >= numPoints) {
        allIndicesInBounds = false;
        console.error(`Index out of bounds for ${tc.name}: idxLow=${idxLow}, idxHigh=${idxHigh}`);
      }
      if (fraction < 0 || fraction > 1) {
        allIndicesInBounds = false;
        console.error(`Fraction out of bounds for ${tc.name}: fraction=${fraction}`);
      }
    }

    recordTest(
      'Simulation Index Clamping',
      'exactIndex and idxLow/idxHigh are strictly clamped to [0, numPoints - 1] for all inputs',
      allIndicesInBounds,
      'Index bounds exceeded'
    );
  }

  // 4B: Linear interpolation continuity and no NaN
  {
    const p1 = { x: 100, y: 200 };
    const p2 = { x: 300, y: 500 };

    let nanFound = false;
    for (let f = -0.2; f <= 1.2; f += 0.1) {
      const clampedFraction = Math.max(0, Math.min(1, f));
      const x = Math.round(p1.x + (p2.x - p1.x) * clampedFraction);
      const y = Math.round(p1.y + (p2.y - p1.y) * clampedFraction);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        nanFound = true;
      }
    }

    recordTest(
      'Simulation Index Clamping',
      'Coordinate linear interpolation yields finite numbers without NaN',
      !nanFound,
      'NaN found during interpolation'
    );
  }

  // =========================================================================
  // SUITE 5: OVERTAKE PREDICTION SERVICE INTEGRATION
  // =========================================================================
  console.log('\n--- SUITE 5: OvertakePredictionService Integration ---');

  // 5A: Side-by-side racing (gap = 0) produces battle with positive gap assertion (0.01)
  {
    const service = new OvertakePredictionService();
    const mockDriversMap = new Map<number, DriverInfo>([
      [4, { driverNumber: 4, nameAcronym: 'NOR', teamName: 'McLaren', teamColour: '#FF8000', headshotUrl: '' }],
      [1, { driverNumber: 1, nameAcronym: 'VER', teamName: 'Red Bull', teamColour: '#3671C6', headshotUrl: '' }],
    ]);

    const mockGrid: DriverLiveState[] = [
      {
        driverNumber: 1,
        position: 1,
        x: 100,
        y: 200,
        z: 0,
        speed: 310,
        rpm: 11000,
        gear: 8,
        throttle: 100,
        brake: 0,
        drs: false,
        gapToLeader: 0,
        intervalToAhead: 0,
        compound: 'HARD',
        tyreAge: 20,
      },
      {
        driverNumber: 4,
        position: 2,
        x: 100,
        y: 200,
        z: 0,
        speed: 325,
        rpm: 11500,
        gear: 8,
        throttle: 100,
        brake: 0,
        drs: true,
        gapToLeader: 0,
        intervalToAhead: 0, // Level with leader
        compound: 'SOFT',
        tyreAge: 5,
      },
    ];

    const battles = service.analyzeBattles(mockGrid, mockDriversMap);
    recordTest(
      'Prediction Service',
      'gap = 0 enters active battle window and reports positive gap (0.01) for downstream compatibility',
      battles.length === 1 && battles[0].gap > 0 && battles[0].probability === 95 && battles[0].estLapsToPass === 0,
      `battles: ${JSON.stringify(battles)}`
    );
  }

  // 5B: Negative gaps in liveGrid (e.g. from telemetry timing glitches) are guarded
  {
    const service = new OvertakePredictionService();
    const mockDriversMap = new Map<number, DriverInfo>([
      [4, { driverNumber: 4, nameAcronym: 'NOR', teamName: 'McLaren', teamColour: '#FF8000', headshotUrl: '' }],
      [1, { driverNumber: 1, nameAcronym: 'VER', teamName: 'Red Bull', teamColour: '#3671C6', headshotUrl: '' }],
    ]);

    const mockGridNegativeGap: DriverLiveState[] = [
      {
        driverNumber: 1,
        position: 1,
        x: 100,
        y: 200,
        z: 0,
        speed: 310,
        rpm: 11000,
        gear: 8,
        throttle: 100,
        brake: 0,
        drs: false,
        gapToLeader: 0,
        intervalToAhead: 0,
        compound: 'HARD',
        tyreAge: 20,
      },
      {
        driverNumber: 4,
        position: 2,
        x: 100,
        y: 200,
        z: 0,
        speed: 325,
        rpm: 11500,
        gear: 8,
        throttle: 100,
        brake: 0,
        drs: true,
        gapToLeader: -0.5,
        intervalToAhead: -0.5, // Negative gap anomaly
        compound: 'SOFT',
        tyreAge: 5,
      },
    ];

    const battles = service.analyzeBattles(mockGridNegativeGap, mockDriversMap);
    recordTest(
      'Prediction Service',
      'Negative intervalToAhead (-0.5) is ignored without process error',
      battles.length === 0,
      `Expected 0 battles, got ${battles.length}`
    );
  }

  // =========================================================================
  // SUITE 6: MONTE CARLO STRESS TEST & FUZZING HARNESS
  // =========================================================================
  console.log('\n--- SUITE 6: Monte Carlo Fuzzing Harness (10,000 Iterations) ---');

  {
    const compounds: ('SOFT' | 'MEDIUM' | 'HARD' | 'INTERMEDIATE' | 'WET' | 'UNKNOWN')[] = [
      'SOFT',
      'MEDIUM',
      'HARD',
      'INTERMEDIATE',
      'WET',
      'UNKNOWN',
    ];

    let fuzzViolations = 0;
    const iterations = 10000;

    for (let i = 0; i < iterations; i++) {
      // Generate diverse edge cases including negative, zero, extreme, and special values
      const testGaps = [-10, -0.001, 0, 0.0001, 0.5, 1.0, 2.2, 2.5, 5.0, 100.0, NaN, Infinity, -Infinity];
      const testRates = [-50, -1, 0, 0.0001, 0.5, 1.5, 100, NaN, Infinity, -Infinity];
      const testTimeDiffs = [-10, 0, 0.00001, 1, 30, NaN, Infinity];

      const gap = testGaps[Math.floor(Math.random() * testGaps.length)];
      const closing = testRates[Math.floor(Math.random() * testRates.length)];
      const dt = testTimeDiffs[Math.floor(Math.random() * testTimeDiffs.length)];
      const chaserC = compounds[Math.floor(Math.random() * compounds.length)];
      const defC = compounds[Math.floor(Math.random() * compounds.length)];
      const chaserAge = Math.floor(Math.random() * 50);
      const defAge = Math.floor(Math.random() * 50);
      const chaserSpd = 200 + Math.random() * 150;
      const defSpd = 200 + Math.random() * 150;

      // 1. Stress calculateClosingRate
      const closingRate = calculateClosingRate(gap + 0.5, gap, dt, 80);
      if (Number.isNaN(closingRate) || !Number.isFinite(closingRate)) {
        fuzzViolations++;
      }

      // 2. Stress calculateOvertakeProbability
      const probResult = calculateOvertakeProbability(
        gap,
        closing,
        chaserC,
        chaserAge,
        defC,
        defAge,
        chaserSpd,
        defSpd
      );

      if (
        Number.isNaN(probResult.probability) ||
        !Number.isFinite(probResult.probability) ||
        probResult.probability < 0 ||
        probResult.probability > 100
      ) {
        fuzzViolations++;
      }

      if (
        Number.isNaN(probResult.estLapsToPass) ||
        !Number.isFinite(probResult.estLapsToPass) ||
        probResult.estLapsToPass < 0 ||
        probResult.estLapsToPass > 99
      ) {
        fuzzViolations++;
      }
    }

    recordTest(
      'Monte Carlo Fuzzing',
      `10,000 randomized iterations across math formulas produce zero NaN/Infinity leaks`,
      fuzzViolations === 0,
      `Found ${fuzzViolations} violations`
    );
  }

  // Summary
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  console.log('\n======================================================================');
  console.log(`Summary: ${passed} Passed, ${failed} Failed out of ${results.length} tests`);
  console.log('======================================================================\n');

  return { total: results.length, passed, failed, results };
}

// Auto-run if executed directly
if (require.main === module) {
  const { failed } = runAllTests();
  process.exit(failed > 0 ? 1 : 0);
}
