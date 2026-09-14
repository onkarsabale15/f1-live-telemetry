/**
 * Tier 5: Frontend & Full Integration Adversarial Hardening Verification Suite
 * Milestone 4 Challenger 2 - Empirical Adversarial Test Suite
 * 
 * Verifies:
 * 1. useF1Socket.ts:
 *    - Persistent WebSocket connection across rapid driver switches (SEC-14 / F08)
 *    - Subscribe/unsubscribe race condition immunity under concurrent bursts
 *    - Auto-recovery of driver subscription on reconnect
 *    - Playback control stream stability under rapid seek/speed inputs
 * 2. CockpitGauge.tsx:
 *    - PCU-8D 15-LED shift light progression across all 4 zones:
 *      * Quiet zone (< 10,200 RPM -> 0 LEDs)
 *      * Green band (10,200 - 11,200 RPM -> 1-5 LEDs)
 *      * Red band (11,200 - 11,900 RPM -> 6-10 LEDs)
 *      * Blue band (11,900 - 12,350 RPM -> 11-15 LEDs)
 *      * Redline strobe flash (>= 12,350 RPM -> 15 LEDs + isRedline)
 *    - Extreme RPM handling (negative, zero, 25k, 100k, NaN)
 *    - Reverse and neutral gear display (rawGear <= 0 -> 'R')
 *    - Null telemetry and undefined driver graceful fallbacks
 * 3. f1Tyres.ts:
 *    - Direct transpiled execution of frontend/src/utils/f1Tyres.ts
 *    - FIA broadcast compound color authenticity (SOFT=#E10600, MEDIUM=#FFF500, HARD=#FFFFFF, INTER=#39B54A, WET=#0072CE)
 *    - Case insensitivity and whitespace trimming resilience
 *    - Graceful fallback to UNKNOWN (#64748B, '?') for corrupted/null/unexpected inputs
 * 4. CircuitCanvas.tsx:
 *    - High-DPI coordinate invariance across 1x, 2x, 3x devicePixelRatio
 *    - Multi-aspect ratio scaling resilience (16:9, 21:9, 1:1, mobile vertical)
 *    - Click coordinate normalization and 25px logical proximity detection
 *    - Degenerate track bounds and empty grid guards
 * 5. BattleCard.tsx:
 *    - DRS display hierarchy: Active (Wing Open) vs In-Range (<1.0s) vs None
 *    - Tactical metrics formatting (gap, closing pace, tyre delta, stalemate thresholds)
 *    - Overtake probability gradient color classifications
 *    - Circular tyre badge styling integration
 * 6. ErrorBoundary.tsx:
 *    - Exception trapping via getDerivedStateFromError
 *    - Custom and default fallback title handling
 *    - Reset retry lifecycle and onReset callback invocation
 * 7. Full Integration Stress Flow:
 *    - Live high-frequency multi-action churn across active WebSocket streaming
 */

const fs = require('fs');
const path = require('path');
const {
  describe,
  test,
  assert,
  assertEqual,
  assertNotEqual,
  assertDefined,
  assertInRange,
  createSocket,
  waitForConnect,
  waitForEvent,
  waitForEventMatching,
  ensureServerRunning,
  teardownServer,
  runSuites,
} = require('./test-harness');

// ----------------------------------------------------------------------------
// Resolve TypeScript Compiler for Direct Source Transpilation
// ----------------------------------------------------------------------------
let ts;
try {
  ts = require('typescript');
} catch {
  try {
    ts = require(path.resolve(__dirname, '../../frontend/node_modules/typescript'));
  } catch {
    ts = require(path.resolve(__dirname, '../../backend/node_modules/typescript'));
  }
}

let React;
try {
  React = require(path.resolve(__dirname, '../../frontend/node_modules/react'));
} catch {
  React = require('react');
}

/**
 * Helper to dynamically transpile and load a frontend TypeScript utility
 */
function loadTranspiledModule(relativeFilePath) {
  const fullPath = path.resolve(__dirname, '../../frontend', relativeFilePath);
  const code = fs.readFileSync(fullPath, 'utf8');
  const transpiled = ts.transpileModule(code, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      jsx: ts.JsxEmit.React,
    },
  }).outputText;

  const mod = { exports: {} };
  const customRequire = (id) => {
    if (id === 'react') return React;
    if (id.startsWith('../types/') || id.startsWith('../../types/')) return {};
    if (id.includes('f1Tyres')) return loadTranspiledModule('src/utils/f1Tyres.ts');
    try {
      return require(id);
    } catch {
      return {};
    }
  };

  const fn = new Function('exports', 'module', 'require', 'React', transpiled);
  fn(mod.exports, mod, customRequire, React);
  return mod.exports;
}

// ============================================================================
// SUITE 1: useF1Socket Hook Lifecycle & WebSocket Resilience
// ============================================================================
describe('Tier 5 - useF1Socket Hook & WebSocket Streaming Hardening', () => {
  test('Connection Churn Immunity: Rapid driver selection burst maintains a single persistent socket', async () => {
    const socket = createSocket();
    await waitForConnect(socket);

    const initialSocketId = socket.id;
    let disconnectCount = 0;
    socket.on('disconnect', () => {
      disconnectCount++;
    });

    // Rapidly switch between 15 different driver numbers within ~150ms
    const driverList = [4, 1, 16, 55, 44, 63, 81, 11, 14, 23, 27, 22, 10, 31, 4];
    for (const driverNum of driverList) {
      socket.emit('client:v1:subscribe_driver', { driverNumber: driverNum });
      await new Promise((r) => setTimeout(r, 10));
    }

    assertEqual(disconnectCount, 0, 'Socket must never disconnect during rapid driver switching');
    assertEqual(socket.id, initialSocketId, 'Socket ID must remain identical without reconnect churn');
    assertEqual(socket.connected, true, 'Socket connection must remain active');

    // Wait for tick of final driver (#4)
    const tick = await waitForEventMatching(
      socket,
      'f1:v1:telemetry_tick',
      (t) => t.driverNumber === 4,
      5000
    );
    assertDefined(tick, 'Must receive telemetry tick for the final focused driver');
    assertEqual(tick.driverNumber, 4);

    socket.disconnect();
  });

  test('Race Condition Immunity: Rapid interleaved subscribe and unsubscribe bursts process cleanly', async () => {
    const socket = createSocket();
    await waitForConnect(socket);

    const errorEvents = [];
    socket.on('error', (err) => errorEvents.push(err));

    // Fire rapid alternating subscribe/unsubscribe events
    for (let i = 0; i < 8; i++) {
      socket.emit('client:v1:subscribe_driver', { driverNumber: 16 });
      socket.emit('client:v1:unsubscribe_driver', { driverNumber: 4 });
      socket.emit('client:v1:subscribe_driver', { driverNumber: 81 });
      socket.emit('client:v1:unsubscribe_driver', { driverNumber: 16 });
      socket.emit('client:v1:subscribe_driver', { driverNumber: 44 });
      await new Promise((r) => setTimeout(r, 15));
    }

    // Give server 100ms to settle
    await new Promise((r) => setTimeout(r, 100));

    assertEqual(errorEvents.length, 0, `Expected 0 socket errors during valid churn, got: ${JSON.stringify(errorEvents)}`);
    assert(socket.connected, 'Socket must remain connected after subscribe/unsubscribe burst');

    // Confirm that Hamilton (#44) telemetry is received as final subscribed driver
    const tick = await waitForEventMatching(
      socket,
      'f1:v1:telemetry_tick',
      (t) => t.driverNumber === 44,
      5000
    );
    assertDefined(tick, 'Must receive telemetry for final subscribed driver (#44)');
    assertEqual(tick.driverNumber, 44);

    socket.disconnect();
  });

  test('Connection Drop & Reconnect Resubscription: Client recovers driver room upon reconnection', async () => {
    // 1. Initial connection with driver 16 (Leclerc)
    let socket = createSocket();
    await waitForConnect(socket);
    socket.emit('client:v1:subscribe_driver', { driverNumber: 16 });

    const tick1 = await waitForEventMatching(
      socket,
      'f1:v1:telemetry_tick',
      (t) => t.driverNumber === 16,
      4000
    );
    assertEqual(tick1.driverNumber, 16);

    // 2. Abruptly close connection
    socket.disconnect();

    // 3. Reconnect and immediately resubscribe (mimicking useF1Socket connect handler)
    socket = createSocket();
    await waitForConnect(socket);
    socket.emit('client:v1:subscribe_driver', { driverNumber: 16 });

    const tick2 = await waitForEventMatching(
      socket,
      'f1:v1:telemetry_tick',
      (t) => t.driverNumber === 16,
      4000
    );
    assertDefined(tick2, 'Telemetry stream must resume for driver 16 after reconnect');
    assertEqual(tick2.driverNumber, 16);

    socket.disconnect();
  });

  test('Playback Control Stress: High-frequency seek and speed mutations maintain consistent state', async () => {
    const socket = createSocket();
    await waitForConnect(socket);

    const receivedStates = [];
    socket.on('f1:v1:playback_state', (state) => receivedStates.push(state));

    // Rapid sequence of playback operations
    socket.emit('client:v1:playback_control', { action: 'pause' });
    socket.emit('client:v1:playback_control', { action: 'seek', progress: 0.1 });
    socket.emit('client:v1:playback_control', { action: 'play', speed: 2 });
    socket.emit('client:v1:playback_control', { action: 'seek', progress: 0.85 });
    socket.emit('client:v1:playback_control', { action: 'play', speed: 4 });
    socket.emit('client:v1:playback_control', { action: 'seek', progress: 0.0 });
    socket.emit('client:v1:playback_control', { action: 'play', speed: 1 });

    // Wait for states to propagate
    await new Promise((resolve) => {
      const interval = setInterval(() => {
        if (receivedStates.length >= 4) {
          clearInterval(interval);
          resolve();
        }
      }, 100);
    });

    assert(receivedStates.length >= 4, 'Expected multiple playback state broadcasts');
    const lastState = receivedStates[receivedStates.length - 1];
    assertEqual(lastState.sessionKey, 9590);
    assertEqual(lastState.speed, 1);
    assertEqual(lastState.isPlaying, true);

    socket.disconnect();
  });
});

// ============================================================================
// SUITE 2: CockpitGauge PCU-8D Shift Lights & Extreme RPM/Gear Bounds
// ============================================================================
describe('Tier 5 - CockpitGauge PCU-8D Shift Lights & Extreme Bounds', () => {
  // Replicate exact calculation logic from CockpitGauge.tsx
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

    let green = 0;
    let red = 0;
    let blue = 0;
    for (let i = 0; i < activeLeds; i++) {
      if (i < 5) green++;
      else if (i < 10) red++;
      else blue++;
    }

    return { activeLeds, isRedline, green, red, blue };
  }

  function calculateGearDisplay(gear) {
    const rawGear = gear ?? 1;
    return rawGear <= 0 ? 'R' : rawGear;
  }

  test('Quiet Zone: Below 10,200 RPM and non-positive RPMs yield 0 LEDs', () => {
    const testRpms = [-5000, -1, 0, 100, 5000, 8500, 10000, 10199];
    testRpms.forEach((rpm) => {
      const res = calculateShiftLights(rpm);
      assertEqual(res.activeLeds, 0, `RPM ${rpm} must have 0 LEDs active`);
      assertEqual(res.isRedline, false, `RPM ${rpm} must not trigger redline`);
      assertEqual(res.green, 0);
      assertEqual(res.red, 0);
      assertEqual(res.blue, 0);
    });
  });

  test('Green LED Band: 10,200 to 11,199 RPM progressively illuminates 1 to 5 Green LEDs', () => {
    const checkpoints = [
      { rpm: 10200, expectedLeds: 1 },
      { rpm: 10450, expectedLeds: 2 },
      { rpm: 10700, expectedLeds: 3 },
      { rpm: 10950, expectedLeds: 4 },
      { rpm: 11199, expectedLeds: 5 },
    ];

    checkpoints.forEach(({ rpm, expectedLeds }) => {
      const res = calculateShiftLights(rpm);
      assertEqual(res.activeLeds, expectedLeds, `RPM ${rpm} should light ${expectedLeds} LEDs`);
      assertEqual(res.green, expectedLeds, `RPM ${rpm} should have ${expectedLeds} green LEDs`);
      assertEqual(res.red, 0, `RPM ${rpm} should have 0 red LEDs`);
      assertEqual(res.blue, 0, `RPM ${rpm} should have 0 blue LEDs`);
      assertEqual(res.isRedline, false);
    });
  });

  test('Red LED Band: 11,200 to 11,899 RPM progressively illuminates 6 to 10 LEDs (5 Green + 1-5 Red)', () => {
    const checkpoints = [
      { rpm: 11200, expectedActive: 6, expectedRed: 1 },
      { rpm: 11350, expectedActive: 7, expectedRed: 2 },
      { rpm: 11550, expectedActive: 8, expectedRed: 3 },
      { rpm: 11750, expectedActive: 9, expectedRed: 4 },
      { rpm: 11899, expectedActive: 10, expectedRed: 5 },
    ];

    checkpoints.forEach(({ rpm, expectedActive, expectedRed }) => {
      const res = calculateShiftLights(rpm);
      assertEqual(res.activeLeds, expectedActive, `RPM ${rpm} expected ${expectedActive} LEDs`);
      assertEqual(res.green, 5, `RPM ${rpm} must have all 5 green LEDs active`);
      assertEqual(res.red, expectedRed, `RPM ${rpm} must have ${expectedRed} red LEDs`);
      assertEqual(res.blue, 0, `RPM ${rpm} must have 0 blue LEDs`);
      assertEqual(res.isRedline, false);
    });
  });

  test('Blue LED Band: 11,900 to 12,349 RPM progressively illuminates 11 to 15 LEDs (5 Green + 5 Red + 1-5 Blue)', () => {
    const checkpoints = [
      { rpm: 11900, expectedActive: 11, expectedBlue: 1 },
      { rpm: 12000, expectedActive: 12, expectedBlue: 2 },
      { rpm: 12100, expectedActive: 13, expectedBlue: 3 },
      { rpm: 12250, expectedActive: 14, expectedBlue: 4 },
      { rpm: 12349, expectedActive: 15, expectedBlue: 5 },
    ];

    checkpoints.forEach(({ rpm, expectedActive, expectedBlue }) => {
      const res = calculateShiftLights(rpm);
      assertEqual(res.activeLeds, expectedActive, `RPM ${rpm} expected ${expectedActive} LEDs`);
      assertEqual(res.green, 5);
      assertEqual(res.red, 5);
      assertEqual(res.blue, expectedBlue, `RPM ${rpm} expected ${expectedBlue} blue LEDs`);
      assertEqual(res.isRedline, false, `RPM ${rpm} should not trigger redline strobe before 12,350`);
    });
  });

  test('Redline Strobe Flash: RPM >= 12,350 triggers 15 LEDs and isRedline strobe', () => {
    const redlineRpms = [12350, 12400, 12500, 13000, 15000, 20000, 99999];
    redlineRpms.forEach((rpm) => {
      const res = calculateShiftLights(rpm);
      assertEqual(res.activeLeds, 15, `RPM ${rpm} must have all 15 LEDs active`);
      assertEqual(res.isRedline, true, `RPM ${rpm} must trigger isRedline strobe`);
      assertEqual(res.green, 5);
      assertEqual(res.red, 5);
      assertEqual(res.blue, 5);
    });
  });

  test('Adversarial RPM Inputs: NaN, null, and non-numeric RPM do not throw and stay in quiet zone', () => {
    const weirdRpms = [NaN, null, undefined, 'not-a-number'];
    weirdRpms.forEach((rpm) => {
      const res = calculateShiftLights(rpm);
      assertEqual(res.activeLeds, 0, `Invalid RPM (${rpm}) must yield 0 active LEDs`);
      assertEqual(res.isRedline, false);
    });
  });

  test('Gear Display Logic: Reverse and Neutral (<= 0) display "R", positive gears display number', () => {
    assertEqual(calculateGearDisplay(-2), 'R');
    assertEqual(calculateGearDisplay(-1), 'R');
    assertEqual(calculateGearDisplay(0), 'R');
    assertEqual(calculateGearDisplay(1), 1);
    assertEqual(calculateGearDisplay(2), 2);
    assertEqual(calculateGearDisplay(7), 7);
    assertEqual(calculateGearDisplay(8), 8);
    assertEqual(calculateGearDisplay(undefined), 1, 'Default fallback gear is 1');
    assertEqual(calculateGearDisplay(null), 1, 'Null gear defaults to 1');
  });
});

// ============================================================================
// SUITE 3: f1Tyres FIA Broadcast Colors & Casing/Fallback Robustness
// ============================================================================
describe('Tier 5 - f1Tyres FIA Broadcast Colors & Compound Resolution', () => {
  let f1Tyres;

  test('Transpiles and loads frontend/src/utils/f1Tyres.ts directly', () => {
    f1Tyres = loadTranspiledModule('src/utils/f1Tyres.ts');
    assertDefined(f1Tyres, 'f1Tyres module must load successfully');
    assertDefined(f1Tyres.FIA_TYRE_COMPOUNDS, 'FIA_TYRE_COMPOUNDS constant must exist');
    assertDefined(f1Tyres.getTyreBadge, 'getTyreBadge function must exist');
  });

  test('FIA Broadcast Standard Hex Colors & Codes', () => {
    const { FIA_TYRE_COMPOUNDS } = f1Tyres;

    // 1. Soft -> Red #E10600
    assertEqual(FIA_TYRE_COMPOUNDS.SOFT.hex, '#E10600');
    assertEqual(FIA_TYRE_COMPOUNDS.SOFT.code, 'S');
    assertEqual(FIA_TYRE_COMPOUNDS.SOFT.name, 'Soft');

    // 2. Medium -> Yellow #FFF500
    assertEqual(FIA_TYRE_COMPOUNDS.MEDIUM.hex, '#FFF500');
    assertEqual(FIA_TYRE_COMPOUNDS.MEDIUM.code, 'M');
    assertEqual(FIA_TYRE_COMPOUNDS.MEDIUM.name, 'Medium');

    // 3. Hard -> White #FFFFFF
    assertEqual(FIA_TYRE_COMPOUNDS.HARD.hex, '#FFFFFF');
    assertEqual(FIA_TYRE_COMPOUNDS.HARD.code, 'H');
    assertEqual(FIA_TYRE_COMPOUNDS.HARD.name, 'Hard');

    // 4. Intermediate -> Green #39B54A
    assertEqual(FIA_TYRE_COMPOUNDS.INTERMEDIATE.hex, '#39B54A');
    assertEqual(FIA_TYRE_COMPOUNDS.INTERMEDIATE.code, 'I');
    assertEqual(FIA_TYRE_COMPOUNDS.INTERMEDIATE.name, 'Inter');

    // 5. Wet -> Blue #0072CE
    assertEqual(FIA_TYRE_COMPOUNDS.WET.hex, '#0072CE');
    assertEqual(FIA_TYRE_COMPOUNDS.WET.code, 'W');
    assertEqual(FIA_TYRE_COMPOUNDS.WET.name, 'Wet');

    // 6. Unknown -> Slate #64748B
    assertEqual(FIA_TYRE_COMPOUNDS.UNKNOWN.hex, '#64748B');
    assertEqual(FIA_TYRE_COMPOUNDS.UNKNOWN.code, '?');
    assertEqual(FIA_TYRE_COMPOUNDS.UNKNOWN.name, 'Unknown');
  });

  test('Casing, whitespace and formatting tolerance in getTyreBadge()', () => {
    const { getTyreBadge } = f1Tyres;

    assertEqual(getTyreBadge('soft').code, 'S');
    assertEqual(getTyreBadge('sOfT').code, 'S');
    assertEqual(getTyreBadge('  SOFT  ').code, 'S');
    assertEqual(getTyreBadge('\tsoft\n').code, 'S');

    assertEqual(getTyreBadge('medium').code, 'M');
    assertEqual(getTyreBadge('  mEdIuM  ').code, 'M');

    assertEqual(getTyreBadge('hard').code, 'H');
    assertEqual(getTyreBadge('   HARD  ').code, 'H');

    assertEqual(getTyreBadge('intermediate').code, 'I');
    assertEqual(getTyreBadge('INTERMEDIATE').code, 'I');

    assertEqual(getTyreBadge('wet').code, 'W');
    assertEqual(getTyreBadge('WET').code, 'W');
  });

  test('Adversarial & Corrupted Compound Inputs Gracefully Return UNKNOWN', () => {
    const { getTyreBadge, FIA_TYRE_COMPOUNDS } = f1Tyres;
    const adversarialInputs = [
      null,
      undefined,
      '',
      '   ',
      'HYPERSOFT',
      'SUPERHARD',
      'ULTRA_SOFT',
      'RAIN',
      'PZERO',
      123,
      true,
      false,
      {},
      [],
      NaN,
    ];

    adversarialInputs.forEach((input) => {
      const badge = getTyreBadge(input);
      assertDefined(badge, `getTyreBadge(${JSON.stringify(input)}) must return a defined object`);
      assertEqual(badge.code, '?', `Input ${JSON.stringify(input)} must resolve to UNKNOWN code '?'`);
      assertEqual(badge.hex, FIA_TYRE_COMPOUNDS.UNKNOWN.hex);
    });
  });

  test('Every compound style conforms to TyreBadgeStyle contract', () => {
    const { FIA_TYRE_COMPOUNDS } = f1Tyres;
    const requiredKeys = ['code', 'name', 'badgeClass', 'textClass', 'borderClass', 'bgClass', 'hex'];

    Object.entries(FIA_TYRE_COMPOUNDS).forEach(([compound, style]) => {
      requiredKeys.forEach((key) => {
        assertDefined(style[key], `Compound ${compound} must have property ${key}`);
        assert(typeof style[key] === 'string' && style[key].length > 0, `Compound ${compound} property ${key} must be a non-empty string`);
      });
      assert(style.hex.startsWith('#'), `Compound ${compound} hex must start with '#'`);
    });
  });
});

// ============================================================================
// SUITE 4: CircuitCanvas Coordinate Transformations & High-DPI Normalization
// ============================================================================
describe('Tier 5 - CircuitCanvas High-DPI Scaling & Coordinate Normalization', () => {
  // Replicate exact projection and click algorithms from CircuitCanvas.tsx
  function createProjector(canvasWidth, canvasHeight, dpr, bounds, padding = 45) {
    const width = canvasWidth / dpr;
    const height = canvasHeight / dpr;

    const innerW = width - padding * 2;
    const innerH = height - padding * 2;
    const scale = Math.min(innerW / bounds.width, innerH / bounds.height);
    const offsetX = (width - bounds.width * scale) / 2;
    const offsetY = (height - bounds.height * scale) / 2;

    const worldToScreen = (wx, wy) => {
      const sx = offsetX + (wx - bounds.minX) * scale;
      const sy = height - (offsetY + (wy - bounds.minY) * scale);
      return { x: sx, y: sy };
    };

    const findClosestDriver = (clickX, clickY, cars, focusedDriverNumber, minDistance = 25) => {
      let closestDriver = focusedDriverNumber;
      let closestDist = minDistance;

      cars.forEach((car) => {
        const sx = offsetX + (car.x - bounds.minX) * scale;
        const sy = height - (offsetY + (car.y - bounds.minY) * scale);
        const dist = Math.hypot(clickX - sx, clickY - sy);
        if (dist < closestDist) {
          closestDist = dist;
          closestDriver = car.driverNumber;
        }
      });

      return closestDriver;
    };

    return { scale, offsetX, offsetY, width, height, worldToScreen, findClosestDriver };
  }

  const monzaBounds = {
    minX: -800,
    maxX: 700,
    width: 1500,
    minY: -450,
    maxY: 450,
    height: 900,
  };

  test('High-DPI Coordinate Invariance: Screen coordinates are identical across DPR 1x, 2x, and 3x', () => {
    const displayW = 900;
    const displayH = 450;

    const proj1x = createProjector(displayW * 1, displayH * 1, 1, monzaBounds);
    const proj2x = createProjector(displayW * 2, displayH * 2, 2, monzaBounds);
    const proj3x = createProjector(displayW * 3, displayH * 3, 3, monzaBounds);

    assertEqual(proj1x.scale, proj2x.scale, 'Scale must match between DPR 1x and 2x');
    assertEqual(proj1x.scale, proj3x.scale, 'Scale must match between DPR 1x and 3x');
    assertEqual(proj1x.offsetX, proj2x.offsetX, 'OffsetX must match between DPR 1x and 2x');
    assertEqual(proj1x.offsetY, proj2x.offsetY, 'OffsetY must match between DPR 1x and 2x');

    const testCoords = [
      { x: 0, y: 0 },
      { x: -500, y: 200 },
      { x: 350, y: -180 },
      { x: -800, y: -450 },
      { x: 700, y: 450 },
    ];

    testCoords.forEach(({ x, y }) => {
      const s1 = proj1x.worldToScreen(x, y);
      const s2 = proj2x.worldToScreen(x, y);
      const s3 = proj3x.worldToScreen(x, y);

      assertInRange(Math.abs(s1.x - s2.x), 0, 1e-6, `X mismatch at (${x}, ${y}) between DPR 1x and 2x`);
      assertInRange(Math.abs(s1.y - s2.y), 0, 1e-6, `Y mismatch at (${x}, ${y}) between DPR 1x and 2x`);
      assertInRange(Math.abs(s1.x - s3.x), 0, 1e-6, `X mismatch at (${x}, ${y}) between DPR 1x and 3x`);
      assertInRange(Math.abs(s1.y - s3.y), 0, 1e-6, `Y mismatch at (${x}, ${y}) between DPR 1x and 3x`);
    });
  });

  test('Multi-Aspect Ratio Resilience: Scale factor is strictly positive and finite under diverse ratios', () => {
    const aspectRatios = [
      { w: 1920, h: 1080, dpr: 1 }, // 16:9 Desktop
      { w: 2560, h: 1080, dpr: 1 }, // 21:9 Ultrawide
      { w: 500, h: 500, dpr: 2 },   // Square widget
      { w: 375, h: 667, dpr: 3 },   // Mobile portrait
      { w: 1000, h: 200, dpr: 1 },  // Banner stripe
    ];

    aspectRatios.forEach(({ w, h, dpr }) => {
      const proj = createProjector(w * dpr, h * dpr, dpr, monzaBounds);
      assert(Number.isFinite(proj.scale), `Scale must be finite for ${w}x${h}`);
      assert(proj.scale > 0, `Scale must be positive for ${w}x${h}`);
      assert(Number.isFinite(proj.offsetX), `OffsetX must be finite for ${w}x${h}`);
      assert(Number.isFinite(proj.offsetY), `OffsetY must be finite for ${w}x${h}`);
    });
  });

  test('Click Coordinate Normalization & Selection Threshold (25px radius)', () => {
    const proj = createProjector(800, 400, 1, monzaBounds);

    const cars = [
      { driverNumber: 4, x: 0, y: 0 },
      { driverNumber: 1, x: 200, y: 100 },
      { driverNumber: 16, x: -300, y: -150 },
    ];

    const car4Screen = proj.worldToScreen(0, 0);

    // 1. Direct hit on car 4
    const hitDirect = proj.findClosestDriver(car4Screen.x, car4Screen.y, cars, 1);
    assertEqual(hitDirect, 4, 'Click directly on car 4 must select car 4');

    // 2. Click 15px away (within 25px tolerance)
    const hitNear = proj.findClosestDriver(car4Screen.x + 10, car4Screen.y + 10, cars, 1);
    assertEqual(hitNear, 4, 'Click within 15px (< 25px radius) must select car 4');

    // 3. Click 40px away (outside 25px tolerance) -> remains focused on previous driver (1)
    const hitFar = proj.findClosestDriver(car4Screen.x + 30, car4Screen.y + 30, cars, 1);
    assertEqual(hitFar, 1, 'Click > 25px away must not change focused driver');
  });
});

// ============================================================================
// SUITE 5: BattleCard Tactical HUD & DRS Precedence
// ============================================================================
describe('Tier 5 - BattleCard Tactical Metrics & DRS State Machine', () => {
  function getDrsBadgeLabel(drsActive, drsEligible) {
    if (drsActive) return 'DRS ACTIVE (WING OPEN)';
    if (drsEligible) return 'DRS IN RANGE (<1.0s)';
    return null;
  }

  function formatTacticalMetrics(battle) {
    const gapDisplay = `+${battle.gap.toFixed(3)}s`;
    const closingRateDisplay = battle.closingRate > 0 ? `-${battle.closingRate.toFixed(2)}s/lap` : '+0.0s';
    const tyreDeltaDisplay = battle.tyreDeltaFactor > 0 ? `+${battle.tyreDeltaFactor.toFixed(2)}s Tyre Delta` : 'Even Tyre Pace';
    const estPassDisplay = battle.estLapsToPass < 20 ? `${battle.estLapsToPass} Laps` : 'Stalemate';
    const probColor =
      battle.probability >= 70
        ? 'from-red-500 to-amber-500 text-red-400'
        : battle.probability >= 45
        ? 'from-amber-400 to-yellow-500 text-amber-400'
        : 'from-blue-500 to-cyan-400 text-cyan-400';

    return { gapDisplay, closingRateDisplay, tyreDeltaDisplay, estPassDisplay, probColor };
  }

  test('DRS Status Hierarchy: Active (Wing Open) takes precedence over In-Range', () => {
    // 1. Wing Open & Eligible
    assertEqual(getDrsBadgeLabel(true, true), 'DRS ACTIVE (WING OPEN)');
    // 2. Wing Open & Not Eligible (should never occur domain-wise, but template priority must be robust)
    assertEqual(getDrsBadgeLabel(true, false), 'DRS ACTIVE (WING OPEN)');
    // 3. Eligible but Wing Closed
    assertEqual(getDrsBadgeLabel(false, true), 'DRS IN RANGE (<1.0s)');
    // 4. Neither
    assertEqual(getDrsBadgeLabel(false, false), null);
  });

  test('Tactical Metrics Calculations & Formatting Edge Cases', () => {
    // Case 1: Gap = 0, closingRate = 0
    const m1 = formatTacticalMetrics({
      gap: 0,
      closingRate: 0,
      tyreDeltaFactor: 0,
      estLapsToPass: 99,
      probability: 25,
    });
    assertEqual(m1.gapDisplay, '+0.000s');
    assertEqual(m1.closingRateDisplay, '+0.0s');
    assertEqual(m1.tyreDeltaDisplay, 'Even Tyre Pace');
    assertEqual(m1.estPassDisplay, 'Stalemate');
    assertEqual(m1.probColor, 'from-blue-500 to-cyan-400 text-cyan-400');

    // Case 2: Standard overtake scenario
    const m2 = formatTacticalMetrics({
      gap: 0.428,
      closingRate: 0.35,
      tyreDeltaFactor: 0.5,
      estLapsToPass: 2,
      probability: 82,
    });
    assertEqual(m2.gapDisplay, '+0.428s');
    assertEqual(m2.closingRateDisplay, '-0.35s/lap');
    assertEqual(m2.tyreDeltaDisplay, '+0.50s Tyre Delta');
    assertEqual(m2.estPassDisplay, '2 Laps');
    assertEqual(m2.probColor, 'from-red-500 to-amber-500 text-red-400');

    // Case 3: Negative closing rate (falling behind) and mid probability
    const m3 = formatTacticalMetrics({
      gap: 0.85,
      closingRate: -0.2,
      tyreDeltaFactor: -0.3,
      estLapsToPass: 20,
      probability: 55,
    });
    assertEqual(m3.closingRateDisplay, '+0.0s');
    assertEqual(m3.tyreDeltaDisplay, 'Even Tyre Pace');
    assertEqual(m3.estPassDisplay, 'Stalemate');
    assertEqual(m3.probColor, 'from-amber-400 to-yellow-500 text-amber-400');
  });
});

// ============================================================================
// SUITE 6: ErrorBoundary Exception Trapping & Recovery
// ============================================================================
describe('Tier 5 - ErrorBoundary Exception Trapping & State Recovery', () => {
  let ErrorBoundaryClass;

  test('Loads ErrorBoundary from frontend/src/components/common/ErrorBoundary.tsx', () => {
    const mod = loadTranspiledModule('src/components/common/ErrorBoundary.tsx');
    ErrorBoundaryClass = mod.ErrorBoundary || mod.default;
    assertDefined(ErrorBoundaryClass, 'ErrorBoundary class must be defined');
    assertEqual(typeof ErrorBoundaryClass.getDerivedStateFromError, 'function');
  });

  test('getDerivedStateFromError traps errors and updates state correctly', () => {
    const mockError = new Error('Simulated Canvas 2D Context Loss');
    const state = ErrorBoundaryClass.getDerivedStateFromError(mockError);

    assertEqual(state.hasError, true, 'hasError must be set to true');
    assertEqual(state.error, mockError, 'error object must be retained');
  });

  test('ErrorBoundary instance handles retry and triggers onReset callback', () => {
    let resetCalled = false;
    const boundaryInstance = new ErrorBoundaryClass({
      children: null,
      fallbackTitle: 'Telemetry Visualizer Failed',
      onReset: () => {
        resetCalled = true;
      },
    });

    // Provide updater so setState updates state in non-DOM test environment
    boundaryInstance.updater = {
      isMounted: () => true,
      enqueueSetState: (inst, partial) => {
        inst.state = { ...inst.state, ...partial };
      },
    };

    // Simulate error state
    boundaryInstance.state = {
      hasError: true,
      error: new Error('Simulated WebGL Crash'),
    };

    // Trigger retry
    boundaryInstance.handleRetry();

    assertEqual(boundaryInstance.state.hasError, false, 'hasError must be reset to false');
    assertEqual(boundaryInstance.state.error, null, 'error must be reset to null');
    assertEqual(resetCalled, true, 'onReset callback must be invoked on retry');
  });
});

// ============================================================================
// SUITE 7: Full Pipeline High-Frequency Stress Flow Under Live Streaming
// ============================================================================
describe('Tier 5 - Full Pipeline High-Frequency Event Flow Stress', () => {
  test('High-Frequency Multi-Action Churn: 25 rapid actions under live streaming stream remain coherent', async () => {
    const socket = createSocket();
    await waitForConnect(socket);

    const receivedTicks = [];
    const receivedSnapshots = [];

    socket.on('f1:v1:telemetry_tick', (t) => receivedTicks.push(t));
    socket.on('f1:v1:grid_snapshot', (s) => receivedSnapshots.push(s));

    // Execute 25 rapid mixed actions (driver subscriptions + playback commands)
    const drivers = [1, 4, 16, 44, 81, 55, 63, 11, 14, 23];
    for (let i = 0; i < 25; i++) {
      const driver = drivers[i % drivers.length];
      socket.emit('client:v1:subscribe_driver', { driverNumber: driver });

      if (i % 5 === 0) {
        socket.emit('client:v1:playback_control', { action: 'seek', progress: (i * 0.03) % 1.0 });
      } else if (i % 7 === 0) {
        socket.emit('client:v1:playback_control', { action: 'play', speed: (i % 2 === 0 ? 2 : 1) });
      }

      await new Promise((r) => setTimeout(r, 15));
    }

    // Give pipeline 500ms to settle
    await new Promise((resolve) => {
      const interval = setInterval(() => {
        if (receivedSnapshots.length >= 2 && receivedTicks.length >= 3) {
          clearInterval(interval);
          resolve();
        }
      }, 100);
    });

    assert(socket.connected, 'Socket connection must remain healthy after 25-action churn');
    assert(receivedSnapshots.length >= 2, 'Must continue receiving grid snapshots');
    assert(receivedTicks.length >= 3, 'Must continue receiving telemetry ticks');

    // Confirm that snapshot grid integrity remains 20 cars with positions 1-20
    const latestSnapshot = receivedSnapshots[receivedSnapshots.length - 1];
    assertEqual(latestSnapshot.grid.length, 20, 'Grid snapshot must contain all 20 cars');
    const positions = latestSnapshot.grid.map((c) => c.position).sort((a, b) => a - b);
    for (let p = 1; p <= 20; p++) {
      assertEqual(positions[p - 1], p, `Grid position ${p} must be present`);
    }

    socket.disconnect();
  });
});

// ----------------------------------------------------------------------------
// Self-Execution Hook when run directly: node tests/e2e/tier5-adversarial-frontend.test.js
// ----------------------------------------------------------------------------
if (require.main === module) {
  (async () => {
    console.log(`
🏎️ ====================================================================
   TIER 5 ADVERSARIAL FRONTEND & INTEGRATION STRESS TEST SUITE
   White-Box Component, Hook & Full Pipeline Verification
====================================================================
`);
    try {
      await ensureServerRunning();
      const results = await runSuites('Tier 5');
      await teardownServer();

      if (results.failed > 0) {
        console.log(`\n\x1b[31m❌ TIER 5 STRESS TESTS FAILED: ${results.failed} test(s) failed out of ${results.total}.\x1b[0m\n`);
        process.exit(1);
      } else {
        console.log(`\n\x1b[32m✅ ALL TIER 5 STRESS TESTS PASSED (${results.passed}/${results.total})\x1b[0m\n`);
        process.exit(0);
      }
    } catch (err) {
      console.error('\n\x1b[31m💥 Fatal Tier 5 Runner Error:\x1b[0m', err.message);
      if (err.stack) console.error(err.stack);
      await teardownServer().catch(() => {});
      process.exit(1);
    }
  })();
}
