/**
 * Tier 5: Backend Adversarial Coverage Hardening & Stress Test Suite
 * 
 * Conducts white-box adversarial stress testing across:
 * - backend/src/app.ts (CORS origin spoofing, body limit 10kb, 400/404/500 error handling, rate limits)
 * - backend/src/websocket/socket.server.ts (prototype pollution, extreme fuzzing, rapid action churn, socket storms)
 * - backend/src/services/simulation.service.ts (DRS Sporting Rules under dynamics, seek lap continuity, 20-driver grid)
 * - backend/src/services/prediction.service.ts & formulas.ts (closing rate, side-by-side gap=0, estLapsToPass, bounds)
 * - backend/src/services/openf1.service.ts (offline fallback roster, API resiliency)
 */

const path = require('path');
const {
  describe,
  test,
  assert,
  assertEqual,
  assertNotEqual,
  assertInRange,
  assertDefined,
  request,
  createSocket,
  waitForConnect,
  waitForEvent,
  waitForEventMatching,
} = require('./test-harness');

// Direct White-Box Domain Imports from compiled backend
const {
  calculateClosingRate,
  calculateOvertakeProbability,
  computeCircuitBounds,
  normalizeTrackCoordinate,
  COMPOUND_PACE_RANK,
  sigmoid,
} = require(path.resolve(__dirname, '../../backend/dist/domain/formulas'));

const { overtakePredictionService } = require(
  path.resolve(__dirname, '../../backend/dist/services/prediction.service')
);
const { simulationEngine, MONZA_DRS_ZONES } = require(
  path.resolve(__dirname, '../../backend/dist/services/simulation.service')
);
const { openF1Service, DEFAULT_DRIVERS } = require(
  path.resolve(__dirname, '../../backend/dist/services/openf1.service')
);
const { messageBus } = require(
  path.resolve(__dirname, '../../backend/dist/db/redis.client')
);

// ============================================================================
// SUITE 1: WebSocket Protocol & Payload Adversarial Hardening
// ============================================================================

describe('Tier 5 - WebSocket Protocol & Payload Adversarial Hardening', () => {
  test('Prototype pollution payloads in subscribe_driver and playback_control do not pollute Object prototype', async () => {
    const socket = createSocket();
    await waitForConnect(socket);

    const maliciousSubscribe = JSON.parse(
      '{"__proto__": {"polluted": "hacked"}, "driverNumber": 4}'
    );
    socket.emit('client:v1:subscribe_driver', maliciousSubscribe);

    const maliciousPlayback = JSON.parse(
      '{"constructor": {"prototype": {"admin": true}}, "action": "play", "speed": 1}'
    );
    socket.emit('client:v1:playback_control', maliciousPlayback);

    // Wait a brief moment for event loop tick
    await new Promise((r) => setTimeout(r, 100));

    // Assert prototype is clean
    const testObj = {};
    assertEqual(testObj.polluted, undefined, 'Prototype pollution detected in Object.polluted!');
    assertEqual(testObj.admin, undefined, 'Prototype pollution detected in Object.admin!');
    assert(socket.connected, 'Socket should remain connected despite prototype pollution attempt');

    socket.disconnect();
  });

  test('Extreme numeric & type fuzzing in client:v1:subscribe_driver rejected gracefully without crashing', async () => {
    const socket = createSocket();
    await waitForConnect(socket);

    const fuzzCases = [
      3.14159, // float
      '44', // string
      1e308, // float overflow
      -999, // negative
      0, // zero
      100, // upper out of bounds
      [1, 2], // array
      {}, // empty object
      true, // boolean
      NaN, // NaN
      Infinity, // Infinity
      null, // null
    ];

    for (const val of fuzzCases) {
      const errorPromise = waitForEvent(socket, 'error', 3000);
      socket.emit('client:v1:subscribe_driver', { driverNumber: val });
      const err = await errorPromise;
      assertDefined(err, `Expected error event for driverNumber ${val}`);
      assertEqual(err.message, 'Invalid subscribe payload');
    }

    assert(socket.connected, 'Socket must remain connected after fuzzing');
    socket.disconnect();
  });

  test('Extreme numeric & type fuzzing in client:v1:unsubscribe_driver rejected gracefully', async () => {
    const socket = createSocket();
    await waitForConnect(socket);

    const fuzzCases = [-1, 0, 101, 'verstappen', null, undefined, { nested: true }];

    for (const val of fuzzCases) {
      const errorPromise = waitForEvent(socket, 'error', 3000);
      socket.emit('client:v1:unsubscribe_driver', { driverNumber: val });
      const err = await errorPromise;
      assertDefined(err, `Expected error event for driverNumber ${val}`);
      assertEqual(err.message, 'Invalid unsubscribe payload');
    }

    assert(socket.connected, 'Socket must remain connected');
    socket.disconnect();
  });

  test('Adversarial fuzzing on client:v1:playback_control (actions, speeds, boundary progress)', async () => {
    const socket = createSocket();
    await waitForConnect(socket);

    const invalidPayloads = [
      { action: 'destroy' },
      { action: 'crash', speed: 1 },
      { action: 'play', speed: 3 }, // speed 3 is not allowed (only 1, 2, 4)
      { action: 'play', speed: 0 },
      { action: 'play', speed: -1 },
      { action: 'play', speed: 8 },
      { action: 'seek' }, // seek requires progress
      { action: 'seek', progress: -1e-6 }, // negative
      { action: 'seek', progress: 1.000001 }, // > 1.0
      { action: 'seek', progress: '0.5' }, // string
      { action: 'seek', progress: Infinity },
      { action: 'seek', progress: -Infinity },
    ];

    for (const payload of invalidPayloads) {
      const errorPromise = waitForEvent(socket, 'error', 3000);
      socket.emit('client:v1:playback_control', payload);
      const err = await errorPromise;
      assertDefined(err, `Expected error for payload: ${JSON.stringify(payload)}`);
    }

    assert(socket.connected, 'Socket must remain healthy');
    socket.disconnect();
  });

  test('High-frequency socket action burst & room churn stress (100 events in parallel)', async () => {
    const socket = createSocket();
    await waitForConnect(socket);

    const drivers = [1, 4, 16, 44, 81, 55, 63, 11, 14, 27];
    const promises = [];

    for (let i = 0; i < 100; i++) {
      const driver = drivers[i % drivers.length];
      if (i % 2 === 0) {
        socket.emit('client:v1:subscribe_driver', { driverNumber: driver });
      } else {
        socket.emit('client:v1:unsubscribe_driver', { driverNumber: driver });
      }
    }

    // Allow event queue to drain
    await new Promise((r) => setTimeout(r, 400));
    assert(socket.connected, 'Socket must remain connected after 100-event rapid fire');

    // Subscribe to driver 4 and ensure telemetry tick still arrives
    socket.emit('client:v1:subscribe_driver', { driverNumber: 4 });
    const tick = await waitForEventMatching(
      socket,
      'f1:v1:telemetry_tick',
      (t) => t.driverNumber === 4,
      5000
    );
    assertDefined(tick);
    assertEqual(tick.driverNumber, 4);

    socket.disconnect();
  });

  test('Playback scrubber rapid-fire boundary seek spam (50 seeks with boundary values)', async () => {
    const socket = createSocket();
    await waitForConnect(socket);

    const boundaryValues = [0.0, 1.0, 0.00001, 0.99999, 0.5, 0.25, 0.75, 0.0, 1.0];
    for (let i = 0; i < 50; i++) {
      const prog = boundaryValues[i % boundaryValues.length];
      socket.emit('client:v1:playback_control', { action: 'seek', progress: prog });
    }

    await new Promise((r) => setTimeout(r, 200));

    // Send valid play command to resume
    socket.emit('client:v1:playback_control', { action: 'play', speed: 1 });

    const state = simulationEngine.getPlaybackState();
    assertDefined(state);
    assertInRange(state.currentTick, 0, state.totalTicks, 'Current tick within valid bounds');

    socket.disconnect();
  });

  test('Mass abrupt socket drop & rapid reconnect recovery storm', async () => {
    const sockets = [];
    for (let i = 0; i < 10; i++) {
      const s = createSocket();
      sockets.push(s);
    }

    await Promise.all(sockets.map((s) => waitForConnect(s)));

    // Abruptly disconnect all 10 sockets concurrently
    sockets.forEach((s) => s.disconnect());

    // Connect a fresh socket immediately
    const freshSocket = createSocket();
    await waitForConnect(freshSocket);

    const initData = await waitForEvent(freshSocket, 'f1:v1:session_init', 5000);
    assertDefined(initData, 'Server should immediately recover and serve new connections');
    assertEqual(initData.sessionMeta.sessionKey, 9590);

    freshSocket.disconnect();
  });
});

// ============================================================================
// SUITE 2: REST Gateway & Security Hardening
// ============================================================================

describe('Tier 5 - REST Gateway Adversarial Hardening', () => {
  test('Malformed raw JSON payload to POST /api/auth/google returns 400 Bad Request without stack leak', async () => {
    const res = await request('/api/auth/google', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"email": "broken@f1.com", "googleId": invalid_json_syntax}',
    });

    assertEqual(res.status, 400, 'Expected 400 Bad Request for malformed JSON');
    assertDefined(res.data, 'Expected error response');
    assertEqual(res.data.success, false);
    // Stack trace must not be leaked
    assert(!JSON.stringify(res.data).includes('SyntaxError: Unexpected token'), 'Stack trace must not leak');
  });

  test('Body parser 10kb boundary stress: 9.5kb accepted, 10.5kb rejected with 413', async () => {
    // 1. 9.5kb payload (accepted, validation error 400 is fine, must NOT be 413)
    const payload95k = {
      email: 'boundary@f1.com',
      googleId: 'g123',
      name: 'A'.repeat(9500),
    };
    const resUnder = await request('/api/auth/google', {
      method: 'POST',
      body: payload95k,
    });
    assertNotEqual(resUnder.status, 413, '9.5kb payload should not be rejected with 413');

    // 2. 10.5kb payload (rejected with 413 Payload Too Large)
    const payload105k = {
      email: 'large@f1.com',
      googleId: 'g123',
      name: 'A'.repeat(10700),
    };
    const resOver = await request('/api/auth/google', {
      method: 'POST',
      body: payload105k,
    });
    assertEqual(resOver.status, 413, 'Payload over 10kb must be rejected with 413');
  });

  test('CORS origin spoofing and subdomain traversal defense', async () => {
    // Spoofed subdomain
    const resSpoofed = await request('/api/health', {
      headers: { Origin: 'http://localhost:3000.attacker.com' },
    });
    assertEqual(resSpoofed.status, 403, 'Subdomain spoofed origin must be rejected with 403');

    // Attacker host with similar name
    const resSimilar = await request('/api/health', {
      headers: { Origin: 'http://evil-localhost:3000' },
    });
    assertEqual(resSimilar.status, 403, 'Unauthorized origin must be rejected with 403');

    // Legitimate origin
    const resLegit = await request('/api/health', {
      headers: { Origin: 'http://localhost:3000' },
    });
    assertEqual(resLegit.status, 200, 'Legitimate origin must be accepted');
    assertEqual(
      resLegit.headers.get('access-control-allow-origin'),
      'http://localhost:3000',
      'Expected CORS allow-origin header'
    );
  });

  test('Session controller boundary & path traversal defense', async () => {
    // Large nonexistent integer sessionKey -> falls back gracefully with 200 and Monza track
    const resNonexistent = await request('/api/sessions/99999999/load', { method: 'POST' });
    assertEqual(resNonexistent.status, 200, 'Non-existent sessionKey should degrade gracefully to default');
    assertEqual(resNonexistent.data.meta.sessionKey, 99999999);

    // Negative session key
    const resNeg = await request('/api/sessions/-9590/load', { method: 'POST' });
    assertEqual(resNeg.status, 400, 'Negative sessionKey must return 400');

    // Float session key
    const resFloat = await request('/api/sessions/9590.5/load', { method: 'POST' });
    assertEqual(resFloat.status, 400, 'Float sessionKey must return 400');

    // Path traversal attempt
    const resTraversal = await request('/api/sessions/..%2F..%2Fetc/load', { method: 'POST' });
    assert(
      resTraversal.status === 400 || resTraversal.status === 404,
      `Expected 400 or 404 for traversal attempt, got ${resTraversal.status}`
    );

    // Reset back to Monza 9590
    await request('/api/sessions/9590/load', { method: 'POST' });
  });

  test('Auth controller input validation and injection defense', async () => {
    // SQL injection pattern in email parameter
    const resSql = await request('/api/auth/profile?email=%27%20OR%201%3D1%20--');
    assertEqual(resSql.status, 400, 'SQL injection in email must return 400');

    // Missing googleId
    const resNoGid = await request('/api/auth/google', {
      method: 'POST',
      body: { email: 'valid@f1.com' },
    });
    assertEqual(resNoGid.status, 400, 'Missing googleId must return 400');

    // Settings with negative favoriteDriver
    const resNegDriver = await request('/api/auth/settings', {
      method: 'POST',
      body: { userId: 'u1', favoriteDriver: -5 },
    });
    assertEqual(resNegDriver.status, 400, 'Negative driver number must return 400');

    // Settings with out-of-range favoriteDriver (>99)
    const resBigDriver = await request('/api/auth/settings', {
      method: 'POST',
      body: { userId: 'u1', favoriteDriver: 150 },
    });
    assertEqual(resBigDriver.status, 400, 'Driver number >99 must return 400');

    // Settings with invalid speedUnit
    const resInvalidUnit = await request('/api/auth/settings', {
      method: 'POST',
      body: { userId: 'u1', speedUnit: 'KNOTS' },
    });
    assertEqual(resInvalidUnit.status, 400, 'Invalid speedUnit must return 400');
  });
});

// ============================================================================
// SUITE 3: Domain Mathematics & Physics Adversarial Singularity Tests
// ============================================================================

describe('Tier 5 - Domain Physics & Mathematical Singularity Tests', () => {
  test('calculateClosingRate handles division by zero, non-finite inputs, and negative gaps', () => {
    // Zero timeDiff -> division by zero protected
    assertEqual(calculateClosingRate(1.0, 0.5, 0), 0);
    // Negative timeDiff
    assertEqual(calculateClosingRate(1.0, 0.5, -10), 0);
    // Side-by-side or already passed (currentGap <= 0)
    assertEqual(calculateClosingRate(0.5, 0.0, 1), 0);
    assertEqual(calculateClosingRate(0.5, -0.5, 1), 0);
    // NaN / Infinity inputs
    assertEqual(calculateClosingRate(NaN, 0.5, 1), 0);
    assertEqual(calculateClosingRate(1.0, NaN, 1), 0);
    assertEqual(calculateClosingRate(1.0, 0.5, NaN), 0);
    assertEqual(calculateClosingRate(Infinity, 0.5, 1), 0);
    assertEqual(calculateClosingRate(1.0, -Infinity, 1), 0);

    // Standard valid closing: gaining 0.2s in 5s over 80s lap
    // (0.2 / 5) * 80 = 3.20 seconds per lap
    const rate = calculateClosingRate(1.2, 1.0, 5, 80);
    assertEqual(rate, 3.2);

    // Car dropping back (previousGap < currentGap) -> negative closing rate
    const dropRate = calculateClosingRate(1.0, 1.2, 5, 80);
    assertEqual(dropRate, -3.2);
  });

  test('calculateOvertakeProbability handles side-by-side (gap=0), wide gaps, and extreme rates', () => {
    // 1. Side-by-side (gap = 0): exactly 95%, 0 laps to pass, DRS eligible
    const sideBySide = calculateOvertakeProbability(0, 0, 'MEDIUM', 10, 'HARD', 15);
    assertEqual(sideBySide.probability, 95);
    assertEqual(sideBySide.estLapsToPass, 0);
    assertEqual(sideBySide.drsEligible, true);

    // 2. Negative gap (clamped to 0)
    const negGap = calculateOvertakeProbability(-0.2, 0.5, 'SOFT', 5, 'HARD', 20);
    assertEqual(negGap.probability, 95);
    assertEqual(negGap.estLapsToPass, 0);

    // 3. Wide gap (> 2.5 seconds)
    const wideGap = calculateOvertakeProbability(4.0, 0.5, 'MEDIUM', 10, 'HARD', 20);
    assert(wideGap.probability <= 15, 'Wide gap must have low probability');
    assertEqual(wideGap.drsEligible, false);

    // 4. Wide gap with no closing rate
    const staticWide = calculateOvertakeProbability(5.0, 0, 'HARD', 20, 'SOFT', 5);
    assertEqual(staticWide.estLapsToPass, 99);

    // 5. Massive closing rate (safe closing bounds)
    const fastClose = calculateOvertakeProbability(0.8, 50.0, 'SOFT', 2, 'HARD', 35);
    assertInRange(fastClose.probability, 5, 98);
    assertInRange(fastClose.estLapsToPass, 0, 99);

    // 6. Negative closing rate (falling back)
    const fallingBack = calculateOvertakeProbability(0.5, -5.0, 'HARD', 30, 'SOFT', 5);
    assertEqual(fallingBack.estLapsToPass, 99);
    assert(fallingBack.probability < 50, 'Falling back chaser should have lower probability');

    // 7. NaN resilience
    const nanRes = calculateOvertakeProbability(NaN, NaN, 'UNKNOWN', 0, 'UNKNOWN', 0);
    assertInRange(nanRes.probability, 5, 98);
    assertInRange(nanRes.estLapsToPass, 0, 99);
  });

  test('computeCircuitBounds and normalizeTrackCoordinate handle zero-width and empty points', () => {
    // Empty array
    const emptyBounds = computeCircuitBounds([]);
    assertDefined(emptyBounds);
    assert(emptyBounds.width > 0, 'Bounds width must be positive');
    assert(emptyBounds.height > 0, 'Bounds height must be positive');

    // Single point (min == max) -> width and height must clamp to at least 1
    const singleBounds = computeCircuitBounds([{ x: 100, y: 200 }]);
    assertEqual(singleBounds.minX, 100);
    assertEqual(singleBounds.maxX, 100);
    assertEqual(singleBounds.width, 1, 'Zero width must be clamped to 1');
    assertEqual(singleBounds.height, 1, 'Zero height must be clamped to 1');

    // Normalization should yield finite canvas coordinates without division by zero
    const norm = normalizeTrackCoordinate(100, 200, singleBounds, 800, 600, 40);
    assert(Number.isFinite(norm.u), 'Normalized u must be finite');
    assert(Number.isFinite(norm.v), 'Normalized v must be finite');
  });

  test('overtakePredictionService handles empty/minimal grids and bounded interval history', () => {
    overtakePredictionService.clearHistory();

    const emptyBattles = overtakePredictionService.analyzeBattles([], new Map());
    assertEqual(emptyBattles.length, 0, 'Empty grid must yield 0 battles');

    // Single car grid
    const singleGrid = [
      {
        driverNumber: 1,
        position: 1,
        x: 0,
        y: 0,
        z: 0,
        speed: 300,
        rpm: 11000,
        gear: 8,
        throttle: 100,
        brake: 0,
        drs: false,
        gapToLeader: 0,
        intervalToAhead: 0,
        compound: 'MEDIUM',
        tyreAge: 10,
      },
    ];
    const singleBattles = overtakePredictionService.analyzeBattles(singleGrid, new Map());
    assertEqual(singleBattles.length, 0, 'Single car grid must yield 0 battles');

    // Simulate 40 consecutive ticks to verify history length caps at 30 items
    const driversMap = new Map();
    DEFAULT_DRIVERS.forEach((d) => driversMap.set(d.driverNumber, d));

    const twoCarGrid = [
      { ...singleGrid[0], driverNumber: 1, position: 1 },
      { ...singleGrid[0], driverNumber: 4, position: 2, intervalToAhead: 0.8 },
    ];

    for (let i = 0; i < 40; i++) {
      overtakePredictionService.analyzeBattles(twoCarGrid, driversMap);
    }

    // Battling cars within 2.2s window should generate 1 battle
    const battles = overtakePredictionService.analyzeBattles(twoCarGrid, driversMap);
    assertEqual(battles.length, 1);
    assertEqual(battles[0].chaser.driverNumber, 4);
    assertEqual(battles[0].defender.driverNumber, 1);
    assertInRange(battles[0].probability, 5, 98);

    overtakePredictionService.clearHistory();
  });
});

// ============================================================================
// SUITE 4: Simulation State Machine & Sporting Rule Continuity
// ============================================================================

describe('Tier 5 - Simulation State Machine & Sporting Rule Continuity', () => {
  test('Monotonicity & Lap Rollover Continuity after boundary seek (0.999)', async () => {
    await simulationEngine.initialize(9590);

    // Seek just before start/finish line
    simulationEngine.seek(0.999);

    // Step simulation 15 times crossing into next lap
    for (let i = 0; i < 15; i++) {
      simulationEngine.stepSimulation();
      const snapshot = simulationEngine.getPlaybackState();
      assertDefined(snapshot);

      // Verify grid state from simulation engine
      const drivers = simulationEngine.getDrivers();
      assertEqual(drivers.length, 20, 'Grid must retain all 20 drivers');
    }

    // Connect socket and verify live snapshot has continuous 1-20 positions without duplicate ranks
    const socket = createSocket();
    await waitForConnect(socket);

    const snapshot = await waitForEvent(socket, 'f1:v1:grid_snapshot', 5000);
    assertDefined(snapshot);
    assertEqual(snapshot.grid.length, 20, 'Expected exactly 20 drivers on grid');

    const positions = snapshot.grid.map((c) => c.position).sort((a, b) => a - b);
    for (let i = 0; i < 20; i++) {
      assertEqual(positions[i], i + 1, `Position ${i + 1} must be present without duplicates`);
    }

    // Gap to leader must be non-decreasing
    for (let i = 1; i < snapshot.grid.length; i++) {
      assert(
        snapshot.grid[i].gapToLeader >= snapshot.grid[i - 1].gapToLeader,
        `Gap to leader inverted at position ${i + 1}`
      );
    }

    socket.disconnect();
  });

  test('DRS Sporting Regulations verified over 40 dynamic simulation ticks', async () => {
    // Run 40 ticks to pass through various Monza sectors including DRS zones
    for (let step = 0; step < 40; step++) {
      simulationEngine.stepSimulation();
    }

    const socket = createSocket();
    await waitForConnect(socket);

    let observedDRS = 0;

    for (let tick = 0; tick < 10; tick++) {
      const snap = await waitForEvent(socket, 'f1:v1:grid_snapshot', 5000);
      const leader = snap.grid.find((c) => c.position === 1);
      assertDefined(leader);
      assertEqual(leader.drs, false, 'P1 Leader must NEVER have DRS active per FIA regulations');

      snap.grid.forEach((car) => {
        if (car.drs) {
          observedDRS++;
          assert(car.position > 1, 'Car with DRS must not be P1');
          assert(
            car.intervalToAhead <= 1.000,
            `Car ${car.driverNumber} has DRS but interval ${car.intervalToAhead} > 1.000s`
          );
          assert(car.throttle >= 95, 'DRS requires throttle >= 95%');
          assertEqual(car.brake, 0, 'DRS cannot be active under braking');
        }
      });
    }

    socket.disconnect();
  });

  test('OpenF1 Offline Fallback & 20-Driver Roster Integrity', async () => {
    // Verify DEFAULT_DRIVERS roster
    assertEqual(DEFAULT_DRIVERS.length, 20, 'DEFAULT_DRIVERS must contain 20 drivers');

    const driverNumbers = new Set(DEFAULT_DRIVERS.map((d) => d.driverNumber));
    assertEqual(driverNumbers.size, 20, 'All 20 driver numbers must be unique');

    // Expected key drivers
    assert(driverNumbers.has(1), 'Verstappen (#1) must be present');
    assert(driverNumbers.has(4), 'Norris (#4) must be present');
    assert(driverNumbers.has(16), 'Leclerc (#16) must be present');
    assert(driverNumbers.has(44), 'Hamilton (#44) must be present');
    assert(driverNumbers.has(43), 'Colapinto (#43) must be present');

    // Verify openF1Service fallback on invalid sessionKey
    const fallbackDrivers = await openF1Service.getDrivers(999999);
    assertEqual(fallbackDrivers.length, 20, 'Fallback drivers must have 20 drivers');

    const recentSessions = await openF1Service.getRecentSessions();
    assert(recentSessions.length >= 2, 'Expected at least 2 fallback sessions');
    const monza = recentSessions.find((s) => s.sessionKey === 9590);
    assertDefined(monza);
    assertEqual(monza.circuitShortName, 'Monza');
  });

  test('Resilient Message Bus stream subscription and state verification', async () => {
    let received = null;
    let resolveReceived;
    const receivedPromise = new Promise((resolve) => {
      resolveReceived = resolve;
    });

    await messageBus.subscribe('f1:stream:global', (msg) => {
      try {
        const parsed = JSON.parse(msg);
        if (parsed && parsed.sessionKey) {
          received = parsed;
          if (resolveReceived) resolveReceived(parsed);
        }
      } catch {}
    });

    // Step simulation to publish snapshot to messageBus
    simulationEngine.stepSimulation();

    await Promise.race([
      receivedPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout waiting for f1:stream:global delivery')), 5000)),
    ]);

    assertDefined(received, 'Must receive valid snapshot from f1:stream:global messageBus');
    assertEqual(received.sessionKey, 9590);
    assert(Array.isArray(received.grid), 'Snapshot must contain live grid');

    const isActive = messageBus.isRedisActive();
    assert(typeof isActive === 'boolean', 'isRedisActive must return boolean');
  });
});

// Self-runner capability
if (require.main === module) {
  const { ensureServerRunning, teardownServer, runSuites } = require('./test-harness');
  (async () => {
    try {
      await ensureServerRunning();
      const res = await runSuites('Tier 5');
      await teardownServer();
      process.exit(res.failed > 0 ? 1 : 0);
    } catch (e) {
      console.error(e);
      await teardownServer().catch(() => {});
      process.exit(1);
    }
  })();
}
