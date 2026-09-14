/**
 * F1 Live Telemetry - E2E Testing Harness & Shared Utilities
 * 
 * Provides:
 * - Opaque-box HTTP and WebSocket client helpers
 * - Auto-server detection and in-process fallback launcher
 * - Assertion primitives and structured test execution engine
 */

const http = require('http');
const path = require('path');

// 1. Dynamic Socket.io Client Resolution
let ioClient;
try {
  ioClient = require('socket.io-client');
} catch (e1) {
  try {
    ioClient = require(path.resolve(__dirname, '../../frontend/node_modules/socket.io-client'));
  } catch (e2) {
    try {
      ioClient = require(path.resolve(__dirname, '../../backend/node_modules/socket.io-client'));
    } catch (e3) {
      console.warn('⚠️ socket.io-client could not be loaded directly:', e2.message);
    }
  }
}

function getIo() {
  if (typeof ioClient === 'function') return ioClient;
  if (ioClient && typeof ioClient.io === 'function') return ioClient.io;
  if (ioClient && typeof ioClient.default === 'function') return ioClient.default;
  return ioClient;
}

// Configuration
const DEFAULT_PORT = 4000;
const BASE_URL = process.env.TEST_BACKEND_URL || `http://localhost:${DEFAULT_PORT}`;
const WS_URL = process.env.TEST_WS_URL || BASE_URL;

let spawnedHttpServer = null;
let spawnedWsGateway = null;

// ============================================================================
// Assertion Primitives
// ============================================================================

class AssertionError extends Error {
  constructor(message, actual, expected) {
    super(message);
    this.name = 'AssertionError';
    this.actual = actual;
    this.expected = expected;
  }
}

function assert(condition, message = 'Assertion failed') {
  if (!condition) {
    throw new AssertionError(message, condition, true);
  }
}

function assertEqual(actual, expected, message = '') {
  if (actual !== expected) {
    const msg = message
      ? `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
      : `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
    throw new AssertionError(msg, actual, expected);
  }
}

function assertNotEqual(actual, expected, message = '') {
  if (actual === expected) {
    const msg = message
      ? `${message}: expected value not to equal ${JSON.stringify(expected)}`
      : `Expected value not to equal ${JSON.stringify(expected)}`;
    throw new AssertionError(msg, actual, expected);
  }
}

function assertDeepEqual(actual, expected, message = '') {
  const actualStr = JSON.stringify(actual);
  const expectedStr = JSON.stringify(expected);
  if (actualStr !== expectedStr) {
    const msg = message
      ? `${message}: mismatch`
      : `Deep equality mismatch: expected ${expectedStr}, got ${actualStr}`;
    throw new AssertionError(msg, actual, expected);
  }
}

function assertInRange(value, min, max, message = '') {
  if (typeof value !== 'number' || Number.isNaN(value) || value < min || value > max) {
    const msg = message
      ? `${message}: ${value} not in [${min}, ${max}]`
      : `Value ${value} is outside expected range [${min}, ${max}]`;
    throw new AssertionError(msg, value, { min, max });
  }
}

function assertMatches(string, regex, message = '') {
  if (!regex.test(string)) {
    const msg = message
      ? `${message}: "${string}" does not match ${regex}`
      : `String "${string}" does not match pattern ${regex}`;
    throw new AssertionError(msg, string, regex.toString());
  }
}

function assertDefined(value, message = 'Expected value to be defined') {
  if (value === undefined || value === null) {
    throw new AssertionError(message, value, 'defined');
  }
}

// ============================================================================
// HTTP Client Helpers
// ============================================================================

async function request(endpoint, options = {}) {
  const url = endpoint.startsWith('http') ? endpoint : `${BASE_URL}${endpoint}`;
  const { method = 'GET', headers = {}, body } = options;

  const reqHeaders = { ...headers };
  let reqBody = body;

  if (body && typeof body === 'object' && !(body instanceof Buffer)) {
    reqHeaders['Content-Type'] = reqHeaders['Content-Type'] || 'application/json';
    reqBody = JSON.stringify(body);
  }

  const response = await fetch(url, {
    method,
    headers: reqHeaders,
    body: reqBody,
  });

  let data = null;
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    try {
      data = await response.json();
    } catch {
      data = null;
    }
  } else {
    data = await response.text();
  }

  return {
    status: response.status,
    headers: response.headers,
    data,
  };
}

// ============================================================================
// WebSocket Client Helpers
// ============================================================================

function createSocket(options = {}) {
  const ioFn = getIo();
  if (!ioFn || typeof ioFn !== 'function') {
    throw new Error('Socket.io client is not available. Please ensure socket.io-client is installed.');
  }

  const socket = ioFn(WS_URL, {
    transports: ['websocket'],
    reconnection: false,
    timeout: 5000,
    forceNew: true,
    ...options,
  });

  return socket;
}

function waitForConnect(socket, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    if (socket.connected) return resolve(socket);
    const timer = setTimeout(() => {
      reject(new Error(`WebSocket connection timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });

    socket.once('connect_error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
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
        // continue waiting
      }
    };

    socket.on(eventName, handler);
  });
}

// ============================================================================
// Server Lifecycle (Auto-Start / Teardown)
// ============================================================================

async function isServerReachable() {
  try {
    const res = await fetch(`${BASE_URL}/api/health`, { signal: AbortSignal.timeout(1000) });
    return res.status === 200;
  } catch {
    return false;
  }
}

async function ensureServerRunning() {
  const reachable = await isServerReachable();
  if (reachable) {
    console.log(`📡 Connecting to active F1 backend at ${BASE_URL}`);
    return;
  }

  console.log(`⚡ No server detected at ${BASE_URL}. Launching in-process test server...`);

  try {
    const { createApp } = require(path.resolve(__dirname, '../../backend/dist/app'));
    const { F1WebSocketGateway } = require(path.resolve(__dirname, '../../backend/dist/websocket/socket.server'));
    const { simulationEngine } = require(path.resolve(__dirname, '../../backend/dist/services/simulation.service'));

    const app = createApp();
    const server = http.createServer(app);
    const wsGateway = new F1WebSocketGateway(server);

    await simulationEngine.initialize(9590);

    await new Promise((resolve) => {
      server.listen(DEFAULT_PORT, () => {
        console.log(`🏁 In-process test server running on ${BASE_URL}`);
        resolve();
      });
    });

    spawnedHttpServer = server;
    spawnedWsGateway = wsGateway;
  } catch (err) {
    throw new Error(`Failed to initialize in-process backend server: ${err.message}. Ensure backend is built (npm run build in backend/).`);
  }
}

async function teardownServer() {
  if (spawnedWsGateway && typeof spawnedWsGateway.getIO === 'function') {
    try {
      spawnedWsGateway.getIO().close();
    } catch {}
  }

  try {
    const { simulationEngine } = require(path.resolve(__dirname, '../../backend/dist/services/simulation.service'));
    if (simulationEngine && typeof simulationEngine.pause === 'function') {
      simulationEngine.pause();
    }
  } catch {}

  if (spawnedHttpServer) {
    await new Promise((resolve) => {
      spawnedHttpServer.close(() => {
        console.log('🛑 In-process test server stopped.');
        resolve();
      });
    });
    spawnedHttpServer = null;
  }
}

// ============================================================================
// Test Suite Runner Engine
// ============================================================================

const suites = [];
let currentSuite = null;

function describe(suiteName, fn) {
  const suite = {
    name: suiteName,
    tests: [],
    beforeAll: [],
    afterAll: [],
    beforeEach: [],
    afterEach: [],
  };
  suites.push(suite);
  currentSuite = suite;
  fn();
  currentSuite = null;
}

function test(testName, fn) {
  if (!currentSuite) {
    throw new Error(`test("${testName}") must be defined within a describe() block`);
  }
  currentSuite.tests.push({ name: testName, fn });
}

function beforeAll(fn) {
  if (currentSuite) currentSuite.beforeAll.push(fn);
}

function afterAll(fn) {
  if (currentSuite) currentSuite.afterAll.push(fn);
}

function beforeEach(fn) {
  if (currentSuite) currentSuite.beforeEach.push(fn);
}

function afterEach(fn) {
  if (currentSuite) currentSuite.afterEach.push(fn);
}

async function runSuites(filterSuiteName = null) {
  let totalTests = 0;
  let passedTests = 0;
  let failedTests = 0;
  const failures = [];

  const startTime = Date.now();

  for (const suite of suites) {
    if (filterSuiteName && !suite.name.toLowerCase().includes(filterSuiteName.toLowerCase())) {
      continue;
    }

    console.log(`\n\x1b[1m\x1b[36mSuite: ${suite.name}\x1b[0m`);

    for (const before of suite.beforeAll) {
      await before();
    }

    for (const t of suite.tests) {
      totalTests++;
      for (const before of suite.beforeEach) {
        await before();
      }

      const tStart = Date.now();
      try {
        await t.fn();
        const duration = Date.now() - tStart;
        passedTests++;
        console.log(`  \x1b[32m✓\x1b[0m \x1b[2m${t.name}\x1b[0m \x1b[33m(${duration}ms)\x1b[0m`);
      } catch (err) {
        const duration = Date.now() - tStart;
        failedTests++;
        console.log(`  \x1b[31m✗ ${t.name}\x1b[0m \x1b[33m(${duration}ms)\x1b[0m`);
        console.log(`    \x1b[31m${err.message}\x1b[0m`);
        failures.push({ suite: suite.name, test: t.name, error: err });
      }

      for (const after of suite.afterEach) {
        try {
          await after();
        } catch (e) {
          console.error(`Error in afterEach:`, e.message);
        }
      }
    }

    for (const after of suite.afterAll) {
      try {
        await after();
      } catch (e) {
        console.error(`Error in afterAll:`, e.message);
      }
    }
  }

  const totalDuration = Date.now() - startTime;

  console.log('\n' + '='.repeat(60));
  console.log(`Execution Summary:`);
  console.log(`Total:   ${totalTests}`);
  console.log(`Passed:  \x1b[32m${passedTests}\x1b[0m`);
  console.log(`Failed:  ${failedTests > 0 ? `\x1b[31m${failedTests}\x1b[0m` : '0'}`);
  console.log(`Elapsed: ${totalDuration}ms`);
  console.log('='.repeat(60));

  if (failures.length > 0) {
    console.log('\n\x1b[31mDetailed Failures:\x1b[0m');
    failures.forEach((f, idx) => {
      console.log(`\n${idx + 1}) [${f.suite}] ${f.test}`);
      console.log(`   ${f.error.stack || f.error.message}`);
    });
  }

  return { total: totalTests, passed: passedTests, failed: failedTests, duration: totalDuration, failures };
}

module.exports = {
  BASE_URL,
  WS_URL,
  assert,
  assertEqual,
  assertNotEqual,
  assertDeepEqual,
  assertInRange,
  assertMatches,
  assertDefined,
  request,
  createSocket,
  waitForConnect,
  waitForEvent,
  waitForEventMatching,
  ensureServerRunning,
  teardownServer,
  describe,
  test,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  runSuites,
};
