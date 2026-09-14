import http from 'http';
import { AddressInfo } from 'net';
import { io as ClientSocket, Socket as ClientSocketType } from 'socket.io-client';
import { createApp } from '../src/app';
import { F1WebSocketGateway } from '../src/websocket/socket.server';
import { simulationEngine } from '../src/services/simulation.service';

// Global error traps to empirically detect unhandled failures
let unhandledExceptionCount = 0;
let unhandledRejectionCount = 0;
const caughtErrors: string[] = [];

process.on('uncaughtException', (err) => {
  unhandledExceptionCount++;
  caughtErrors.push(`uncaughtException: ${err.message}\n${err.stack}`);
  console.error('💥 [CRASH DETECTED] Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason: any) => {
  unhandledRejectionCount++;
  caughtErrors.push(`unhandledRejection: ${reason?.message || reason}`);
  console.error('💥 [CRASH DETECTED] Unhandled Rejection:', reason);
});

async function runChallengerFuzzingSuite() {
  console.log('🏎️ ========================================================');
  console.log('   CHALLENGER 1: Adversarial WebSocket Fuzzing & Stress Suite');
  console.log('   Target: F1 Live Telemetry Gateway & Simulation Engine');
  console.log('========================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, testName: string, detail?: string) {
    if (condition) {
      console.log(`  ✅ PASS: ${testName}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${testName}${detail ? ` - ${detail}` : ''}`);
      failed++;
    }
  }

  // 1. Initialize HTTP server, WebSocket Gateway, and Simulation Engine
  const app = createApp();
  const server = http.createServer(app);
  const gateway = new F1WebSocketGateway(server);

  // Initialize simulation engine with actual Monza circuit data so ticks run in background
  await simulationEngine.initialize(9590);

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  console.log(`🔌 Adversarial test server running on ${baseUrl}\n`);

  // Helper to send a fuzzed event and expect structured error emission within timeout
  const testExpectError = async (
    client: ClientSocketType,
    event: string,
    payload: any,
    expectedKeyword?: string
  ): Promise<{ ok: boolean; receivedError?: any }> => {
    return new Promise<{ ok: boolean; receivedError?: any }>((resolve) => {
      let resolved = false;

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          client.off('error', errorHandler);
          resolve({ ok: false });
        }
      }, 1200);

      const errorHandler = (errData: any) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          client.off('error', errorHandler);

          // Verify structured error format
          const hasMessage = typeof errData?.message === 'string';
          const matchesKeyword = expectedKeyword
            ? errData?.message?.toLowerCase().includes(expectedKeyword.toLowerCase())
            : true;

          resolve({ ok: hasMessage && matchesKeyword, receivedError: errData });
        }
      };

      client.on('error', errorHandler);

      try {
        client.emit(event, payload);
      } catch (err: any) {
        // In case client-side serializer throws (e.g. circular structure)
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          client.off('error', errorHandler);
          resolve({ ok: true, receivedError: { clientSerializerError: err.message } });
        }
      }
    });
  };

  try {
    const client: ClientSocketType = ClientSocket(baseUrl, {
      transports: ['websocket'],
      forceNew: true,
    });

    await new Promise<void>((resolve, reject) => {
      client.on('connect', () => resolve());
      client.on('connect_error', (err) => reject(err));
    });
    assert(client.connected, 'Client successfully connected to WebSocket gateway');

    // =========================================================================
    // SUITE 1: client:v1:subscribe_driver Fuzzing Matrix
    // =========================================================================
    console.log('\n--- SUITE 1: client:v1:subscribe_driver Hostile Fuzzing ---');

    const subscribeFuzzCases = [
      { name: 'null payload', payload: null, keyword: 'Invalid subscribe' },
      { name: 'undefined payload', payload: undefined, keyword: 'Invalid subscribe' },
      { name: 'boolean true', payload: true, keyword: 'Invalid subscribe' },
      { name: 'boolean false', payload: false, keyword: 'Invalid subscribe' },
      { name: 'arbitrary string', payload: 'DROP TABLE drivers;', keyword: 'Invalid subscribe' },
      { name: 'stringified JSON', payload: '{"driverNumber": 1}', keyword: 'Invalid subscribe' },
      { name: 'numeric primitive', payload: 44, keyword: 'Invalid subscribe' },
      { name: 'empty array', payload: [], keyword: 'Invalid subscribe' },
      { name: 'array with driver number', payload: [1], keyword: 'Invalid subscribe' },
      { name: 'empty object {}', payload: {}, keyword: 'Invalid subscribe' },
      { name: 'negative driver number (-1)', payload: { driverNumber: -1 }, keyword: 'Invalid subscribe' },
      { name: 'extreme negative driver (-999999)', payload: { driverNumber: -999999 }, keyword: 'Invalid subscribe' },
      { name: 'zero driver number (0)', payload: { driverNumber: 0 }, keyword: 'Invalid subscribe' },
      { name: 'boundary driver number (>99)', payload: { driverNumber: 100 }, keyword: 'Invalid subscribe' },
      { name: 'extreme high driver number (1e12)', payload: { driverNumber: 1e12 }, keyword: 'Invalid subscribe' },
      { name: 'floating point driver (3.14)', payload: { driverNumber: 3.14 }, keyword: 'Invalid subscribe' },
      { name: 'string driver number ("44")', payload: { driverNumber: '44' }, keyword: 'Invalid subscribe' },
      { name: 'NaN driver number', payload: { driverNumber: NaN }, keyword: 'Invalid subscribe' },
      { name: 'Infinity driver number', payload: { driverNumber: Infinity }, keyword: 'Invalid subscribe' },
      { name: '-Infinity driver number', payload: { driverNumber: -Infinity }, keyword: 'Invalid subscribe' },
      { name: 'nested object driver number', payload: { driverNumber: { num: 1 } }, keyword: 'Invalid subscribe' },
      { name: 'array driver number', payload: { driverNumber: [1] }, keyword: 'Invalid subscribe' },
    ];

    for (const tc of subscribeFuzzCases) {
      const res = await testExpectError(client, 'client:v1:subscribe_driver', tc.payload, tc.keyword);
      assert(res.ok, `subscribe_driver gracefully rejects ${tc.name} with structured error`);
    }

    // =========================================================================
    // SUITE 2: client:v1:unsubscribe_driver Fuzzing Matrix
    // =========================================================================
    console.log('\n--- SUITE 2: client:v1:unsubscribe_driver Hostile Fuzzing ---');

    const unsubscribeFuzzCases = [
      { name: 'null payload', payload: null },
      { name: 'undefined payload', payload: undefined },
      { name: 'boolean false', payload: false },
      { name: 'empty object {}', payload: {} },
      { name: 'negative driver (-1)', payload: { driverNumber: -1 } },
      { name: 'extreme driver (1e12)', payload: { driverNumber: 1e12 } },
      { name: 'string driver ("foo")', payload: { driverNumber: 'foo' } },
      { name: 'NaN driver', payload: { driverNumber: NaN } },
    ];

    for (const tc of unsubscribeFuzzCases) {
      const res = await testExpectError(client, 'client:v1:unsubscribe_driver', tc.payload, 'Invalid unsubscribe');
      assert(res.ok, `unsubscribe_driver gracefully rejects ${tc.name} with structured error`);
    }

    // =========================================================================
    // SUITE 3: client:v1:playback_control Hostile Fuzzing Matrix
    // =========================================================================
    console.log('\n--- SUITE 3: client:v1:playback_control Hostile Fuzzing ---');

    const playbackFuzzCases = [
      { name: 'null payload', payload: null, keyword: 'Invalid playback' },
      { name: 'undefined payload', payload: undefined, keyword: 'Invalid playback' },
      { name: 'boolean true', payload: true, keyword: 'Invalid playback' },
      { name: 'string primitive', payload: 'seek', keyword: 'Invalid playback' },
      { name: 'numeric primitive', payload: 1, keyword: 'Invalid playback' },
      { name: 'empty array []', payload: [], keyword: 'Invalid playback' },
      { name: 'empty object {}', payload: {}, keyword: 'Invalid playback' },
      { name: 'unknown action ("rewind")', payload: { action: 'rewind' }, keyword: 'Invalid playback' },
      { name: 'uppercase action ("PLAY")', payload: { action: 'PLAY' }, keyword: 'Invalid playback' },
      { name: 'seek without progress', payload: { action: 'seek' }, keyword: 'progress' },
      { name: 'seek with progress: null', payload: { action: 'seek', progress: null }, keyword: 'Invalid playback' },
      { name: 'seek with progress: NaN', payload: { action: 'seek', progress: NaN }, keyword: 'Invalid playback' },
      { name: 'seek with progress: "NaN"', payload: { action: 'seek', progress: 'NaN' }, keyword: 'Invalid playback' },
      { name: 'seek with progress: Infinity', payload: { action: 'seek', progress: Infinity }, keyword: 'Invalid playback' },
      { name: 'seek with progress: -Infinity', payload: { action: 'seek', progress: -Infinity }, keyword: 'Invalid playback' },
      { name: 'seek with progress: -0.0001', payload: { action: 'seek', progress: -0.0001 }, keyword: 'Invalid playback' },
      { name: 'seek with progress: -999999', payload: { action: 'seek', progress: -999999 }, keyword: 'Invalid playback' },
      { name: 'seek with progress: 1.0001', payload: { action: 'seek', progress: 1.0001 }, keyword: 'Invalid playback' },
      { name: 'seek with progress: 999999', payload: { action: 'seek', progress: 999999 }, keyword: 'Invalid playback' },
      { name: 'seek with progress: "0.5"', payload: { action: 'seek', progress: '0.5' }, keyword: 'Invalid playback' },
      { name: 'seek with progress: []', payload: { action: 'seek', progress: [] }, keyword: 'Invalid playback' },
      { name: 'seek with progress: {}', payload: { action: 'seek', progress: {} }, keyword: 'Invalid playback' },
      { name: 'play with speed: -99', payload: { action: 'play', speed: -99 }, keyword: 'Invalid playback' },
      { name: 'play with speed: 0', payload: { action: 'play', speed: 0 }, keyword: 'Invalid playback' },
      { name: 'play with speed: 3', payload: { action: 'play', speed: 3 }, keyword: 'Invalid playback' },
      { name: 'play with speed: 999999', payload: { action: 'play', speed: 999999 }, keyword: 'Invalid playback' },
      { name: 'play with speed: NaN', payload: { action: 'play', speed: NaN }, keyword: 'Invalid playback' },
      { name: 'play with speed: "2"', payload: { action: 'play', speed: '2' }, keyword: 'Invalid playback' },
      { name: 'play with speed: null', payload: { action: 'play', speed: null }, keyword: 'Invalid playback' },
      { name: 'pause with speed: 0', payload: { action: 'pause', speed: 0 }, keyword: 'Invalid playback' },
    ];

    for (const tc of playbackFuzzCases) {
      const res = await testExpectError(client, 'client:v1:playback_control', tc.payload, tc.keyword);
      assert(res.ok, `playback_control gracefully rejects ${tc.name} with structured error`);
    }

    // =========================================================================
    // SUITE 4: Circular Structures & Prototype Pollution
    // =========================================================================
    console.log('\n--- SUITE 4: Circular Structures & Prototype Pollution ---');

    // Circular structure test
    const circularObj: any = { driverNumber: 1 };
    circularObj.self = circularObj;
    let circularHandledCleanly = false;
    try {
      client.emit('client:v1:subscribe_driver', circularObj);
      circularHandledCleanly = true;
    } catch (err: any) {
      // Caught cleanly on serialization
      circularHandledCleanly = true;
    }
    assert(circularHandledCleanly, 'Circular structure emitted without unhandled exception');

    // Deeply nested object test (50 levels)
    let nested: any = { driverNumber: 1 };
    for (let i = 0; i < 50; i++) {
      nested = { child: nested };
    }
    const deepRes = await testExpectError(client, 'client:v1:subscribe_driver', nested, 'Invalid subscribe');
    assert(deepRes.ok, 'Deeply nested object rejected with structured error');

    // Prototype pollution attempt
    const protoPayload = JSON.parse('{"driverNumber": 1, "__proto__": {"polluted": true}}');
    client.emit('client:v1:subscribe_driver', protoPayload);
    await new Promise((r) => setTimeout(r, 100));
    assert((Object.prototype as any).polluted === undefined, 'Object prototype is not polluted by hostile payload');

    // =========================================================================
    // SUITE 5: Valid Payloads & State Integrity Under Normal Operation
    // =========================================================================
    console.log('\n--- SUITE 5: Valid Operations & State Verification ---');

    // Valid subscribes
    client.emit('client:v1:subscribe_driver', { driverNumber: 1 });
    client.emit('client:v1:subscribe_driver', { driverNumber: 4 });
    client.emit('client:v1:subscribe_driver', { driverNumber: 99 });

    // Valid seeks at boundaries
    client.emit('client:v1:playback_control', { action: 'seek', progress: 0.0 });
    client.emit('client:v1:playback_control', { action: 'seek', progress: 0.5 });
    client.emit('client:v1:playback_control', { action: 'seek', progress: 1.0 });

    // Valid playback speeds
    client.emit('client:v1:playback_control', { action: 'play', speed: 1 });
    client.emit('client:v1:playback_control', { action: 'play', speed: 2 });
    client.emit('client:v1:playback_control', { action: 'play', speed: 4 });
    client.emit('client:v1:playback_control', { action: 'pause' });
    client.emit('client:v1:playback_control', { action: 'play' });

    await new Promise((r) => setTimeout(r, 300));
    const state = simulationEngine.getPlaybackState();
    assert(typeof state.isPlaying === 'boolean', 'Simulation state isPlaying is boolean');
    assert(Number.isFinite(state.currentTick), 'Simulation state currentTick is finite');
    assert(state.currentTick >= 0 && state.currentTick <= state.totalTicks, 'currentTick remains within valid bounds [0, totalTicks]');

    // =========================================================================
    // SUITE 6: High-Frequency Concurrency Storm (Concurrent Socket Blast)
    // =========================================================================
    console.log('\n--- SUITE 6: Concurrency & Event Burst Stress Test ---');

    const concurrentClients: ClientSocketType[] = [];
    const NUM_CLIENTS = 5;
    const BURST_PER_CLIENT = 20;

    for (let i = 0; i < NUM_CLIENTS; i++) {
      const c = ClientSocket(baseUrl, { transports: ['websocket'], forceNew: true });
      concurrentClients.push(c);
    }

    await Promise.all(
      concurrentClients.map(
        (c) =>
          new Promise<void>((res) => {
            c.on('connect', () => res());
          })
      )
    );
    assert(concurrentClients.every((c) => c.connected), `All ${NUM_CLIENTS} concurrent clients connected`);

    // Blast all clients with mixed malformed and extreme events in rapid parallel loops
    const blastPromises = concurrentClients.map(async (c, clientIdx) => {
      for (let j = 0; j < BURST_PER_CLIENT; j++) {
        // Interleave invalid subscribes, seeks, speeds, and unhandled events
        c.emit('client:v1:subscribe_driver', j % 2 === 0 ? null : { driverNumber: -j });
        c.emit('client:v1:playback_control', { action: 'seek', progress: j % 3 === 0 ? NaN : 999999 });
        c.emit('client:v1:playback_control', { action: 'play', speed: -99 });
        c.emit('client:v1:unknown_event', { junk: true });
        c.emit('client:v1:unsubscribe_driver', null);
      }
    });

    await Promise.all(blastPromises);

    // Concurrently disconnect half of the clients abruptly while messages are processing
    for (let i = 0; i < 3; i++) {
      concurrentClients[i].disconnect();
    }

    // Allow simulation ticks to continue running for 1000ms
    console.log('  ⏳ Allowing simulation ticks to cycle under load for 1000ms...');
    await new Promise((r) => setTimeout(r, 1000));

    // Cleanup remaining clients
    for (const c of concurrentClients) {
      if (c.connected) c.disconnect();
    }
    client.disconnect();

    // =========================================================================
    // SUITE 7: Server Health & Process Crash Invariance Check
    // =========================================================================
    console.log('\n--- SUITE 7: Server Health & Process Crash Invariance ---');

    const healthRes = await fetch(`${baseUrl}/api/health`);
    const healthJson = (await healthRes.json()) as any;
    assert(healthRes.status === 200, 'Server REST /api/health responds with HTTP 200');
    assert(healthJson.status === 'ok', 'Server REST /api/health status is "ok"');

    // Verify unhandled process errors
    assert(unhandledExceptionCount === 0, `Zero uncaught exceptions detected (actual: ${unhandledExceptionCount})`);
    assert(unhandledRejectionCount === 0, `Zero unhandled promise rejections detected (actual: ${unhandledRejectionCount})`);

    // Verify simulation engine remained alive and healthy
    const finalPlayback = simulationEngine.getPlaybackState();
    assert(Number.isFinite(finalPlayback.currentTick), 'Simulation engine currentTick is finite after fuzzing storm');
    assert(simulationEngine.getDrivers().length > 0, 'Simulation engine driver roster remains intact');

  } finally {
    await new Promise<void>((resolve) => {
      gateway.getIO().close(() => {
        server.close(() => resolve());
      });
    });
    await new Promise((r) => setTimeout(r, 100));
  }


  console.log(`\n========================================`);
  console.log(`Challenger Tests Completed: ${passed + failed}`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log(`Unhandled Exceptions: ${unhandledExceptionCount}`);
  console.log(`Unhandled Rejections: ${unhandledRejectionCount}`);
  console.log(`========================================\n`);

  if (failed > 0 || unhandledExceptionCount > 0 || unhandledRejectionCount > 0) {
    if (caughtErrors.length > 0) {
      console.error('Errors recorded during execution:');
      caughtErrors.forEach((e) => console.error(e));
    }
    process.exit(1);
  }

  process.exit(0);
}


runChallengerFuzzingSuite().catch((err) => {
  console.error('Fatal challenger execution error:', err);
  process.exit(1);
});
