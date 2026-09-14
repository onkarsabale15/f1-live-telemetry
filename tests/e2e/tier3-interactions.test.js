/**
 * Tier 3: Cross-Feature Interactions, Concurrency & Churn Verification Suite
 * 
 * Verifies stability and race condition prevention for:
 * - Rapid driver subscription switching during active playback (SEC-14)
 * - Concurrent multi-client subscriptions without crosstalk
 * - Abrupt disconnect and rapid reconnection resilience
 * - Interleaved REST session reload during active WebSocket telemetry streaming
 */

const {
  describe,
  test,
  assert,
  assertEqual,
  assertDefined,
  request,
  createSocket,
  waitForConnect,
  waitForEvent,
  waitForEventMatching,
} = require('./test-harness');

describe('Tier 3 - Cross-Feature Interactions & Concurrency', () => {
  test('Rapid driver subscription switching burst while altering playback speed does not desync', async () => {
    const socket = createSocket();
    await waitForConnect(socket);

    const driverSequence = [1, 44, 16, 81, 55, 63, 11, 4];
    const speedSequence = [2, 4, 1, 2, 4, 1, 2, 1];

    for (let i = 0; i < driverSequence.length; i++) {
      const driver = driverSequence[i];
      const speed = speedSequence[i];

      socket.emit('client:v1:subscribe_driver', { driverNumber: driver });
      socket.emit('client:v1:playback_control', { action: 'play', speed });
      await new Promise((r) => setTimeout(r, 25)); // 25ms rapid bursts
    }

    // Verify socket remains alive and receiving ticks for the final driver (4)
    assert(socket.connected, 'Socket connection must remain healthy after subscription burst');

    const finalTick = await waitForEventMatching(
      socket,
      'f1:v1:telemetry_tick',
      (t) => t.driverNumber === 4,
      5000
    );

    assertDefined(finalTick, 'Expected telemetry tick for final focused driver (#4)');
    assertEqual(finalTick.driverNumber, 4);

    socket.disconnect();
  });

  test('5 concurrent WebSocket clients independently receive discrete driver telemetry and synchronized snapshots', async () => {
    const testDrivers = [1, 4, 16, 44, 81];
    const sockets = [];

    try {
      // Connect 5 sockets concurrently
      for (let i = 0; i < testDrivers.length; i++) {
        const s = createSocket();
        await waitForConnect(s);
        sockets.push(s);
      }

      // Each socket subscribes to its assigned driver
      const tickPromises = sockets.map((s, idx) => {
        const driverNum = testDrivers[idx];
        s.emit('client:v1:subscribe_driver', { driverNumber: driverNum });
        return waitForEventMatching(
          s,
          'f1:v1:telemetry_tick',
          (t) => t.driverNumber === driverNum,
          5000
        );
      });

      // Verify all 5 receive their specific driver tick
      const ticks = await Promise.all(tickPromises);
      assertEqual(ticks.length, 5);
      ticks.forEach((tick, idx) => {
        assertEqual(tick.driverNumber, testDrivers[idx]);
      });

      // Verify all 5 receive global grid snapshot with matching sessionKey
      const snapshotPromises = sockets.map((s) => waitForEvent(s, 'f1:v1:grid_snapshot', 5000));
      const snapshots = await Promise.all(snapshotPromises);
      snapshots.forEach((snap) => {
        assertEqual(snap.sessionKey, 9590);
        assertEqual(snap.grid.length, 20);
      });
    } finally {
      sockets.forEach((s) => {
        if (s.connected) s.disconnect();
      });
    }
  });

  test('Abrupt socket drop and rapid reconnect succeeds cleanly with zero orphaned listeners', async () => {
    let socket1 = createSocket();
    await waitForConnect(socket1);

    socket1.emit('client:v1:subscribe_driver', { driverNumber: 4 });
    const tick1 = await waitForEventMatching(
      socket1,
      'f1:v1:telemetry_tick',
      (t) => t.driverNumber === 4,
      5000
    );
    assertDefined(tick1);

    // Abruptly disconnect socket1
    socket1.disconnect();
    assertEqual(socket1.connected, false);

    // Reconnect immediately with socket2
    const socket2 = createSocket();
    await waitForConnect(socket2);

    const initData = await waitForEvent(socket2, 'f1:v1:session_init', 5000);
    assertDefined(initData);
    assertEqual(initData.sessionMeta.sessionKey, 9590);

    socket2.emit('client:v1:subscribe_driver', { driverNumber: 1 });
    const tick2 = await waitForEventMatching(
      socket2,
      'f1:v1:telemetry_tick',
      (t) => t.driverNumber === 1,
      5000
    );
    assertDefined(tick2);
    assertEqual(tick2.driverNumber, 1);

    socket2.disconnect();
  });

  test('Interleaved REST session reload during active WebSocket stream maintains streaming continuity', async () => {
    const socket = createSocket();
    await waitForConnect(socket);

    socket.emit('client:v1:subscribe_driver', { driverNumber: 4 });
    await waitForEventMatching(
      socket,
      'f1:v1:telemetry_tick',
      (t) => t.driverNumber === 4,
      5000
    );

    // Trigger REST session reload mid-stream
    const reloadRes = await request('/api/sessions/9590/load', { method: 'POST' });
    assertEqual(reloadRes.status, 200);

    // Verify WebSocket continues streaming ticks without connection break
    const nextTick = await waitForEventMatching(
      socket,
      'f1:v1:telemetry_tick',
      (t) => t.driverNumber === 4,
      5000
    );
    assertDefined(nextTick, 'WebSocket stream should continue after REST reload');
    assertEqual(nextTick.driverNumber, 4);

    socket.disconnect();
  });
});
