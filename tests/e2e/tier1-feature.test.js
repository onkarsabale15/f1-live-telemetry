/**
 * Tier 1: Feature Coverage & Happy Path Verification Suite
 * 
 * Verifies standard, specification-compliant behavior for:
 * - REST Endpoints (/api/health, /api/sessions, /api/auth/*)
 * - WebSocket Gateway connectivity, subscriptions, and telemetry broadcasts
 * - Playback control state machine (play, pause, speed, seek)
 */

const {
  describe,
  test,
  assert,
  assertEqual,
  assertDefined,
  assertInRange,
  request,
  createSocket,
  waitForConnect,
  waitForEvent,
  waitForEventMatching,
} = require('./test-harness');

describe('Tier 1 - REST API Feature Coverage', () => {
  test('GET /api/health returns 200 with service and dependency health status', async () => {
    const res = await request('/api/health');
    assertEqual(res.status, 200, 'Expected 200 OK');
    assertDefined(res.data, 'Expected JSON response');
    assertEqual(res.data.status, 'ok');
    assertEqual(res.data.service, 'f1-telemetry-backend');
    assertDefined(res.data.timestamp);
    assert(
      res.data.redis === 'connected' || res.data.redis === 'fallback-memory',
      `Unexpected redis status: ${res.data.redis}`
    );
    assert(
      res.data.database === 'configured' || res.data.database === 'not-configured',
      `Unexpected database status: ${res.data.database}`
    );
  });

  test('GET /api/sessions returns 200 with session list containing Monza 9590', async () => {
    const res = await request('/api/sessions');
    assertEqual(res.status, 200, 'Expected 200 OK');
    assertEqual(res.data.success, true);
    assert(Array.isArray(res.data.sessions), 'Expected sessions to be an array');
    assert(res.data.sessions.length > 0, 'Expected at least one session');

    const monza = res.data.sessions.find((s) => s.sessionKey === 9590);
    assertDefined(monza, 'Expected Monza 2024 session key 9590 to be present');
    assertEqual(monza.circuitShortName, 'Monza');
  });

  test('GET /api/sessions/current returns 200 with active session metadata and 20 drivers', async () => {
    const res = await request('/api/sessions/current');
    assertEqual(res.status, 200, 'Expected 200 OK');
    assertEqual(res.data.success, true);
    assertDefined(res.data.meta, 'Expected session metadata');
    assertEqual(res.data.meta.sessionKey, 9590);
    assertEqual(res.data.meta.circuitShortName, 'Monza');

    assert(Array.isArray(res.data.drivers), 'Expected drivers array');
    assertEqual(res.data.drivers.length, 20, 'Expected 20 drivers on the grid');

    assertDefined(res.data.playback, 'Expected playback state');
    assertEqual(typeof res.data.playback.isPlaying, 'boolean');
    assert(
      [1, 2, 4].includes(res.data.playback.speed),
      `Playback speed should be 1, 2, or 4; got ${res.data.playback.speed}`
    );
  });

  test('POST /api/sessions/9590/load initializes simulation and returns updated metadata', async () => {
    const res = await request('/api/sessions/9590/load', { method: 'POST' });
    assertEqual(res.status, 200, 'Expected 200 OK');
    assertEqual(res.data.success, true);
    assertEqual(res.data.meta.sessionKey, 9590);
    assertDefined(res.data.playback);
  });

  test('GET /api/auth/profile with valid email query returns user object', async () => {
    const res = await request('/api/auth/profile?email=enthusiast%40f1.com');
    assertEqual(res.status, 200, 'Expected 200 OK');
    assertEqual(res.data.success, true);
    assertDefined(res.data.user);
    assertEqual(res.data.user.email, 'enthusiast@f1.com');
  });

  test('POST /api/auth/google upserts user profile and returns 200', async () => {
    const payload = {
      email: 'verified.user@f1.com',
      googleId: 'google-oauth-1001',
      name: 'Verstappen Fan',
    };
    const res = await request('/api/auth/google', {
      method: 'POST',
      body: payload,
    });
    assertEqual(res.status, 200, 'Expected 200 OK');
    assertEqual(res.data.success, true);
    assertDefined(res.data.user);
    assertEqual(res.data.user.email, 'verified.user@f1.com');
  });

  test('POST /api/auth/settings updates user preferences and returns 200', async () => {
    const payload = {
      userId: 'user-e2e-001',
      favoriteDriver: 4,
      speedUnit: 'KMH',
      soundAlerts: true,
    };
    const res = await request('/api/auth/settings', {
      method: 'POST',
      body: payload,
    });
    assertEqual(res.status, 200, 'Expected 200 OK');
    assertEqual(res.data.success, true);
  });
});

describe('Tier 1 - WebSocket Gateway Feature Coverage', () => {
  test('WebSocket connection emits f1:v1:session_init with valid grid metadata', async () => {
    const socket = createSocket();
    await waitForConnect(socket);

    const initData = await waitForEvent(socket, 'f1:v1:session_init', 5000);
    assertDefined(initData, 'Expected f1:v1:session_init payload');
    assertDefined(initData.sessionMeta, 'Expected sessionMeta');
    assertEqual(initData.sessionMeta.sessionKey, 9590);
    assertEqual(initData.sessionMeta.circuitShortName, 'Monza');
    assert(Array.isArray(initData.drivers), 'Expected drivers array');
    assertEqual(initData.drivers.length, 20, 'Expected 20 drivers');
    assertDefined(initData.playback, 'Expected playback state');

    socket.disconnect();
  });

  test('Subscribing to driver (Lando Norris #4) receives f1:v1:telemetry_tick', async () => {
    const socket = createSocket();
    await waitForConnect(socket);

    socket.emit('client:v1:subscribe_driver', { driverNumber: 4 });

    const tick = await waitForEventMatching(
      socket,
      'f1:v1:telemetry_tick',
      (t) => t.driverNumber === 4,
      5000
    );

    assertDefined(tick, 'Expected telemetry tick for driver 4');
    assertEqual(tick.driverNumber, 4);
    assertInRange(tick.speed, 0, 380, 'Speed in range 0-380 km/h');
    assertInRange(tick.rpm, 0, 15000, 'RPM in range 0-15000');
    assertInRange(tick.gear, -1, 8, 'Gear in range -1..8');
    assertInRange(tick.throttle, 0, 100, 'Throttle in range 0-100%');
    assertInRange(tick.brake, 0, 100, 'Brake in range 0-100%');
    assertEqual(typeof tick.drs, 'boolean', 'DRS should be boolean');
    assertDefined(tick.compound, 'Tyre compound should be defined');

    socket.disconnect();
  });

  test('Receives global f1:v1:grid_snapshot broadcast with all 20 cars', async () => {
    const socket = createSocket();
    await waitForConnect(socket);

    const snapshot = await waitForEvent(socket, 'f1:v1:grid_snapshot', 5000);
    assertDefined(snapshot, 'Expected grid snapshot payload');
    assertEqual(snapshot.sessionKey, 9590);
    assertDefined(snapshot.timestamp);
    assert(Array.isArray(snapshot.grid), 'Expected grid array');
    assertEqual(snapshot.grid.length, 20, 'Expected 20 cars in grid snapshot');
    assert(Array.isArray(snapshot.activeBattles), 'Expected activeBattles array');

    socket.disconnect();
  });

  test('Playback control: pause, play with speed 2x, seek progress', async () => {
    const socket = createSocket();
    await waitForConnect(socket);

    // 1. Pause
    const pausePromise = waitForEventMatching(
      socket,
      'f1:v1:playback_state',
      (s) => s.isPlaying === false,
      5000
    );
    socket.emit('client:v1:playback_control', { action: 'pause' });
    const pausedState = await pausePromise;
    assertEqual(pausedState.isPlaying, false);

    // 2. Play with 2x speed
    const playPromise = waitForEventMatching(
      socket,
      'f1:v1:playback_state',
      (s) => s.isPlaying === true && s.speed === 2,
      5000
    );
    socket.emit('client:v1:playback_control', { action: 'play', speed: 2 });
    const playedState = await playPromise;
    assertEqual(playedState.isPlaying, true);
    assertEqual(playedState.speed, 2);

    // 3. Seek to mid-race progress 0.5
    socket.emit('client:v1:playback_control', { action: 'seek', progress: 0.5 });

    // Reset playback back to 1x normal play
    socket.emit('client:v1:playback_control', { action: 'play', speed: 1 });

    socket.disconnect();
  });

  test('Unsubscribing from driver succeeds without dropping connection', async () => {
    const socket = createSocket();
    await waitForConnect(socket);

    socket.emit('client:v1:subscribe_driver', { driverNumber: 16 });
    socket.emit('client:v1:unsubscribe_driver', { driverNumber: 16 });

    // Connection should remain alive and healthy
    assert(socket.connected, 'Socket should remain connected');
    socket.disconnect();
  });
});
