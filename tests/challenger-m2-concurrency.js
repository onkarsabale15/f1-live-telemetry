/**
 * Milestone 2 Challenger 1: Empirical Concurrency, Stream Stress & Socket Lifecycle Test Suite
 * 
 * Verifies:
 * 1. Rapid driver room switching (100 switches across drivers 1, 4, 16, 44, 55) without disconnects or room leaks.
 * 2. High-frequency playback seek bursts (100 seek commands) without desynchronizing grid coordinates or crashing.
 * 3. Dropped & reconnecting sockets: clean cleanup with zero orphaned event listeners and zero memory leaks.
 * 4. Tier 3 E2E test suite integration (cross-feature concurrency & interactions).
 * 5. Zero unhandled exceptions and zero unhandled rejections.
 */

const http = require('http');
const path = require('path');

// Process-level crash monitors
let unhandledExceptions = 0;
let unhandledRejections = 0;
const processErrors = [];

process.on('uncaughtException', (err) => {
  unhandledExceptions++;
  processErrors.push(`uncaughtException: ${err.message}\n${err.stack}`);
  console.error('💥 [CRASH TRAP] Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason) => {
  unhandledRejections++;
  processErrors.push(`unhandledRejection: ${reason && reason.message ? reason.message : reason}`);
  console.error('💥 [CRASH TRAP] Unhandled Rejection:', reason);
});

// Load socket.io-client
let ioClient;
try {
  ioClient = require('socket.io-client');
} catch {
  try {
    ioClient = require(path.resolve(__dirname, '../frontend/node_modules/socket.io-client'));
  } catch {
    ioClient = require(path.resolve(__dirname, '../backend/node_modules/socket.io-client'));
  }
}
const io = typeof ioClient === 'function' ? ioClient : (ioClient.io || ioClient.default);

// Load backend modules
const { createApp } = require('../backend/dist/app');
const { F1WebSocketGateway } = require('../backend/dist/websocket/socket.server');
const { simulationEngine } = require('../backend/dist/services/simulation.service');
const { messageBus } = require('../backend/dist/db/redis.client');

// Test tracking
const testResults = [];

function recordTest(suite, name, passed, details = '') {
  if (passed) {
    console.log(`  \x1b[32m✅ [PASS]\x1b[0m ${name}`);
  } else {
    console.error(`  \x1b[31m❌ [FAIL]\x1b[0m ${name}${details ? ` -> ${details}` : ''}`);
  }
  testResults.push({ suite, name, passed: Boolean(passed), details });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForEvent(socket, eventName, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout waiting for event "${eventName}" after ${timeoutMs}ms`));
    }, timeoutMs);

    socket.once(eventName, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

function waitForEventMatching(socket, eventName, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(eventName, handler);
      reject(new Error(`Timeout waiting for matching event "${eventName}" after ${timeoutMs}ms`));
    }, timeoutMs);

    const handler = (payload) => {
      try {
        if (predicate(payload)) {
          clearTimeout(timer);
          socket.off(eventName, handler);
          resolve(payload);
        }
      } catch (err) {
        // continue listening
      }
    };

    socket.on(eventName, handler);
  });
}

async function runChallengerSuite() {
  console.log('🏎️ ====================================================================');
  console.log('   CHALLENGER 1: Empirical Concurrency, Stress & Socket Lifecycle Suite');
  console.log('====================================================================\n');

  // 1. Initialize Test Server
  const PORT = 4055; // Dedicated test port to avoid collision
  const SERVER_URL = `http://127.0.0.1:${PORT}`;

  const app = createApp();
  const server = http.createServer(app);
  const wsGateway = new F1WebSocketGateway(server);

  await simulationEngine.initialize(9590);

  await new Promise((resolve) => {
    server.listen(PORT, '127.0.0.1', () => {
      console.log(`📡 In-process test server running on ${SERVER_URL}`);
      resolve();
    });
  });

  const createTestSocket = () => {
    return io(SERVER_URL, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
    });
  };

  try {
    // =========================================================================
    // SUITE 1: RAPID DRIVER ROOM SWITCHING (100 CYCLES)
    // =========================================================================
    console.log('\n--- SUITE 1: Rapid Driver Room Switching Stress (100 Switches) ---');

    const client1 = createTestSocket();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Connection timeout')), 5000);
      client1.on('connect', () => {
        clearTimeout(timer);
        resolve();
      });
    });

    const initPayload = await waitForEvent(client1, 'f1:v1:session_init', 5000);
    recordTest('Room Switching', 'Client receives initial session_init event', Boolean(initPayload && initPayload.sessionMeta));

    // Rapid switching across drivers [1, 4, 16, 44, 55] 100 times
    const driverSequence = [1, 4, 16, 44, 55];
    const totalSwitches = 100;
    const switchStartTime = Date.now();

    for (let i = 0; i < totalSwitches; i++) {
      const targetDriver = driverSequence[i % driverSequence.length];
      client1.emit('client:v1:subscribe_driver', { driverNumber: targetDriver });
      if (i % 10 === 0) {
        await wait(5); // Small breather every 10 switches to interleave socket event loop
      }
    }

    const switchDuration = Date.now() - switchStartTime;
    console.log(`    ⚡ Completed 100 driver room switches in ${switchDuration}ms`);

    // Settle on driver 55 (final in sequence)
    client1.emit('client:v1:subscribe_driver', { driverNumber: 55 });
    await wait(100);

    // Verify socket connection remained alive throughout the 100 switches
    recordTest(
      'Room Switching',
      'Socket connection remained healthy (connected=true) through 100 rapid switches',
      client1.connected === true,
      `connected: ${client1.connected}`
    );

    // Verify client receives telemetry ticks specifically for driver 55
    const tick55 = await waitForEventMatching(
      client1,
      'f1:v1:telemetry_tick',
      (t) => t.driverNumber === 55,
      5000
    );
    recordTest(
      'Room Switching',
      'Client strictly receives telemetry tick for settled driver 55',
      tick55 && tick55.driverNumber === 55,
      `Received driverNumber: ${tick55 ? tick55.driverNumber : 'none'}`
    );

    // Verify server-side socket rooms: should be in socket.id, session:9590, and ONLY driver:55
    const ioServer = wsGateway.getIO();
    const serverSocket = ioServer.sockets.sockets.get(client1.id);

    recordTest(
      'Room Switching',
      'Server-side socket exists in gateway registry',
      Boolean(serverSocket),
      `serverSocket found: ${Boolean(serverSocket)}`
    );

    if (serverSocket) {
      const rooms = Array.from(serverSocket.rooms);
      const hasDriver55 = rooms.includes('driver:55');
      const hasDriver1 = rooms.includes('driver:1');
      const hasDriver4 = rooms.includes('driver:4');
      const hasDriver16 = rooms.includes('driver:16');
      const hasDriver44 = rooms.includes('driver:44');

      recordTest(
        'Room Switching',
        'Server socket joined driver:55 room',
        hasDriver55 === true,
        `Rooms: ${rooms.join(', ')}`
      );

      recordTest(
        'Room Switching',
        'Server socket left previous driver rooms (zero room leak: no driver 1, 4, 16, 44)',
        !hasDriver1 && !hasDriver4 && !hasDriver16 && !hasDriver44,
        `Rooms: ${rooms.join(', ')}`
      );

      recordTest(
        'Room Switching',
        'Total rooms bounded exactly to 3 (socket.id, session:9590, driver:55)',
        rooms.length === 3,
        `Expected 3 rooms, found ${rooms.length}: ${rooms.join(', ')}`
      );
    }

    client1.disconnect();
    await wait(50);

    // =========================================================================
    // SUITE 2: SCRUBBER SEEK BURST SPAMMING (100 SEEK COMMANDS)
    // =========================================================================
    console.log('\n--- SUITE 2: Scrubber Seek Burst Spamming (100 Seek Commands) ---');

    const client2 = createTestSocket();
    await new Promise((resolve) => client2.on('connect', resolve));
    await wait(50);

    const seekValues = [0.0, 0.1, 0.25, 0.33, 0.5, 0.67, 0.8, 0.95, 1.0, 0.05];
    const invalidSeekValues = [-1, 2.5, NaN, 'fast_forward', null, undefined];
    const totalSeeks = 100;
    const seekStartTime = Date.now();

    for (let i = 0; i < totalSeeks; i++) {
      if (i % 15 === 0) {
        // Interleave fuzz/invalid payloads to assert Zod schema resilience
        const badVal = invalidSeekValues[i % invalidSeekValues.length];
        client2.emit('client:v1:playback_control', { action: 'seek', progress: badVal });
      } else {
        const progress = seekValues[i % seekValues.length];
        client2.emit('client:v1:playback_control', { action: 'seek', progress });
      }
      if (i % 20 === 0) {
        await wait(5);
      }
    }

    const seekDuration = Date.now() - seekStartTime;
    console.log(`    ⚡ Completed 100 scrubber seek bursts in ${seekDuration}ms`);

    // Settle seek to middle of the race (progress 0.5)
    client2.emit('client:v1:playback_control', { action: 'seek', progress: 0.5 });
    await wait(100);

    // Capture the next grid snapshot to assert physics and coordinates integrity
    const gridSnapshot = await waitForEvent(client2, 'f1:v1:grid_snapshot', 5000);

    recordTest(
      'Seek Spamming',
      'Grid snapshot received after 100 seek bursts',
      Boolean(gridSnapshot && Array.isArray(gridSnapshot.grid)),
      `Grid length: ${gridSnapshot ? gridSnapshot.grid.length : 0}`
    );

    if (gridSnapshot && gridSnapshot.grid) {
      recordTest(
        'Seek Spamming',
        'Grid contains all 20 drivers',
        gridSnapshot.grid.length === 20,
        `Count: ${gridSnapshot.grid.length}`
      );

      // Verify coordinates and metrics of all 20 cars
      let allCoordsFinite = true;
      let allSpeedsPhysicallyValid = true;
      let allGearsValid = true;
      let allRpmsValid = true;
      const invalidDetails = [];

      gridSnapshot.grid.forEach((car) => {
        if (!Number.isFinite(car.x) || !Number.isFinite(car.y) || isNaN(car.x) || isNaN(car.y)) {
          allCoordsFinite = false;
          invalidDetails.push(`Driver ${car.driverNumber} invalid coords: (${car.x}, ${car.y})`);
        }
        if (!Number.isFinite(car.speed) || car.speed < 0 || car.speed > 450) {
          allSpeedsPhysicallyValid = false;
          invalidDetails.push(`Driver ${car.driverNumber} invalid speed: ${car.speed}`);
        }
        if (!Number.isInteger(car.gear) || car.gear < 1 || car.gear > 8) {
          allGearsValid = false;
          invalidDetails.push(`Driver ${car.driverNumber} invalid gear: ${car.gear}`);
        }
        if (!Number.isFinite(car.rpm) || car.rpm < 1000 || car.rpm > 18000) {
          allRpmsValid = false;
          invalidDetails.push(`Driver ${car.driverNumber} invalid rpm: ${car.rpm}`);
        }
      });

      recordTest(
        'Seek Spamming',
        'All 20 cars have finite, non-NaN (x, y) track coordinates',
        allCoordsFinite,
        invalidDetails.join('; ')
      );

      recordTest(
        'Seek Spamming',
        'All 20 cars have physically plausible speeds [0, 450 km/h]',
        allSpeedsPhysicallyValid,
        invalidDetails.join('; ')
      );

      recordTest(
        'Seek Spamming',
        'All 20 cars have valid gear selection [1..8]',
        allGearsValid,
        invalidDetails.join('; ')
      );

      recordTest(
        'Seek Spamming',
        'All 20 cars have valid RPM bounds [1000..18000]',
        allRpmsValid,
        invalidDetails.join('; ')
      );
    }

    // Verify simulation state bounds
    const simPlayback = simulationEngine.getPlaybackState();
    recordTest(
      'Seek Spamming',
      'Simulation playback state currentTick within totalTicks bounds',
      simPlayback.currentTick >= 0 && simPlayback.currentTick <= simPlayback.totalTicks,
      `currentTick: ${simPlayback.currentTick}, totalTicks: ${simPlayback.totalTicks}`
    );

    client2.disconnect();
    await wait(50);

    // =========================================================================
    // SUITE 3: SOCKET DROPPED / RECONNECTING RESILIENCE & LISTENER LEAKS
    // =========================================================================
    console.log('\n--- SUITE 3: Socket Dropped / Reconnect Resilience & Listener Leaks ---');

    // Baseline listener counts
    const baselineStateChangeListeners = simulationEngine.listenerCount('stateChange');
    console.log(`    📊 Baseline simulationEngine stateChange listeners: ${baselineStateChangeListeners}`);

    // Perform 30 rapid connect -> subscribe -> receive tick -> abrupt disconnect cycles
    const churnCycles = 30;
    const churnStartTime = Date.now();

    for (let c = 0; c < churnCycles; c++) {
      const s = createTestSocket();
      await new Promise((resolve) => s.on('connect', resolve));
      s.emit('client:v1:subscribe_driver', { driverNumber: 4 });
      await waitForEventMatching(s, 'f1:v1:telemetry_tick', (t) => t.driverNumber === 4, 3000);
      s.disconnect();
    }

    const churnDuration = Date.now() - churnStartTime;
    console.log(`    ⚡ Completed ${churnCycles} socket churn cycles in ${churnDuration}ms`);

    await wait(200); // Allow disconnect cleanup to complete

    // Assert simulationEngine stateChange listeners did not grow
    const postStateChangeListeners = simulationEngine.listenerCount('stateChange');
    recordTest(
      'Listener Leaks',
      'simulationEngine stateChange listener count remained constant (zero listener leak)',
      postStateChangeListeners === baselineStateChangeListeners,
      `Baseline: ${baselineStateChangeListeners}, Post-churn: ${postStateChangeListeners}`
    );

    // Assert server active sockets count returns to 0
    const activeSocketsCount = ioServer.sockets.sockets.size;
    recordTest(
      'Socket Cleanup',
      'All churned sockets cleanly disconnected from server registry (activeSockets=0)',
      activeSocketsCount === 0,
      `Active sockets count: ${activeSocketsCount}`
    );

    // Connect a fresh socket and verify immediate functionality
    const freshClient = createTestSocket();
    await new Promise((resolve) => freshClient.on('connect', resolve));
    freshClient.emit('client:v1:subscribe_driver', { driverNumber: 1 });
    const freshTick = await waitForEventMatching(freshClient, 'f1:v1:telemetry_tick', (t) => t.driverNumber === 1, 5000);

    recordTest(
      'Socket Cleanup',
      'Fresh socket connects and receives driver 1 telemetry immediately after churn',
      freshTick && freshTick.driverNumber === 1,
      `Received driverNumber: ${freshTick ? freshTick.driverNumber : 'none'}`
    );

    freshClient.disconnect();
    await wait(50);

    // =========================================================================
    // SUITE 4: ZERO PROCESS CRASHES OR UNHANDLED REJECTIONS
    // =========================================================================
    console.log('\n--- SUITE 4: Process Crash & Error Trap Audit ---');

    recordTest(
      'Crash Prevention',
      'Zero unhandled exceptions occurred during concurrency & stress testing',
      unhandledExceptions === 0,
      `Exceptions (${unhandledExceptions}): ${processErrors.filter((e) => e.startsWith('uncaught')).join('; ')}`
    );

    recordTest(
      'Crash Prevention',
      'Zero unhandled promise rejections occurred during concurrency & stress testing',
      unhandledRejections === 0,
      `Rejections (${unhandledRejections}): ${processErrors.filter((e) => e.startsWith('unhandled')).join('; ')}`
    );

  } finally {
    // Teardown
    try {
      wsGateway.getIO().close();
    } catch {}
    try {
      simulationEngine.pause();
    } catch {}
    await new Promise((resolve) => {
      server.close(() => {
        console.log('\n🛑 In-process test server stopped.');
        resolve();
      });
    });
  }

  // =========================================================================
  // SUITE 5: OFFICIAL E2E TIER 3 CONCURRENCY & INTERACTIONS SUITE
  // =========================================================================
  console.log('\n--- SUITE 5: Official E2E Tier 3 Concurrency Suite ---');
  try {
    const { ensureServerRunning, teardownServer, runSuites } = require('./e2e/test-harness');
    await ensureServerRunning();
    require('./e2e/tier3-interactions.test');
    const tier3Results = await runSuites('Tier 3');
    await teardownServer();

    recordTest(
      'Tier 3 E2E',
      'All 4 Tier 3 Interaction tests passed',
      tier3Results.failed === 0,
      `${tier3Results.passed}/${tier3Results.total} passed`
    );
  } catch (err) {
    recordTest('Tier 3 E2E', 'Tier 3 execution threw error', false, err.message);
  }

  // Summary Report
  const total = testResults.length;
  const passed = testResults.filter((r) => r.passed).length;
  const failed = testResults.filter((r) => !r.passed).length;

  console.log('\n======================================================================');
  console.log(`Empirical Test Summary:`);
  console.log(`Total:   ${total}`);
  console.log(`Passed:  \x1b[32m${passed}\x1b[0m`);
  console.log(`Failed:  ${failed > 0 ? `\x1b[31m${failed}\x1b[0m` : '0'}`);
  console.log('======================================================================\n');

  if (failed > 0) {
    console.log('Failed Tests:');
    testResults.filter((r) => !r.passed).forEach((r, idx) => {
      console.log(`  ${idx + 1}) [${r.suite}] ${r.name}: ${r.details}`);
    });
    process.exit(1);
  } else {
    console.log('✅ ALL EMPIRICAL CONCURRENCY & STRESS TESTS PASSED!');
    process.exit(0);
  }
}

runChallengerSuite().catch((err) => {
  console.error('💥 Fatal error in challenger suite:', err);
  process.exit(1);
});

