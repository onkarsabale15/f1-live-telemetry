/**
 * Tier 4: Real-World Scenarios & F1 Domain Integrity Verification Suite
 * 
 * Verifies high-fidelity domain behavior against FIA Sporting Regulations:
 * - Race continuity: Grid ranking 1-20, timing gaps, leader interval=0
 * - Sector-dependent DRS eligibility (leader never has DRS, interval <= 1.0s) (F13)
 * - FIA broadcast tyre compound color standards (F17)
 * - Cockpit telemetry physical realism (speed, RPM, gear, throttle, brake)
 * - Overtake battle prediction mathematical sanity (no division-by-zero NaN/Infinity) (F10)
 */

const {
  describe,
  test,
  assert,
  assertEqual,
  assertDefined,
  assertInRange,
  createSocket,
  waitForConnect,
  waitForEvent,
  waitForEventMatching,
} = require('./test-harness');

describe('Tier 4 - Real-World Scenarios & F1 Domain Integrity', () => {
  test('Full Race Continuity: Grid maintains continuous 1-20 rankings without duplicates or missing ranks', async () => {
    const socket = createSocket();
    await waitForConnect(socket);

    const snapshots = [];
    const snapshotHandler = (snap) => {
      snapshots.push(snap);
    };

    socket.on('f1:v1:grid_snapshot', snapshotHandler);

    // Collect 4 consecutive snapshots
    await new Promise((resolve) => {
      const check = setInterval(() => {
        if (snapshots.length >= 4) {
          clearInterval(check);
          socket.off('f1:v1:grid_snapshot', snapshotHandler);
          resolve();
        }
      }, 100);
    });

    assert(snapshots.length >= 4, 'Expected at least 4 snapshots');

    for (const snap of snapshots) {
      assertEqual(snap.sessionKey, 9590, 'Session key must be Monza 9590');
      assertEqual(snap.grid.length, 20, 'Grid must contain exactly 20 drivers');

      const positions = snap.grid.map((c) => c.position).sort((a, b) => a - b);
      // Verify positions are strictly 1..20
      for (let p = 1; p <= 20; p++) {
        assertEqual(positions[p - 1], p, `Position ${p} must be present with no gaps or duplicates`);
      }

      // Verify leader metrics
      const leader = snap.grid.find((c) => c.position === 1);
      assertDefined(leader, 'Leader must be present');
      assertEqual(leader.gapToLeader, 0, 'Leader gapToLeader must be 0');
      assertEqual(leader.intervalToAhead, 0, 'Leader intervalToAhead must be 0');

      // Verify followers metrics
      const followers = snap.grid.filter((c) => c.position > 1);
      followers.forEach((f) => {
        assert(f.gapToLeader >= 0, `Follower P${f.position} gapToLeader must be non-negative, got ${f.gapToLeader}`);
        assert(f.intervalToAhead >= 0, `Follower P${f.position} intervalToAhead must be non-negative, got ${f.intervalToAhead}`);
      });
    }

    socket.disconnect();
  });

  test('DRS Sporting Regulations: Leader never has DRS, and follower DRS requires interval <= 1.000s (F13)', async () => {
    const socket = createSocket();
    await waitForConnect(socket);

    const snapshots = [];
    const handler = (s) => snapshots.push(s);
    socket.on('f1:v1:grid_snapshot', handler);

    // Collect 6 snapshots
    await new Promise((resolve) => {
      const check = setInterval(() => {
        if (snapshots.length >= 6) {
          clearInterval(check);
          socket.off('f1:v1:grid_snapshot', handler);
          resolve();
        }
      }, 100);
    });

    snapshots.forEach((snap) => {
      // 1. Leader rule: Leader (P1) must NEVER have DRS active
      const leader = snap.grid.find((c) => c.position === 1);
      if (leader) {
        assertEqual(leader.drs, false, 'Race Leader (P1) must NEVER have DRS active per FIA Sporting Regulations');
      }

      // 2. Follower rule: If DRS is active, intervalToAhead must be <= 1.000s
      snap.grid.forEach((car) => {
        if (car.position > 1 && car.drs === true) {
          assert(
            car.intervalToAhead <= 1.001, // Allow 1ms floating precision
            `Car #${car.driverNumber} in P${car.position} has DRS active but intervalToAhead is ${car.intervalToAhead}s (> 1.0s)`
          );
        }
      });
    });

    socket.disconnect();
  });

  test('Tyre Strategy: All drivers report FIA broadcast compound standards (F17)', async () => {
    const socket = createSocket();
    await waitForConnect(socket);

    const snap = await waitForEvent(socket, 'f1:v1:grid_snapshot', 5000);
    const validCompounds = ['SOFT', 'MEDIUM', 'HARD', 'INTERMEDIATE', 'WET', 'UNKNOWN'];

    snap.grid.forEach((car) => {
      assert(
        validCompounds.includes(car.compound),
        `Car #${car.driverNumber} compound "${car.compound}" must be a valid FIA compound`
      );
      assert(
        typeof car.tyreAge === 'number' && car.tyreAge >= 0,
        `Car #${car.driverNumber} tyreAge must be non-negative integer, got ${car.tyreAge}`
      );
    });

    socket.disconnect();
  });

  test('Cockpit Telemetry Physics: Valid ranges for speed, RPM, gear, throttle, and brake', async () => {
    const socket = createSocket();
    await waitForConnect(socket);

    socket.emit('client:v1:subscribe_driver', { driverNumber: 1 });
    const tick = await waitForEventMatching(
      socket,
      'f1:v1:telemetry_tick',
      (t) => t.driverNumber === 1,
      5000
    );

    // Realistic F1 V6 Turbo Hybrid bounds
    assertInRange(tick.speed, 0, 375, 'Speed must be between 0 and 375 km/h');
    assertInRange(tick.rpm, 0, 15000, 'RPM must be between 0 and 15,000');
    assertInRange(tick.throttle, 0, 100, 'Throttle must be 0-100%');
    assertInRange(tick.brake, 0, 100, 'Brake must be 0-100%');
    assert([-1, 0, 1, 2, 3, 4, 5, 6, 7, 8].includes(tick.gear), `Gear must be -1..8, got ${tick.gear}`);

    // Verify coordinates are finite numbers
    assert(Number.isFinite(tick.x), `x coordinate must be finite, got ${tick.x}`);
    assert(Number.isFinite(tick.y), `y coordinate must be finite, got ${tick.y}`);

    socket.disconnect();
  });

  test('Overtake Battle Predictions: Mathematical sanity, no NaN or division-by-zero Infinity (F10)', async () => {
    const socket = createSocket();
    await waitForConnect(socket);

    let observedBattles = [];
    const handler = (snap) => {
      if (snap.activeBattles && snap.activeBattles.length > 0) {
        observedBattles = snap.activeBattles;
      }
    };

    socket.on('f1:v1:grid_snapshot', handler);

    // Observe up to 10 ticks for battles
    await new Promise((resolve) => {
      let count = 0;
      const interval = setInterval(() => {
        count++;
        if (observedBattles.length > 0 || count >= 10) {
          clearInterval(interval);
          socket.off('f1:v1:grid_snapshot', handler);
          resolve();
        }
      }, 250);
    });

    if (observedBattles.length > 0) {
      observedBattles.forEach((battle) => {
        assertDefined(battle.chaser, 'Battle must specify chaser');
        assertDefined(battle.defender, 'Battle must specify defender');
        assert(battle.gap > 0, `Gap must be positive, got ${battle.gap}`);
        assertInRange(battle.probability, 0, 100, 'Probability must be in 0..100');
        assert(Number.isFinite(battle.closingRate), 'closingRate must be finite');
        assert(
          Number.isFinite(battle.estLapsToPass) && battle.estLapsToPass >= 0,
          `estLapsToPass must be finite and non-negative, got ${battle.estLapsToPass}`
        );
        assert(
          ['HIGH', 'MEDIUM', 'LOW'].includes(battle.confidence),
          `Confidence must be HIGH, MEDIUM, or LOW; got ${battle.confidence}`
        );
      });
    }

    socket.disconnect();
  });
});
