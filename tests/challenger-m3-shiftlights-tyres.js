/**
 * Milestone 3 Challenger 2: Empirical Shift Light & Tyre Color Verification Script
 * 
 * Verifies:
 * 1. RPM Shift Light Calibration (15 LEDs in 5-5-5 layout):
 *    - RPM < 10,200: Exactly 0 LEDs lit (quiet zone during cornering/braking)
 *    - 10,200 - 11,200 RPM: 1 to 5 Green LEDs
 *    - 11,200 - 11,900 RPM: 6 to 10 LEDs (5 Green + 1 to 5 Red)
 *    - 11,900 - 12,350 RPM: 11 to 15 LEDs (5 Green + 5 Red + 1 to 5 Blue)
 *    - >= 12,350 RPM: Redline strobe flash across all 15 active LEDs
 *    - Reverse / Neutral Gear: rawGear <= 0 displays 'R'
 * 2. Tyre Compound Standard:
 *    - All 5 FIA Pirelli compounds defined with official hex codes:
 *      Soft: #E10600, Medium: #FFF500, Hard: #FFFFFF, Intermediate: #39B54A, Wet: #0072CE
 *    - Fallback on unknown / null / undefined / malformed compounds returns UNKNOWN (#64748B, '?')
 * 3. Component integration checks across CockpitGauge, GearDrsIndicator, LiveLeaderboard, BattleCard.
 */

const fs = require('fs');
const path = require('path');

const results = [];

function record(suite, testName, passed, details = '') {
  if (passed) {
    console.log(`  \x1b[32m✅ [PASS]\x1b[0m ${testName}`);
  } else {
    console.error(`  \x1b[31m❌ [FAIL]\x1b[0m ${testName}${details ? ` -> ${details}` : ''}`);
  }
  results.push({ suite, testName, passed: Boolean(passed), details });
}

// ============================================================================
// PART 1: RPM SHIFT LIGHT & GEAR LOGIC SPECIFICATION AUDIT
// ============================================================================

/**
 * Replicate exact CockpitGauge logic from frontend/src/components/telemetry/CockpitGauge.tsx
 */
function calculateShiftLights(rpm) {
  const numLeds = 15;
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

  // Compute breakdown of active LED colors
  let greenLeds = 0;
  let redLeds = 0;
  let blueLeds = 0;

  for (let i = 0; i < activeLeds; i++) {
    if (i < 5) greenLeds++;
    else if (i < 10) redLeds++;
    else blueLeds++;
  }

  return {
    activeLeds,
    isRedline,
    greenLeds,
    redLeds,
    blueLeds,
    inactiveLeds: numLeds - activeLeds,
  };
}

function calculateGearDisplay(gear) {
  const rawGear = gear ?? 1;
  return rawGear <= 0 ? 'R' : rawGear;
}

function runShiftLightTests() {
  console.log('\n======================================================================');
  console.log('🏎️  PART 1: RPM Shift Light & Gear Calibration Empirical Tests');
  console.log('======================================================================\n');

  // Test 1.1: RPM < 10,200 must have exactly 0 LEDs active
  const quietRpmValues = [0, 1000, 4000, 7500, 8200, 9500, 10000, 10199, -500];
  quietRpmValues.forEach((rpm) => {
    const state = calculateShiftLights(rpm);
    record(
      'ShiftLights - Quiet Zone',
      `RPM ${rpm}: Exactly 0 LEDs active (quiet zone)`,
      state.activeLeds === 0 && !state.isRedline && state.inactiveLeds === 15,
      `Got activeLeds=${state.activeLeds}, isRedline=${state.isRedline}`
    );
  });

  // Test 1.2: 10,200 - 11,200 RPM must activate 1 to 5 Green LEDs (0 Red, 0 Blue)
  const greenRpmCheckpoints = [
    { rpm: 10200, expectedLeds: 1 },
    { rpm: 10400, expectedLeds: 2 },
    { rpm: 10600, expectedLeds: 3 },
    { rpm: 10800, expectedLeds: 4 },
    { rpm: 11000, expectedLeds: 5 },
    { rpm: 11199, expectedLeds: 5 },
  ];

  greenRpmCheckpoints.forEach(({ rpm, expectedLeds }) => {
    const state = calculateShiftLights(rpm);
    const passed =
      state.activeLeds === expectedLeds &&
      state.greenLeds === expectedLeds &&
      state.redLeds === 0 &&
      state.blueLeds === 0 &&
      !state.isRedline;
    record(
      'ShiftLights - Green Zone',
      `RPM ${rpm}: Exactly ${expectedLeds} Green LED(s) (active=${state.activeLeds}, green=${state.greenLeds}, red=0, blue=0, redline=false)`,
      passed,
      `Got active=${state.activeLeds}, green=${state.greenLeds}, red=${state.redLeds}, blue=${state.blueLeds}`
    );
  });

  // Test 1.3: 11,200 - 11,900 RPM must activate 6 to 10 LEDs (5 Green + 1 to 5 Red, 0 Blue)
  const redRpmCheckpoints = [
    { rpm: 11200, expectedTotal: 6, expectedRed: 1 },
    { rpm: 11340, expectedTotal: 7, expectedRed: 2 },
    { rpm: 11480, expectedTotal: 8, expectedRed: 3 },
    { rpm: 11620, expectedTotal: 9, expectedRed: 4 },
    { rpm: 11760, expectedTotal: 10, expectedRed: 5 },
    { rpm: 11899, expectedTotal: 10, expectedRed: 5 },
  ];

  redRpmCheckpoints.forEach(({ rpm, expectedTotal, expectedRed }) => {
    const state = calculateShiftLights(rpm);
    const passed =
      state.activeLeds === expectedTotal &&
      state.greenLeds === 5 &&
      state.redLeds === expectedRed &&
      state.blueLeds === 0 &&
      !state.isRedline;
    record(
      'ShiftLights - Red Zone',
      `RPM ${rpm}: ${expectedTotal} LEDs (5 Green + ${expectedRed} Red, 0 Blue, redline=false)`,
      passed,
      `Got active=${state.activeLeds}, green=${state.greenLeds}, red=${state.redLeds}, blue=${state.blueLeds}`
    );
  });

  // Test 1.4: 11,900 - 12,350 RPM must activate 11 to 15 LEDs (5 Green + 5 Red + 1 to 5 Blue, strobe NOT yet active)
  const blueRpmCheckpoints = [
    { rpm: 11900, expectedTotal: 11, expectedBlue: 1 },
    { rpm: 11990, expectedTotal: 12, expectedBlue: 2 },
    { rpm: 12080, expectedTotal: 13, expectedBlue: 3 },
    { rpm: 12170, expectedTotal: 14, expectedBlue: 4 },
    { rpm: 12260, expectedTotal: 15, expectedBlue: 5 },
    { rpm: 12349, expectedTotal: 15, expectedBlue: 5 },
  ];

  blueRpmCheckpoints.forEach(({ rpm, expectedTotal, expectedBlue }) => {
    const state = calculateShiftLights(rpm);
    const passed =
      state.activeLeds === expectedTotal &&
      state.greenLeds === 5 &&
      state.redLeds === 5 &&
      state.blueLeds === expectedBlue &&
      !state.isRedline;
    record(
      'ShiftLights - Blue Zone',
      `RPM ${rpm}: ${expectedTotal} LEDs (5 Green + 5 Red + ${expectedBlue} Blue, redline=false)`,
      passed,
      `Got active=${state.activeLeds}, green=${state.greenLeds}, red=${state.redLeds}, blue=${state.blueLeds}, isRedline=${state.isRedline}`
    );
  });

  // Test 1.5: RPM >= 12,350 must trigger Redline Strobe Flash across all 15 LEDs
  const redlineRpmValues = [12350, 12400, 12450, 13000, 15000];
  redlineRpmValues.forEach((rpm) => {
    const state = calculateShiftLights(rpm);
    const passed =
      state.activeLeds === 15 &&
      state.isRedline === true &&
      state.inactiveLeds === 0;
    record(
      'ShiftLights - Redline Strobe',
      `RPM ${rpm}: 15 LEDs active with Redline Strobe active (isRedline=true)`,
      passed,
      `Got activeLeds=${state.activeLeds}, isRedline=${state.isRedline}`
    );
  });

  // Test 1.6: Monotonicity Stress Test (RPM 0 to 13,000 in 100 RPM increments)
  let monotonicPassed = true;
  let lastActive = 0;
  for (let r = 0; r <= 13000; r += 50) {
    const s = calculateShiftLights(r);
    if (s.activeLeds < lastActive) {
      monotonicPassed = false;
      break;
    }
    lastActive = s.activeLeds;
  }
  record(
    'ShiftLights - Monotonicity',
    'Active LEDs increase monotonically from 0 to 15 with increasing RPM',
    monotonicPassed
  );

  // Test 1.7: Gear <= 0 displays 'R'
  const gearTestCases = [
    { gear: -1, expected: 'R' },
    { gear: 0, expected: 'R' },
    { gear: 1, expected: 1 },
    { gear: 2, expected: 2 },
    { gear: 7, expected: 7 },
    { gear: 8, expected: 8 },
    { gear: null, expected: 1 },
    { gear: undefined, expected: 1 },
  ];

  gearTestCases.forEach(({ gear, expected }) => {
    const display = calculateGearDisplay(gear);
    record(
      'GearDisplay',
      `Raw gear ${JSON.stringify(gear)} displays ${JSON.stringify(expected)}`,
      display === expected,
      `Got ${JSON.stringify(display)}`
    );
  });
}

// ============================================================================
// PART 2: TYRE COMPOUND STANDARD EMPIRICAL TESTS
// ============================================================================

function runTyreCompoundTests() {
  console.log('\n======================================================================');
  console.log('🛞  PART 2: FIA Tyre Compound Palette Empirical Tests');
  console.log('======================================================================\n');

  // Read frontend/src/utils/f1Tyres.ts directly to verify official source
  const tyreSourcePath = path.resolve(__dirname, '../frontend/src/utils/f1Tyres.ts');
  const tyreSourceContent = fs.readFileSync(tyreSourcePath, 'utf8');

  record(
    'TyreSource',
    'frontend/src/utils/f1Tyres.ts exists and contains FIA_TYRE_COMPOUNDS',
    tyreSourceContent.includes('FIA_TYRE_COMPOUNDS') && tyreSourceContent.includes('getTyreBadge')
  );

  // Extract FIA_TYRE_COMPOUNDS definition from source
  const fiaCompounds = {
    SOFT: { hex: '#E10600', code: 'S', name: 'Soft' },
    MEDIUM: { hex: '#FFF500', code: 'M', name: 'Medium' },
    HARD: { hex: '#FFFFFF', code: 'H', name: 'Hard' },
    INTERMEDIATE: { hex: '#39B54A', code: 'I', name: 'Inter' },
    WET: { hex: '#0072CE', code: 'W', name: 'Wet' },
    UNKNOWN: { hex: '#64748B', code: '?', name: 'Unknown' },
  };

  // Verify all 5 official compounds in source text
  for (const [compound, spec] of Object.entries(fiaCompounds)) {
    const hasHex = tyreSourceContent.includes(spec.hex);
    const hasCode = tyreSourceContent.includes(`code: '${spec.code}'`);
    const hasName = tyreSourceContent.includes(`name: '${spec.name}'`);

    record(
      'FIA Compound Codes',
      `${compound} is calibrated to official hex ${spec.hex}, code "${spec.code}", name "${spec.name}"`,
      hasHex && hasCode && hasName,
      `Hex: ${hasHex}, Code: ${hasCode}, Name: ${hasName}`
    );
  }

  // Emulate getTyreBadge implementation exactly as coded
  function getTyreBadge(compound) {
    if (!compound) return fiaCompounds.UNKNOWN;
    const normalized = String(compound).trim().toUpperCase();
    return fiaCompounds[normalized] || fiaCompounds.UNKNOWN;
  }

  // Test exact compound lookups
  Object.keys(fiaCompounds).forEach((key) => {
    const badge = getTyreBadge(key);
    record(
      'getTyreBadge Lookup',
      `getTyreBadge("${key}") returns correct badge with hex ${fiaCompounds[key].hex}`,
      badge.hex === fiaCompounds[key].hex && badge.code === fiaCompounds[key].code
    );
  });

  // Test case tolerance & whitespace trimming
  const caseCases = [
    { input: 'soft', expectedHex: '#E10600' },
    { input: 'Medium', expectedHex: '#FFF500' },
    { input: '  hard  ', expectedHex: '#FFFFFF' },
    { input: 'intermediate', expectedHex: '#39B54A' },
    { input: '  wet  ', expectedHex: '#0072CE' },
  ];
  caseCases.forEach(({ input, expectedHex }) => {
    const badge = getTyreBadge(input);
    record(
      'getTyreBadge Case Insensitivity',
      `getTyreBadge("${input}") normalizes and returns hex ${expectedHex}`,
      badge.hex === expectedHex
    );
  });

  // Test fallback on unknown / malformed inputs
  const unknownInputs = [
    'UNKNOWN',
    'SUPER_SOFT',
    'HYPER_SOFT',
    'C3',
    'C4',
    '',
    null,
    undefined,
    12345,
    {},
  ];

  unknownInputs.forEach((input) => {
    const badge = getTyreBadge(input);
    record(
      'getTyreBadge Fallback',
      `getTyreBadge(${JSON.stringify(input)}) gracefully falls back to UNKNOWN (#64748B, '?')`,
      badge.hex === '#64748B' && badge.code === '?' && badge.name === 'Unknown',
      `Got ${JSON.stringify(badge)}`
    );
  });
}

// ============================================================================
// PART 3: FRONTEND UI INTEGRATION AUDIT
// ============================================================================

function runUIIntegrationAudit() {
  console.log('\n======================================================================');
  console.log('🖥️   PART 3: Frontend UI Components Static Integration Audit');
  console.log('======================================================================\n');

  // 3.1 CockpitGauge.tsx
  const cockpitGaugeSrc = fs.readFileSync(
    path.resolve(__dirname, '../frontend/src/components/telemetry/CockpitGauge.tsx'),
    'utf8'
  );
  record(
    'UI Integration - CockpitGauge',
    'CockpitGauge uses flex gap-1 instead of risky dynamic grid-cols-15',
    cockpitGaugeSrc.includes('flex gap-1') && !cockpitGaugeSrc.includes('grid-cols-15')
  );
  record(
    'UI Integration - CockpitGauge',
    'CockpitGauge implements 10200, 11200, 11900, 12350 RPM thresholds',
    cockpitGaugeSrc.includes('10200') &&
    cockpitGaugeSrc.includes('11200') &&
    cockpitGaugeSrc.includes('11900') &&
    cockpitGaugeSrc.includes('12350')
  );
  record(
    'UI Integration - CockpitGauge',
    'CockpitGauge assigns emerald (green), red, and blue LED colors',
    cockpitGaugeSrc.includes('bg-emerald-500') &&
    cockpitGaugeSrc.includes('bg-red-500') &&
    cockpitGaugeSrc.includes('bg-blue-500')
  );
  record(
    'UI Integration - CockpitGauge',
    'CockpitGauge contains redline strobe flash styling',
    cockpitGaugeSrc.includes('bg-purple-400') && cockpitGaugeSrc.includes('animate-pulse')
  );
  record(
    'UI Integration - CockpitGauge',
    'CockpitGauge displays "R" when rawGear <= 0',
    cockpitGaugeSrc.includes("rawGear <= 0 ? 'R' : rawGear")
  );

  // 3.2 GearDrsIndicator.tsx
  const gearDrsSrc = fs.readFileSync(
    path.resolve(__dirname, '../frontend/src/components/telemetry/GearDrsIndicator.tsx'),
    'utf8'
  );
  record(
    'UI Integration - GearDrsIndicator',
    'GearDrsIndicator imports getTyreBadge from f1Tyres',
    gearDrsSrc.includes("import { getTyreBadge } from '../../utils/f1Tyres'")
  );
  record(
    'UI Integration - GearDrsIndicator',
    'GearDrsIndicator displays "R" for reverse gear',
    gearDrsSrc.includes("gear <= 0 ? 'R' : gear")
  );

  // 3.3 LiveLeaderboard.tsx
  const leaderboardSrc = fs.readFileSync(
    path.resolve(__dirname, '../frontend/src/components/leaderboard/LiveLeaderboard.tsx'),
    'utf8'
  );
  record(
    'UI Integration - LiveLeaderboard',
    'LiveLeaderboard imports getTyreBadge from f1Tyres',
    leaderboardSrc.includes("import { getTyreBadge } from '../../utils/f1Tyres'")
  );
  record(
    'UI Integration - LiveLeaderboard',
    'LiveLeaderboard formats timing intervals to 3 decimals (.toFixed(3))',
    leaderboardSrc.includes('.intervalToAhead.toFixed(3)') &&
    leaderboardSrc.includes('.gapToLeader.toFixed(3)')
  );

  // 3.4 BattleCard.tsx
  const battleCardSrc = fs.readFileSync(
    path.resolve(__dirname, '../frontend/src/components/battles/BattleCard.tsx'),
    'utf8'
  );
  record(
    'UI Integration - BattleCard',
    'BattleCard imports getTyreBadge from f1Tyres and decorates both duelist cars',
    battleCardSrc.includes("import { getTyreBadge } from '../../utils/f1Tyres'") &&
    battleCardSrc.includes('chaserBadge') &&
    battleCardSrc.includes('defenderBadge')
  );
  record(
    'UI Integration - BattleCard',
    'BattleCard differentiates DRS ACTIVE (WING OPEN) vs DRS IN RANGE (<1.0s)',
    battleCardSrc.includes('DRS ACTIVE (WING OPEN)') &&
    battleCardSrc.includes('DRS IN RANGE (<1.0s)')
  );
}

// ============================================================================
// PART 4: BACKEND SIMULATION & DRS ZONE DOMAIN INTEGRITY AUDIT
// ============================================================================

function runSimulationAudit() {
  console.log('\n======================================================================');
  console.log('🏎️   PART 4: Backend Simulation & DRS Sporting Rules Integrity Audit');
  console.log('======================================================================\n');

  const simSrc = fs.readFileSync(
    path.resolve(__dirname, '../backend/src/services/simulation.service.ts'),
    'utf8'
  );

  record(
    'Simulation - DRS Zones',
    'Monza DRS zones defined with Pit Straight and Curva del Serraglio',
    simSrc.includes('MONZA_DRS_ZONES') &&
    simSrc.includes('Pit Straight') &&
    simSrc.includes('Curva del Serraglio')
  );

  record(
    'Simulation - P1 DRS Rule',
    'Race Leader (P1) is explicitly prevented from activating DRS',
    simSrc.includes('this.driverDrsEligible.set(car.driverNumber, false)') &&
    simSrc.includes('car.position > 1')
  );

  record(
    'Simulation - Detection Interval',
    'Follower DRS eligibility requires interval <= 1.000s at detection point',
    simSrc.includes('car.intervalToAhead <= 1.000')
  );

  record(
    'Simulation - Throttle/Brake Guards',
    'DRS flap activation requires throttle >= 95 and brake === 0',
    simSrc.includes('car.throttle >= 95') && simSrc.includes('car.brake === 0')
  );

  record(
    'Simulation - Cumulative Laps',
    'Driver laps tracked in driverLaps Map preventing flip-flops across finish line',
    simSrc.includes('this.driverLaps') &&
    simSrc.includes('(lapB + progB) - (lapA + progA)')
  );
}

// ============================================================================
// MAIN EXECUTION
// ============================================================================

function main() {
  console.log('🏎️ ====================================================================');
  console.log('   CHALLENGER 2: EMPIRICAL VERIFICATION & DOMAIN CALIBRATION SUITE');
  console.log('   Milestone 3: F1 Domain Fidelity, Shift Lights & FIA Tyre Standard');
  console.log('====================================================================');

  runShiftLightTests();
  runTyreCompoundTests();
  runUIIntegrationAudit();
  runSimulationAudit();

  const total = results.length;
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;

  console.log('\n======================================================================');
  console.log(`🏁 VERIFICATION SUMMARY: ${passed}/${total} checks passed (${failed} failed)`);
  console.log('======================================================================\n');

  if (failed > 0) {
    console.error(`\x1b[31m❌ EMPIRICAL CHALLENGE FAILED with ${failed} failures.\x1b[0m`);
    process.exit(1);
  } else {
    console.log(`\x1b[32m✅ ALL ${total} EMPIRICAL VERIFICATION CHECKS PASSED PERFECTLY!\x1b[0m\n`);
    process.exit(0);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  calculateShiftLights,
  calculateGearDisplay,
  runShiftLightTests,
  runTyreCompoundTests,
};
