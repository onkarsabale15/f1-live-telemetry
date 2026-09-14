/**
 * Tier 2: Boundary, Corner Cases & Security Hardening Verification Suite
 * 
 * Verifies resilience against:
 * - WebSocket null destructuring attacks (SEC-01)
 * - WebSocket NaN / non-finite mathematical seek poisoning (SEC-02)
 * - Numeric boundaries for speed, progress, driver numbers
 * - REST input validation boundaries and 400 Bad Request handling
 * - Payload size exhaustion protection (10kb body parser limit - SEC-12)
 * - Security headers & CORS origin whitelist enforcement (SEC-09)
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
} = require('./test-harness');

describe('Tier 2 - WebSocket Security & Destructuring Defense (SEC-01)', () => {
  test('Sending null payload to client:v1:subscribe_driver emits error without crashing server', async () => {
    const socket = createSocket();
    await waitForConnect(socket);

    const errorPromise = waitForEvent(socket, 'error', 3000);
    socket.emit('client:v1:subscribe_driver', null);

    const err = await errorPromise;
    assertDefined(err, 'Expected error event emission');
    assert(socket.connected, 'Socket connection must remain alive');

    // Verify server process is still alive and answering health checks
    const health = await request('/api/health');
    assertEqual(health.status, 200, 'Server should remain healthy after null payload');

    socket.disconnect();
  });

  test('Sending empty object {} to client:v1:subscribe_driver emits error', async () => {
    const socket = createSocket();
    await waitForConnect(socket);

    const errorPromise = waitForEvent(socket, 'error', 3000);
    socket.emit('client:v1:subscribe_driver', {});

    const err = await errorPromise;
    assertDefined(err);
    assert(socket.connected, 'Socket should remain connected');

    socket.disconnect();
  });

  test('Sending null payload to client:v1:unsubscribe_driver emits error', async () => {
    const socket = createSocket();
    await waitForConnect(socket);

    const errorPromise = waitForEvent(socket, 'error', 3000);
    socket.emit('client:v1:unsubscribe_driver', null);

    const err = await errorPromise;
    assertDefined(err);
    assert(socket.connected, 'Socket should remain connected');

    socket.disconnect();
  });

  test('Sending null payload to client:v1:playback_control emits error without crashing', async () => {
    const socket = createSocket();
    await waitForConnect(socket);

    const errorPromise = waitForEvent(socket, 'error', 3000);
    socket.emit('client:v1:playback_control', null);

    const err = await errorPromise;
    assertDefined(err);
    assert(socket.connected, 'Socket should remain connected');

    socket.disconnect();
  });
});

describe('Tier 2 - WebSocket Mathematical Bounds & NaN Poisoning (SEC-02)', () => {
  test('Sending NaN progress to seek action is rejected without process crash', async () => {
    const socket = createSocket();
    await waitForConnect(socket);

    // In JSON, NaN serializes to null or triggers validation rejection
    const errorPromise = waitForEvent(socket, 'error', 3000);
    socket.emit('client:v1:playback_control', { action: 'seek', progress: NaN });

    const err = await errorPromise;
    assertDefined(err, 'Expected validation error event for NaN progress');

    // Confirm server is still alive
    const health = await request('/api/health');
    assertEqual(health.status, 200, 'Server must remain alive after NaN seek');

    socket.disconnect();
  });

  test('Sending negative progress (< 0.0) is rejected with error', async () => {
    const socket = createSocket();
    await waitForConnect(socket);

    const errorPromise = waitForEvent(socket, 'error', 3000);
    socket.emit('client:v1:playback_control', { action: 'seek', progress: -0.25 });

    const err = await errorPromise;
    assertDefined(err, 'Expected error event for negative progress');

    socket.disconnect();
  });

  test('Sending progress exceeding 1.0 (> 1.0) is rejected with error', async () => {
    const socket = createSocket();
    await waitForConnect(socket);

    const errorPromise = waitForEvent(socket, 'error', 3000);
    socket.emit('client:v1:playback_control', { action: 'seek', progress: 1.5 });

    const err = await errorPromise;
    assertDefined(err, 'Expected error event for progress > 1.0');

    socket.disconnect();
  });

  test('Boundary progress values (0.0 and 1.0) are valid and accepted', async () => {
    const socket = createSocket();
    await waitForConnect(socket);

    // Should not emit error
    let errorReceived = false;
    socket.on('error', () => { errorReceived = true; });

    socket.emit('client:v1:playback_control', { action: 'seek', progress: 0.0 });
    socket.emit('client:v1:playback_control', { action: 'seek', progress: 1.0 });

    await new Promise((r) => setTimeout(r, 200));
    assertEqual(errorReceived, false, 'Boundary values 0.0 and 1.0 should be accepted');

    socket.disconnect();
  });

  test('Invalid playback speeds (0, -1, 3, 10) are rejected with error', async () => {
    const socket = createSocket();
    await waitForConnect(socket);

    for (const invalidSpeed of [0, -1, 3, 10]) {
      const errorPromise = waitForEvent(socket, 'error', 3000);
      socket.emit('client:v1:playback_control', { action: 'play', speed: invalidSpeed });
      const err = await errorPromise;
      assertDefined(err, `Expected error for invalid speed: ${invalidSpeed}`);
    }

    socket.disconnect();
  });

  test('Invalid driver numbers (0, negative, > 99, non-integer) are rejected', async () => {
    const socket = createSocket();
    await waitForConnect(socket);

    for (const invalidDriver of [0, -4, 100, 999999, 4.5]) {
      const errorPromise = waitForEvent(socket, 'error', 3000);
      socket.emit('client:v1:subscribe_driver', { driverNumber: invalidDriver });
      const err = await errorPromise;
      assertDefined(err, `Expected error for invalid driver number: ${invalidDriver}`);
    }

    socket.disconnect();
  });
});

describe('Tier 2 - REST Input Boundaries & 400 Bad Request Handling', () => {
  test('POST /api/sessions/:key/load with non-numeric sessionKey returns 400', async () => {
    const res = await request('/api/sessions/invalid-session-key/load', { method: 'POST' });
    assertEqual(res.status, 400, 'Expected 400 Bad Request');
    assertEqual(res.data.success, false);
  });

  test('POST /api/sessions/:key/load with negative sessionKey returns 400', async () => {
    const res = await request('/api/sessions/-9590/load', { method: 'POST' });
    assertEqual(res.status, 400, 'Expected 400 Bad Request');
    assertEqual(res.data.success, false);
  });

  test('GET /api/auth/profile with missing email parameter returns 400', async () => {
    const res = await request('/api/auth/profile');
    assertEqual(res.status, 400, 'Expected 400 Bad Request');
    assertEqual(res.data.success, false);
  });

  test('GET /api/auth/profile with malformed email format returns 400', async () => {
    const res = await request('/api/auth/profile?email=not-a-valid-email');
    assertEqual(res.status, 400, 'Expected 400 Bad Request');
    assertEqual(res.data.success, false);
  });

  test('POST /api/auth/google with missing googleId returns 400', async () => {
    const res = await request('/api/auth/google', {
      method: 'POST',
      body: { email: 'user@f1.com' }, // missing googleId
    });
    assertEqual(res.status, 400, 'Expected 400 Bad Request');
    assertEqual(res.data.success, false);
  });

  test('POST /api/auth/settings with invalid speedUnit returns 400', async () => {
    const res = await request('/api/auth/settings', {
      method: 'POST',
      body: { userId: 'user-01', speedUnit: 'KNOTS' },
    });
    assertEqual(res.status, 400, 'Expected 400 Bad Request');
    assertEqual(res.data.success, false);
  });

  test('POST /api/auth/settings with out-of-range favoriteDriver (e.g. 150) returns 400', async () => {
    const res = await request('/api/auth/settings', {
      method: 'POST',
      body: { userId: 'user-01', favoriteDriver: 150 },
    });
    assertEqual(res.status, 400, 'Expected 400 Bad Request');
    assertEqual(res.data.success, false);
  });
});

describe('Tier 2 - Security Infrastructure, Payload Bounds & CORS (SEC-09, SEC-12)', () => {
  test('Payload size exceeding 10kb is rejected with 413 Payload Too Large', async () => {
    // Large payload (> 10kb)
    const largeString = 'A'.repeat(12 * 1024); // 12 KB
    const res = await request('/api/auth/settings', {
      method: 'POST',
      body: { userId: 'user-01', padding: largeString },
    });
    assertEqual(res.status, 413, 'Expected 413 Payload Too Large for body > 10kb');
  });

  test('Security headers include X-Content-Type-Options: nosniff', async () => {
    const res = await request('/api/health');
    const nosniff = res.headers.get('x-content-type-options');
    assertEqual(nosniff, 'nosniff', 'Expected X-Content-Type-Options: nosniff header');
  });

  test('CORS rejects unauthorized origin with 403 Forbidden or non-permissive headers', async () => {
    const res = await request('/api/health', {
      headers: { Origin: 'http://malicious-attacker-domain.org' },
    });
    const allowOrigin = res.headers.get('access-control-allow-origin');
    assert(
      res.status === 403 || (allowOrigin !== 'http://malicious-attacker-domain.org' && allowOrigin !== '*'),
      `Unauthorized origin should receive 403 or non-permissive CORS grant, got status ${res.status} and allowOrigin ${allowOrigin}`
    );
  });
});
