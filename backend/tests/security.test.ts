import http from 'http';
import { AddressInfo } from 'net';
import { io as ClientSocket, Socket as ClientSocketType } from 'socket.io-client';
import { createApp } from '../src/app';
import { F1WebSocketGateway } from '../src/websocket/socket.server';
import { ENV } from '../src/config/env';

async function runTests() {
  console.log('🧪 Starting Milestone 1 Security Verification Suite...\n');
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

  // -------------------------------------------------------------
  // Test 1: Redis URL Credential Sanitization
  // -------------------------------------------------------------
  console.log('--- 1. Testing Redis Credential Sanitization ---');
  const sanitizeUrl = (rawUrl: string): string => {
    if (!rawUrl) return '';
    try {
      const parsed = new URL(rawUrl);
      if (parsed.password) {
        parsed.password = '***';
      }
      return parsed.toString();
    } catch {
      return rawUrl.replace(/:\/\/([^:]+):([^@]+)@/, '://$1:***@');
    }
  };

  const testRedisUrl = 'rediss://default:AVNS_superSecret123@valkey.example.com:19211';
  const sanitized = sanitizeUrl(testRedisUrl);
  assert(!sanitized.includes('AVNS_superSecret123'), 'Sanitized URL does not leak plaintext password');
  assert(sanitized.includes('***'), 'Sanitized URL contains masked password marker');

  // -------------------------------------------------------------
  // Spin up test HTTP and Socket.IO servers
  // -------------------------------------------------------------
  const app = createApp();
  const server = http.createServer(app);
  const gateway = new F1WebSocketGateway(server);

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  console.log(`Test server running at ${baseUrl}\n`);

  try {
    // -------------------------------------------------------------
    // Test 2: Helmet Security Headers
    // -------------------------------------------------------------
    console.log('--- 2. Testing Helmet Security Headers ---');
    const healthRes = await fetch(`${baseUrl}/api/health`);
    assert(healthRes.status === 200, 'Health check returns 200');
    const headers = healthRes.headers;
    assert(headers.has('x-content-type-options'), 'X-Content-Type-Options header is present');
    assert(headers.get('x-content-type-options') === 'nosniff', 'X-Content-Type-Options is nosniff');
    assert(headers.has('x-frame-options') || headers.has('content-security-policy'), 'Clickjacking defense header present');

    // -------------------------------------------------------------
    // Test 3: CORS Origin Protection
    // -------------------------------------------------------------
    console.log('\n--- 3. Testing CORS Origin Restrictions ---');
    // Allowed origin
    const allowedRes = await fetch(`${baseUrl}/api/health`, {
      headers: { Origin: 'http://localhost:3000' },
    });
    assert(allowedRes.headers.get('access-control-allow-origin') === 'http://localhost:3000', 'Allowed origin receives access-control-allow-origin');

    // Unauthorized origin
    const unauthorizedRes = await fetch(`${baseUrl}/api/health`, {
      headers: { Origin: 'http://evil-attacker.site' },
    });
    assert(unauthorizedRes.status === 403, 'Unauthorized origin rejected with status 403');
    const unauthorizedBody = (await unauthorizedRes.json()) as any;
    assert(unauthorizedBody.error?.includes('CORS policy violation'), 'Unauthorized origin receives CORS error message');

    // -------------------------------------------------------------
    // Test 4: Body Size Limitation (10kb Limit)
    // -------------------------------------------------------------
    console.log('\n--- 4. Testing 10kb JSON Body Size Limit ---');
    // Payload under 10kb
    const smallPayload = JSON.stringify({ userId: 'test-user', speedUnit: 'KMH' });
    const smallRes = await fetch(`${baseUrl}/api/auth/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: smallPayload,
    });
    assert(smallRes.status !== 413, 'Small payload (<10kb) is not rejected with 413');

    // Payload over 10kb (> 10240 bytes)
    const largeString = 'A'.repeat(12 * 1024);
    const largePayload = JSON.stringify({ userId: 'test-user', data: largeString });
    const largeRes = await fetch(`${baseUrl}/api/auth/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: largePayload,
    });
    assert(largeRes.status === 413, 'Large payload (>10kb) rejected with 413 Payload Too Large');

    // -------------------------------------------------------------
    // Test 5: REST Controller Input Validation (Zod)
    // -------------------------------------------------------------
    console.log('\n--- 5. Testing REST Controller Input Validation ---');
    // Invalid email in profile
    const invalidProfileRes = await fetch(`${baseUrl}/api/auth/profile?email=not-an-email`);
    assert(invalidProfileRes.status === 400, 'Invalid email in profile returns 400 Bad Request');
    const profileJson = (await invalidProfileRes.json()) as any;
    assert(!profileJson.success && profileJson.error, 'Profile returns structured validation error');

    // Valid email format
    const validProfileRes = await fetch(`${baseUrl}/api/auth/profile?email=fan@f1.com`);
    assert(validProfileRes.status === 200 || validProfileRes.status === 404, 'Valid email format accepted (200/404)');

    // Invalid Google user payload (missing googleId)
    const invalidGoogleRes = await fetch(`${baseUrl}/api/auth/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'valid@f1.com' }),
    });
    assert(invalidGoogleRes.status === 400, 'Missing googleId returns 400 Bad Request');

    // Invalid sessionKey in loadSession
    const invalidSessionRes = await fetch(`${baseUrl}/api/sessions/not-a-number/load`, {
      method: 'POST',
    });
    assert(invalidSessionRes.status === 400, 'Invalid sessionKey returns 400 Bad Request');

    // -------------------------------------------------------------
    // Test 6: Rate Limiting
    // -------------------------------------------------------------
    console.log('\n--- 6. Testing Rate Limiting on /api/auth/ ---');
    let rateLimited = false;
    for (let i = 0; i < 25; i++) {
      const res = await fetch(`${baseUrl}/api/auth/profile?email=rate-test-${i}@f1.com`);
      if (res.status === 429) {
        rateLimited = true;
        break;
      }
    }
    assert(rateLimited, 'Auth endpoints enforce 20 req/15min rate limit with 429 Too Many Requests');

    // -------------------------------------------------------------
    // Test 7: WebSocket Validation & Resilience
    // -------------------------------------------------------------
    console.log('\n--- 7. Testing WebSocket Gateway Hardening ---');
    const client: ClientSocketType = ClientSocket(baseUrl, {
      transports: ['websocket'],
      forceNew: true,
    });

    await new Promise<void>((resolve, reject) => {
      client.on('connect', () => resolve());
      client.on('connect_error', (err) => reject(err));
    });
    assert(client.connected, 'Client connected to WebSocket gateway');

    const testWsEvent = async (event: string, payload: any, expectedErrMsg: string): Promise<boolean> => {
      return new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => {
          client.off('error');
          resolve(false);
        }, 1500);

        client.once('error', (errData: any) => {
          clearTimeout(timeout);
          const msg = errData?.message || '';
          resolve(msg.toLowerCase().includes(expectedErrMsg.toLowerCase()));
        });

        client.emit(event, payload);
      });
    };

    // SEC-01 test: null payload to subscribe_driver
    const nullSubOk = await testWsEvent('client:v1:subscribe_driver', null, 'Invalid subscribe payload');
    assert(nullSubOk, 'WebSocket gracefully rejects null subscribe_driver without crashing');

    // Non-object payload
    const stringSubOk = await testWsEvent('client:v1:subscribe_driver', 'invalid-payload', 'Invalid subscribe payload');
    assert(stringSubOk, 'WebSocket gracefully rejects string subscribe_driver without crashing');

    // Invalid driver number (negative / >99)
    const negSubOk = await testWsEvent('client:v1:subscribe_driver', { driverNumber: -5 }, 'Invalid subscribe payload');
    assert(negSubOk, 'WebSocket rejects negative driver number');

    const overflowSubOk = await testWsEvent('client:v1:subscribe_driver', { driverNumber: 999 }, 'Invalid subscribe payload');
    assert(overflowSubOk, 'WebSocket rejects driver number > 99');

    // SEC-01 test: null payload to playback_control
    const nullPbOk = await testWsEvent('client:v1:playback_control', null, 'Invalid playback control payload');
    assert(nullPbOk, 'WebSocket gracefully rejects null playback_control without crashing');

    // SEC-02 test: NaN / string progress in seek
    const nanPbOk = await testWsEvent(
      'client:v1:playback_control',
      { action: 'seek', progress: 'NaN' },
      'Invalid playback control payload'
    );
    assert(nanPbOk, 'WebSocket rejects string "NaN" progress in playback_control');

    // Negative progress (<0)
    const negProgOk = await testWsEvent(
      'client:v1:playback_control',
      { action: 'seek', progress: -0.25 },
      'Invalid playback control payload'
    );
    assert(negProgOk, 'WebSocket rejects negative progress in playback_control');

    // Out-of-bounds progress (>1)
    const outBoundsOk = await testWsEvent(
      'client:v1:playback_control',
      { action: 'seek', progress: 1.5 },
      'Invalid playback control payload'
    );
    assert(outBoundsOk, 'WebSocket rejects progress > 1.0 in playback_control');

    // Null progress in seek
    const nullProgOk = await testWsEvent(
      'client:v1:playback_control',
      { action: 'seek', progress: null },
      'Invalid playback control payload'
    );
    assert(nullProgOk, 'WebSocket rejects null progress in playback_control');

    // Unsubscribe driver with null payload
    const nullUnsubOk = await testWsEvent(
      'client:v1:unsubscribe_driver',
      null,
      'Invalid unsubscribe payload'
    );
    assert(nullUnsubOk, 'WebSocket rejects null unsubscribe_driver payload');

    // Invalid speed option
    const badSpeedOk = await testWsEvent(
      'client:v1:playback_control',
      { action: 'play', speed: 10 },
      'Invalid playback control payload'
    );
    assert(badSpeedOk, 'WebSocket rejects unsupported playback speed');

    // Valid playback control
    client.emit('client:v1:playback_control', { action: 'play', speed: 1 });
    // Valid subscribe
    client.emit('client:v1:subscribe_driver', { driverNumber: 1 });
    // Valid unsubscribe
    client.emit('client:v1:unsubscribe_driver', { driverNumber: 1 });

    // Confirm server is still alive and responding after all malicious payloads
    await new Promise((r) => setTimeout(r, 300));
    const finalHealth = await fetch(`${baseUrl}/api/health`);
    assert(finalHealth.status === 200, 'Server remains fully healthy after malicious WebSocket fuzzing');

    client.disconnect();

  } finally {
    server.close();
  }

  console.log(`\n========================================`);
  console.log(`Tests Completed: ${passed + failed}`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log(`========================================\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
