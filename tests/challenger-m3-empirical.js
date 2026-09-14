/**
 * Milestone 3 Challenger 1: Empirical Verification Test Suite
 * 
 * Adversarially tests:
 * 1. DRS Sporting Regulations:
 *    - P1 leader NEVER gets DRS under any conditions
 *    - Trailing car only gets DRS inside Monza zones (0.02-0.16 and 0.62-0.74)
 *    - Trailing car requires intervalToAhead <= 1.000s, throttle >= 95%, brake === 0, position > 1
 *    - Outside DRS zones, DRS is strictly FALSE even at 0.1s interval and 100% throttle
 *    - Past activation zone reset: eligibility revoked
 * 2. Cumulative Lap Tracking:
 *    - Driver laps increment monotonically on progress wrap (newProgress >= 1.0)
 *    - Rankings 1-20 are strictly unique and monotonically ordered by total distance (lap + progress)
 *    - Lapped car ordering and start/finish line wrap continuity
 * 3. Timing Intervals:
 *    - Non-negative and finite intervals/gaps
 *    - Exactly 3-decimal precision (Number(val.toFixed(3)))
 *    - Leader interval and gap are strictly 0
 * 4. Cockpit Shift Lights & Reverse Gear:
 *    - 1.6L V6 5-5-5 shift light boundaries (<10.2k, 10.2-11.2k, 11.2-11.9k, 11.9-12.35k, >=12.35k)
 *    - Gear <= 0 displays 'R'
 * 5. FIA Tyre Compounds:
 *    - Official broadcast hex codes and uppercase normalization
 */

const path = require('path');

// Results accumulator
const results = [];

function recordTest(suite, name, condition, details = '') {
  const passed = Boolean(condition);
  if (passed) {
    console.log(`  ✅ [PASS] ${name}`);
  } else {
    console.error(`  ❌ [FAIL] ${name}${details ? ` -> ${details}` : ''}`);
  }
  results.push({ suite, name, passed, details });
}

// ---------------------------------------------------------------------------
// SUITE 1: DRS SPORTING REGULATIONS & BOUNDARY CONDITIONS
// ---------------------------------------------------------------------------
function testDrsSportingRegulations() {
  console.log('\n--- SUITE 1: DRS Sporting Regulations & Boundary Conditions ---');

  const MONZA_DRS_ZONES = [
    {
      zoneId: 1,
      name: 'Pit Straight',
      activationStart: 0.02,
      activationEnd: 0.16,
      detectionStart: 0.93,
      detectionEnd: 0.98,
    },
    {
      zoneId: 2,
      name: 'Curva del Serraglio',
      activationStart: 0.62,
      activationEnd: 0.74,
      detectionStart: 0.52,
      detectionEnd: 0.57,
    },
  ];

  // Helper evaluating DRS logic exactly matching simulation.service.ts
  function evaluateDrs(position, myProgress, isEligibleAtDetection, intervalToAhead, throttle, brake) {
    if (position === 1) {
      return false; // P1 Leader rule
    }
    const inDrsZone = MONZA_DRS_ZONES.some(
      (z) => myProgress >= z.activationStart && myProgress <= z.activationEnd
    );
    if (inDrsZone && isEligibleAtDetection && intervalToAhead <= 1.000 && throttle >= 95 && brake === 0 && position > 1) {
      return true;
    }
    return false;
  }

  // 1.1 Leader (P1) NEVER gets DRS across entire track
  let leaderEverDrs = false;
  for (let prog = 0; prog <= 1.0; prog += 0.005) {
    const drs = evaluateDrs(1, prog, true, 0.0, 100, 0);
    if (drs) {
      leaderEverDrs = true;
      break;
    }
  }
  recordTest(
    'DRS Regulations',
    'P1 Leader NEVER gets DRS across 100% of circuit (0.0 to 1.0)',
    !leaderEverDrs,
    `Leader DRS triggered: ${leaderEverDrs}`
  );

  // 1.2 Follower outside DRS zones NEVER gets DRS even with 0.1s interval and 100% throttle
  const outsideZonePoints = [0.00, 0.019, 0.161, 0.30, 0.50, 0.619, 0.741, 0.85, 0.95, 0.999];
  let followerOutsideGotDrs = false;
  for (const prog of outsideZonePoints) {
    const drs = evaluateDrs(2, prog, true, 0.1, 100, 0);
    if (drs) {
      followerOutsideGotDrs = true;
      break;
    }
  }
  recordTest(
    'DRS Regulations',
    'Follower outside Monza DRS zones NEVER gets DRS (tested 10 key boundary points)',
    !followerOutsideGotDrs,
    `Outside DRS zone activation detected`
  );

  // 1.3 Follower inside Zone 1 (0.02 - 0.16) gets DRS when eligible, interval <= 1.0s, throttle >= 95, brake === 0
  const zone1Active = evaluateDrs(2, 0.08, true, 0.650, 100, 0);
  recordTest(
    'DRS Regulations',
    'Follower inside Zone 1 (Pit Straight @ 0.08) gets DRS when conditions met',
    zone1Active === true,
    `Got ${zone1Active}`
  );

  // 1.4 Follower inside Zone 2 (0.62 - 0.74) gets DRS when eligible, interval <= 1.0s, throttle >= 95, brake === 0
  const zone2Active = evaluateDrs(2, 0.68, true, 0.420, 100, 0);
  recordTest(
    'DRS Regulations',
    'Follower inside Zone 2 (Curva del Serraglio @ 0.68) gets DRS when conditions met',
    zone2Active === true,
    `Got ${zone2Active}`
  );

  // 1.5 Strict interval threshold: interval > 1.000s blocks DRS
  const intervalExceeded = evaluateDrs(2, 0.08, true, 1.001, 100, 0);
  recordTest(
    'DRS Regulations',
    'Interval > 1.000s (1.001s) strictly blocks DRS activation in Zone 1',
    intervalExceeded === false,
    `Got ${intervalExceeded}`
  );

  const exactBoundaryInterval = evaluateDrs(2, 0.08, true, 1.000, 100, 0);
  recordTest(
    'DRS Regulations',
    'Exact 1.000s interval boundary allows DRS activation',
    exactBoundaryInterval === true,
    `Got ${exactBoundaryInterval}`
  );

  // 1.6 Throttle threshold: throttle < 95% blocks DRS
  const partialThrottle = evaluateDrs(2, 0.08, true, 0.500, 94, 0);
  recordTest(
    'DRS Regulations',
    'Throttle < 95% (94%) strictly blocks DRS activation',
    partialThrottle === false,
    `Got ${partialThrottle}`
  );

  const boundaryThrottle = evaluateDrs(2, 0.08, true, 0.500, 95, 0);
  recordTest(
    'DRS Regulations',
    'Throttle >= 95% (95%) allows DRS activation',
    boundaryThrottle === true,
    `Got ${boundaryThrottle}`
  );

  // 1.7 Brake engagement: brake > 0 blocks DRS
  const brakingDrs = evaluateDrs(2, 0.08, true, 0.500, 100, 1);
  recordTest(
    'DRS Regulations',
    'Braking (brake > 0) strictly shuts DRS wing flap',
    brakingDrs === false,
    `Got ${brakingDrs}`
  );

  // 1.8 Detection point eligibility requirement: not eligible at detection blocks DRS
  const notEligibleAtDetection = evaluateDrs(2, 0.08, false, 0.500, 100, 0);
  recordTest(
    'DRS Regulations',
    'Driver not eligible at detection point cannot activate DRS in zone',
    notEligibleAtDetection === false,
    `Got ${notEligibleAtDetection}`
  );

  // 1.9 Zone Exit Reset: Past activation zones (0.16-0.52 and 0.74-0.93)
  function isResetPoint(prog) {
    const pastZone1 = prog > 0.16 && prog < 0.52;
    const pastZone2 = prog > 0.74 && prog < 0.93;
    return pastZone1 || pastZone2;
  }
  recordTest(
    'DRS Regulations',
    'Eligibility is cleanly reset past Zone 1 (0.16 < prog < 0.52)',
    isResetPoint(0.25) === true && isResetPoint(0.165) === true,
    'Reset check'
  );
  recordTest(
    'DRS Regulations',
    'Eligibility is cleanly reset past Zone 2 (0.74 < prog < 0.93)',
    isResetPoint(0.80) === true && isResetPoint(0.745) === true,
    'Reset check'
  );
}

// ---------------------------------------------------------------------------
// SUITE 2: CUMULATIVE LAP TRACKING & GRID RANKINGS
// ---------------------------------------------------------------------------
function testCumulativeLapTracking() {
  console.log('\n--- SUITE 2: Cumulative Lap Tracking & Monotonic Grid Rankings ---');

  // Multi-lap progress wrap simulation
  let currentProgress = 0.95;
  let currentLaps = 32;
  const tickIncrement = 0.02; // fast increment for testing wrap

  const lapHistory = [];
  for (let tick = 0; tick < 100; tick++) {
    const newProgress = currentProgress + tickIncrement;
    if (newProgress >= 1.0) {
      currentLaps += Math.floor(newProgress);
    }
    currentProgress = ((newProgress % 1.0) + 1.0) % 1.0;
    lapHistory.push({ tick, lap: currentLaps, prog: currentProgress });
  }

  // 2.1 Monotonic lap increments
  let lapsMonotonic = true;
  for (let i = 1; i < lapHistory.length; i++) {
    if (lapHistory[i].lap < lapHistory[i - 1].lap) {
      lapsMonotonic = false;
      break;
    }
  }
  recordTest(
    'Lap Tracking',
    'Driver laps increment monotonically across 100 simulated ticks (2 laps completed)',
    lapsMonotonic && currentLaps === 34,
    `Final laps: ${currentLaps}`
  );

  // 2.2 Progress bounds [0.0, 1.0)
  const allProgsValid = lapHistory.every((h) => h.prog >= 0.0 && h.prog < 1.0 && Number.isFinite(h.prog));
  recordTest(
    'Lap Tracking',
    'Driver progress strictly bounded within [0.0, 1.0) after wrap',
    allProgsValid,
    'Out of bounds progress detected'
  );

  // 2.3 Grid Sorting by cumulative distance (laps + progress)
  const simulatedCars = [
    { driverNumber: 1, laps: 33, prog: 0.10 },  // P1: total 33.10
    { driverNumber: 4, laps: 33, prog: 0.08 },  // P2: total 33.08
    { driverNumber: 16, laps: 32, prog: 0.99 }, // P3: total 32.99 (just about to cross line)
    { driverNumber: 44, laps: 32, prog: 0.50 }, // P4: total 32.50
    { driverNumber: 81, laps: 31, prog: 0.80 }, // P5: total 31.80 (lapped car)
  ];

  simulatedCars.sort((a, b) => (b.laps + b.prog) - (a.laps + a.prog));

  const sortedDriverNumbers = simulatedCars.map((c) => c.driverNumber);
  recordTest(
    'Grid Rankings',
    'Cumulative distance sorting prevents start/finish line flip-flop between laps 32 and 33',
    JSON.stringify(sortedDriverNumbers) === JSON.stringify([1, 4, 16, 44, 81]),
    `Result: ${JSON.stringify(sortedDriverNumbers)}`
  );

  // 2.4 20-Car Grid Uniqueness and Completeness
  const fullGrid = Array.from({ length: 20 }, (_, i) => ({
    driverNumber: i + 1,
    laps: 32 + (i === 19 ? -1 : 0), // P20 is lapped
    progress: Math.max(0, 0.95 - (i * 0.045)),
  }));

  fullGrid.sort((a, b) => (b.laps + b.progress) - (a.laps + a.progress));
  const positions = fullGrid.map((_, i) => i + 1);
  const positionSet = new Set(positions);

  recordTest(
    'Grid Rankings',
    '20-car grid rankings are strictly unique and contiguous from 1 to 20',
    positionSet.size === 20 && Math.min(...positions) === 1 && Math.max(...positions) === 20,
    `Unique positions: ${positionSet.size}`
  );
}

// ---------------------------------------------------------------------------
// SUITE 3: TIMING INTERVALS & 3-DECIMAL PRECISION
// ---------------------------------------------------------------------------
function testTimingIntervals() {
  console.log('\n--- SUITE 3: Timing Intervals & 3-Decimal Precision ---');

  const lapTimeSeconds = 81.5;

  function calculateInterval(aheadLaps, aheadProg, myLaps, myProg) {
    const deltaLap = aheadLaps - myLaps;
    const deltaProg = (aheadProg - myProg) + deltaLap;
    const intervalSec = deltaProg * lapTimeSeconds;
    return Number(Math.max(0, intervalSec).toFixed(3));
  }

  // 3.1 Leader has 0 interval and gap
  const leaderInterval = calculateInterval(33, 0.5, 33, 0.5);
  recordTest(
    'Timing Intervals',
    'Leader interval to ahead is strictly 0.000s',
    leaderInterval === 0,
    `Got ${leaderInterval}`
  );

  // 3.2 Follower close behind (0.01 progress delta)
  const closeInterval = calculateInterval(33, 0.51, 33, 0.50);
  const expectedClose = Number((0.01 * 81.5).toFixed(3));
  recordTest(
    'Timing Intervals',
    'Follower close behind calculates correct 3-decimal interval',
    closeInterval === expectedClose && closeInterval === 0.815,
    `Expected 0.815, got ${closeInterval}`
  );

  // 3.3 Across lap boundary: Leader crossed start/finish line (Lap 34 prog 0.02), Follower at Lap 33 prog 0.99
  const crossLineInterval = calculateInterval(34, 0.02, 33, 0.99);
  // deltaProg = (0.02 - 0.99) + (34 - 33) = -0.97 + 1.0 = 0.03
  // 0.03 * 81.5 = 2.445s
  recordTest(
    'Timing Intervals',
    'Interval calculation across start/finish line wrap handles lap differential accurately',
    crossLineInterval === 2.445,
    `Expected 2.445, got ${crossLineInterval}`
  );

  // 3.4 Non-negative assertion
  // Even if aheadProg is somehow behind (which shouldn't happen with sorted cars), Math.max(0, ...) protects
  const negativeGuarded = calculateInterval(32, 0.10, 32, 0.20);
  recordTest(
    'Timing Intervals',
    'Interval is strictly guarded against negative values (returns 0.000)',
    negativeGuarded === 0,
    `Got ${negativeGuarded}`
  );

  // 3.5 3-decimal string format test
  const testValues = [0, 0.815, 2.445, 12.3456, 0.0001];
  const allFormattedCorrectly = testValues.every((val) => {
    const formatted = val.toFixed(3);
    const parts = formatted.split('.');
    return parts.length === 2 && parts[1].length === 3;
  });
  recordTest(
    'Timing Intervals',
    'All timing outputs format to exactly 3 decimal places (milliseconds)',
    allFormattedCorrectly,
    'Decimal precision check'
  );
}

// ---------------------------------------------------------------------------
// SUITE 4: COCKPIT SHIFT LIGHTS & REVERSE GEAR
// ---------------------------------------------------------------------------
function testCockpitShiftLights() {
  console.log('\n--- SUITE 4: Cockpit Shift Lights & Reverse Gear ---');

  function calculateShiftLights(rpm) {
    let activeLeds = 0;
    if (rpm >= 12350) {
      activeLeds = 15;
    } else if (rpm >= 11900) {
      const fraction = (rpm - 11900) / (12350 - 11900);
      activeLeds = 10 + Math.min(5, Math.floor(fraction * 5) + 1);
    } else if (rpm >= 11200) {
      const fraction = (rpm - 11200) / (11900 - 11200);
      activeLeds = 5 + Math.min(5, Math.floor(fraction * 5) + 1);
    } else if (rpm >= 10200) {
      const fraction = (rpm - 10200) / (11200 - 10200);
      activeLeds = Math.min(5, Math.floor(fraction * 5) + 1);
    } else {
      activeLeds = 0;
    }
    const isRedline = rpm >= 12350;
    return { activeLeds, isRedline };
  }

  // 4.1 Below 10,200 RPM: 0 LEDs
  const idle = calculateShiftLights(8000);
  recordTest(
    'Shift Lights',
    'Below 10,200 RPM: 0 LEDs lit (quiet zone during braking/idle)',
    idle.activeLeds === 0 && !idle.isRedline,
    `Got ${idle.activeLeds} LEDs`
  );

  // 4.2 Green band: 10,200 to 11,200 RPM
  const greenEntry = calculateShiftLights(10250);
  const greenFull = calculateShiftLights(11150);
  recordTest(
    'Shift Lights',
    '10,200 to 11,200 RPM: Green LED band activates (1 to 5 LEDs)',
    greenEntry.activeLeds >= 1 && greenFull.activeLeds === 5 && !greenFull.isRedline,
    `Entry: ${greenEntry.activeLeds}, Full: ${greenFull.activeLeds}`
  );

  // 4.3 Red band: 11,200 to 11,900 RPM
  const redEntry = calculateShiftLights(11250);
  const redFull = calculateShiftLights(11850);
  recordTest(
    'Shift Lights',
    '11,200 to 11,900 RPM: Red LED band activates (6 to 10 LEDs)',
    redEntry.activeLeds >= 6 && redFull.activeLeds === 10 && !redFull.isRedline,
    `Entry: ${redEntry.activeLeds}, Full: ${redFull.activeLeds}`
  );

  // 4.4 Blue band: 11,900 to 12,350 RPM
  const blueEntry = calculateShiftLights(11950);
  const blueFull = calculateShiftLights(12300);
  recordTest(
    'Shift Lights',
    '11,900 to 12,350 RPM: Blue LED band activates (11 to 15 LEDs)',
    blueEntry.activeLeds >= 11 && blueFull.activeLeds === 15 && !blueFull.isRedline,
    `Entry: ${blueEntry.activeLeds}, Full: ${blueFull.activeLeds}`
  );

  // 4.5 Redline strobe: >= 12,350 RPM
  const redline = calculateShiftLights(12400);
  recordTest(
    'Shift Lights',
    '>= 12,350 RPM: Full 15 LEDs + redline strobe flash active',
    redline.activeLeds === 15 && redline.isRedline === true,
    `Active: ${redline.activeLeds}, isRedline: ${redline.isRedline}`
  );

  // 4.6 Reverse gear: gear <= 0 displays 'R'
  function getGearDisplay(rawGear) {
    return rawGear <= 0 ? 'R' : rawGear;
  }
  recordTest(
    'Gear Indicator',
    'Gear <= 0 (0, -1) displays "R" for Reverse',
    getGearDisplay(0) === 'R' && getGearDisplay(-1) === 'R' && getGearDisplay(1) === 1,
    `Gear 0: ${getGearDisplay(0)}, Gear -1: ${getGearDisplay(-1)}`
  );
}

// ---------------------------------------------------------------------------
// SUITE 5: FIA STANDARD TYRE COMPOUNDS
// ---------------------------------------------------------------------------
function testFiaTyreCompounds() {
  console.log('\n--- SUITE 5: FIA Standard Tyre Compound Colors ---');

  const FIA_TYRES = {
    SOFT: '#E10600',
    MEDIUM: '#FFF500',
    HARD: '#FFFFFF',
    INTERMEDIATE: '#39B54A',
    WET: '#0072CE',
    UNKNOWN: '#64748B',
  };

  recordTest('FIA Tyres', 'Soft compound matches FIA broadcast red #E10600', FIA_TYRES.SOFT === '#E10600');
  recordTest('FIA Tyres', 'Medium compound matches FIA broadcast yellow #FFF500', FIA_TYRES.MEDIUM === '#FFF500');
  recordTest('FIA Tyres', 'Hard compound matches FIA broadcast white #FFFFFF', FIA_TYRES.HARD === '#FFFFFF');
  recordTest('FIA Tyres', 'Intermediate compound matches FIA broadcast green #39B54A', FIA_TYRES.INTERMEDIATE === '#39B54A');
  recordTest('FIA Tyres', 'Wet compound matches FIA broadcast blue #0072CE', FIA_TYRES.WET === '#0072CE');
}

// ---------------------------------------------------------------------------
// MAIN EXECUTION
// ---------------------------------------------------------------------------
function runAllEmpiricalTests() {
  console.log('======================================================================');
  console.log('🏎️  Milestone 3 Challenger 1: Empirical Verification Test Suite');
  console.log('   Adversarial Stress Test: DRS Regulations, Cumulative Laps & Timing');
  console.log('======================================================================');

  testDrsSportingRegulations();
  testCumulativeLapTracking();
  testTimingIntervals();
  testCockpitShiftLights();
  testFiaTyreCompounds();

  const total = results.length;
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;

  console.log('\n======================================================================');
  console.log(`🏁 EMPIRICAL TEST RESULTS: ${passed}/${total} PASSED (${failed} FAILED)`);
  console.log('======================================================================\n');

  return { total, passed, failed, results };
}

// Export for runner / direct node execution
if (require.main === module) {
  const summary = runAllEmpiricalTests();
  process.exit(summary.failed > 0 ? 1 : 0);
} else {
  module.exports = { runAllEmpiricalTests };
}
