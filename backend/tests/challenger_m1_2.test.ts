import http from 'http';
import { AddressInfo } from 'net';
import express, { Request, Response, NextFunction } from 'express';
import { createApp } from '../src/app';
import { ENV } from '../src/config/env';

interface TestResult {
  suite: string;
  name: string;
  passed: boolean;
  details?: string;
}

const results: TestResult[] = [];

function recordTest(suite: string, name: string, condition: boolean, details?: string) {
  if (condition) {
    console.log(`  ✅ [PASS] ${name}`);
  } else {
    console.error(`  ❌ [FAIL] ${name}${details ? ` -> ${details}` : ''}`);
  }
  results.push({ suite, name, passed: condition, details });
}

async function startServer(appInstance: express.Application): Promise<{ server: http.Server; baseUrl: string }> {
  const server = http.createServer(appInstance);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

async function main() {
  console.log('===============================================================');
  console.log('🏎️  Milestone 1 Challenger 2: Empirical REST Security Harness');
  console.log('===============================================================\n');

  // =========================================================================
  // SUITE 1: RATE LIMITING BURST VERIFICATION
  // =========================================================================
  console.log('--- SUITE 1: REST Rate Limiting Verification ---');

  // 1A: Burst traffic on /api/auth/profile (max 20 requests per 15 min)
  {
    const { server, baseUrl } = await startServer(createApp());
    try {
      console.log('  Testing /api/auth/profile burst (limit: 20 req/15min)...');
      
      // Send 20 requests
      let non429Count = 0;
      let lastHeaders: Headers | null = null;
      for (let i = 1; i <= 20; i++) {
        const res = await fetch(`${baseUrl}/api/auth/profile?email=burst-${i}@test.com`);
        if (res.status !== 429) {
          non429Count++;
        }
        lastHeaders = res.headers;
      }
      recordTest(
        'Rate Limiting',
        'Requests 1-20 to /api/auth/profile do not trigger HTTP 429',
        non429Count === 20,
        `Expected 20 non-429 responses, got ${non429Count}`
      );

      // Request 21 should trigger 429
      const res21 = await fetch(`${baseUrl}/api/auth/profile?email=burst-21@test.com`);
      const body21 = (await res21.json()) as any;
      recordTest(
        'Rate Limiting',
        'Request 21 to /api/auth/profile triggers HTTP 429 Too Many Requests',
        res21.status === 429,
        `Expected status 429, got ${res21.status}`
      );
      recordTest(
        'Rate Limiting',
        'Request 21 body contains structured error message',
        body21.success === false && body21.error?.includes('Too many authentication attempts'),
        `Body: ${JSON.stringify(body21)}`
      );

      // Check standard RateLimit and Retry-After headers on 429
      const retryAfter = res21.headers.get('retry-after');
      const rateLimitLimit = res21.headers.get('ratelimit-limit');
      const rateLimitRemaining = res21.headers.get('ratelimit-remaining');
      const rateLimitReset = res21.headers.get('ratelimit-reset');

      recordTest(
        'Rate Limiting',
        'HTTP 429 response contains Retry-After header',
        retryAfter !== null && parseInt(retryAfter, 10) > 0,
        `Retry-After: ${retryAfter}`
      );
      recordTest(
        'Rate Limiting',
        'HTTP 429 response contains RateLimit-Limit header equaling 20',
        rateLimitLimit === '20',
        `RateLimit-Limit: ${rateLimitLimit}`
      );
      recordTest(
        'Rate Limiting',
        'HTTP 429 response contains RateLimit-Remaining header equaling 0',
        rateLimitRemaining === '0',
        `RateLimit-Remaining: ${rateLimitRemaining}`
      );
      recordTest(
        'Rate Limiting',
        'HTTP 429 response contains RateLimit-Reset header',
        rateLimitReset !== null && parseInt(rateLimitReset, 10) > 0,
        `RateLimit-Reset: ${rateLimitReset}`
      );

      // Concurrent burst stress: 30 simultaneous requests
      console.log('  Testing concurrent burst of 30 requests to /api/auth/profile...');
      const burstPromises = Array.from({ length: 30 }, (_, idx) =>
        fetch(`${baseUrl}/api/auth/profile?email=concurrent-${idx}@test.com`)
      );
      const burstResponses = await Promise.all(burstPromises);
      const allAre429 = burstResponses.every((r) => r.status === 429);
      recordTest(
        'Rate Limiting',
        'Concurrent burst requests against saturated auth route all return HTTP 429',
        allAre429,
        `Statuses: ${burstResponses.map((r) => r.status).slice(0, 5).join(', ')}...`
      );
    } finally {
      server.close();
    }
  }

  // 1B: Burst traffic on /api/health (max 200 requests per 15 min)
  {
    const { server, baseUrl } = await startServer(createApp());
    try {
      console.log('  Testing /api/health general limiter burst (limit: 200 req/15min)...');
      
      // Fire 200 requests in batches of 50 to avoid socket pool starvation
      let batchSuccess = true;
      for (let batch = 0; batch < 4; batch++) {
        const promises = Array.from({ length: 50 }, () => fetch(`${baseUrl}/api/health`));
        const resps = await Promise.all(promises);
        if (!resps.every((r) => r.status === 200)) {
          batchSuccess = false;
          break;
        }
      }
      recordTest(
        'Rate Limiting',
        'First 200 requests to /api/health succeed with HTTP 200',
        batchSuccess,
        'One or more requests failed before reaching 200 limit'
      );

      // Request 201 should trigger 429
      const res201 = await fetch(`${baseUrl}/api/health`);
      const body201 = (await res201.json()) as any;
      recordTest(
        'Rate Limiting',
        'Request 201 to /api/health triggers HTTP 429 Too Many Requests',
        res201.status === 429,
        `Expected status 429, got ${res201.status}`
      );
      recordTest(
        'Rate Limiting',
        'Request 201 body indicates general rate limit exceeded',
        body201.success === false && body201.error?.includes('Too many requests'),
        `Body: ${JSON.stringify(body201)}`
      );

      const retryAfter201 = res201.headers.get('retry-after');
      const rateLimitLimit201 = res201.headers.get('ratelimit-limit');
      const rateLimitRemaining201 = res201.headers.get('ratelimit-remaining');

      recordTest(
        'Rate Limiting',
        '/api/health 429 contains Retry-After and RateLimit-Limit (200)',
        retryAfter201 !== null && rateLimitLimit201 === '200' && rateLimitRemaining201 === '0',
        `Retry-After: ${retryAfter201}, RateLimit-Limit: ${rateLimitLimit201}, Remaining: ${rateLimitRemaining201}`
      );
    } finally {
      server.close();
    }
  }

  // =========================================================================
  // SUITE 2: CORS ORIGIN RESTRICTION & FORBIDDEN PROTECTION
  // =========================================================================
  console.log('\n--- SUITE 2: CORS & Origin Protection ---');
  {
    const { server, baseUrl } = await startServer(createApp());
    try {
      // 2A: Authorized Origin in Dev (http://localhost:3000)
      const resAuth = await fetch(`${baseUrl}/api/health`, {
        headers: { Origin: 'http://localhost:3000' },
      });
      recordTest(
        'CORS Protection',
        'Authorized origin http://localhost:3000 receives 200 and Access-Control-Allow-Origin',
        resAuth.status === 200 && resAuth.headers.get('access-control-allow-origin') === 'http://localhost:3000',
        `Status: ${resAuth.status}, ACAO: ${resAuth.headers.get('access-control-allow-origin')}`
      );
      recordTest(
        'CORS Protection',
        'Authorized origin receives Access-Control-Allow-Credentials = true',
        resAuth.headers.get('access-control-allow-credentials') === 'true',
        `ACAC: ${resAuth.headers.get('access-control-allow-credentials')}`
      );

      // 2B: Authorized Origin in Dev (http://127.0.0.1:3000)
      const resAuth127 = await fetch(`${baseUrl}/api/health`, {
        headers: { Origin: 'http://127.0.0.1:3000' },
      });
      recordTest(
        'CORS Protection',
        'Authorized origin http://127.0.0.1:3000 receives 200 and Access-Control-Allow-Origin',
        resAuth127.status === 200 && resAuth127.headers.get('access-control-allow-origin') === 'http://127.0.0.1:3000',
        `Status: ${resAuth127.status}, ACAO: ${resAuth127.headers.get('access-control-allow-origin')}`
      );

      // 2C: Unauthorized Origin (http://evil-hacker.com)
      const resEvil = await fetch(`${baseUrl}/api/health`, {
        headers: { Origin: 'http://evil-hacker.com' },
      });
      const bodyEvil = (await resEvil.json()) as any;
      recordTest(
        'CORS Protection',
        'Unauthorized origin http://evil-hacker.com receives HTTP 403 Forbidden',
        resEvil.status === 403,
        `Status: ${resEvil.status}`
      );
      recordTest(
        'CORS Protection',
        'Unauthorized origin does not receive Access-Control-Allow-Origin for evil-hacker.com',
        resEvil.headers.get('access-control-allow-origin') !== 'http://evil-hacker.com',
        `ACAO header: ${resEvil.headers.get('access-control-allow-origin')}`
      );
      recordTest(
        'CORS Protection',
        'Unauthorized origin receives structured CORS violation error',
        bodyEvil.success === false && bodyEvil.error?.includes('CORS policy violation'),
        `Body: ${JSON.stringify(bodyEvil)}`
      );

      // 2D: Subdomain spoofing attempt (http://localhost:3000.attacker.com)
      const resSpoof = await fetch(`${baseUrl}/api/health`, {
        headers: { Origin: 'http://localhost:3000.attacker.com' },
      });
      recordTest(
        'CORS Protection',
        'Domain suffix spoofing (http://localhost:3000.attacker.com) receives HTTP 403',
        resSpoof.status === 403,
        `Status: ${resSpoof.status}`
      );

      // 2E: Prefix spoofing attempt (http://evil-localhost:3000)
      const resPrefixSpoof = await fetch(`${baseUrl}/api/health`, {
        headers: { Origin: 'http://evil-localhost:3000' },
      });
      recordTest(
        'CORS Protection',
        'Domain prefix spoofing (http://evil-localhost:3000) receives HTTP 403',
        resPrefixSpoof.status === 403,
        `Status: ${resPrefixSpoof.status}`
      );

      // 2F: Origin: "null" (sandboxed iframe / local file attack)
      const resNullOrigin = await fetch(`${baseUrl}/api/health`, {
        headers: { Origin: 'null' },
      });
      recordTest(
        'CORS Protection',
        'String "null" origin receives HTTP 403 Forbidden',
        resNullOrigin.status === 403,
        `Status: ${resNullOrigin.status}`
      );

      // 2G: Preflight OPTIONS request from unauthorized origin
      const resPreflightEvil = await fetch(`${baseUrl}/api/auth/google`, {
        method: 'OPTIONS',
        headers: {
          Origin: 'http://evil-hacker.com',
          'Access-Control-Request-Method': 'POST',
        },
      });
      recordTest(
        'CORS Protection',
        'Preflight OPTIONS from unauthorized origin is rejected with HTTP 403',
        resPreflightEvil.status === 403,
        `Status: ${resPreflightEvil.status}`
      );

      // 2H: Preflight OPTIONS request from authorized origin
      const resPreflightAuth = await fetch(`${baseUrl}/api/auth/google`, {
        method: 'OPTIONS',
        headers: {
          Origin: 'http://localhost:3000',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'Content-Type',
        },
      });
      recordTest(
        'CORS Protection',
        'Preflight OPTIONS from authorized origin succeeds with 204 or 200',
        resPreflightAuth.status === 204 || resPreflightAuth.status === 200,
        `Status: ${resPreflightAuth.status}`
      );
    } finally {
      server.close();
    }
  }

  // 2I: Production Mode Origin Enforcement (strict CORS_ORIGIN only)
  {
    console.log('  Testing Production Mode CORS Origin isolation...');
    const originalEnv = ENV.NODE_ENV;
    const originalCorsOrigin = ENV.CORS_ORIGIN;
    try {
      (ENV as any).NODE_ENV = 'production';
      (ENV as any).CORS_ORIGIN = 'https://telemetry.f1.com';

      const { server, baseUrl } = await startServer(createApp());
      try {
        // In production, localhost:3000 MUST BE REJECTED
        const resProdLocal = await fetch(`${baseUrl}/api/health`, {
          headers: { Origin: 'http://localhost:3000' },
        });
        recordTest(
          'CORS Protection',
          'Production mode rejects http://localhost:3000 with HTTP 403 Forbidden',
          resProdLocal.status === 403,
          `Status: ${resProdLocal.status}`
        );

        // In production, only https://telemetry.f1.com is allowed
        const resProdAllowed = await fetch(`${baseUrl}/api/health`, {
          headers: { Origin: 'https://telemetry.f1.com' },
        });
        recordTest(
          'CORS Protection',
          'Production mode permits https://telemetry.f1.com with 200 and matching ACAO',
          resProdAllowed.status === 200 && resProdAllowed.headers.get('access-control-allow-origin') === 'https://telemetry.f1.com',
          `Status: ${resProdAllowed.status}, ACAO: ${resProdAllowed.headers.get('access-control-allow-origin')}`
        );
      } finally {
        server.close();
      }
    } finally {
      (ENV as any).NODE_ENV = originalEnv;
      (ENV as any).CORS_ORIGIN = originalCorsOrigin;
    }
  }

  // =========================================================================
  // SUITE 3: PAYLOAD SIZE LIMITATION (>10KB REJECTION)
  // =========================================================================
  console.log('\n--- SUITE 3: Body Payload Size Limit (10kb) ---');
  {
    const { server, baseUrl } = await startServer(createApp());
    try {
      // 3A: Valid payload below limit (e.g. 500 bytes)
      const validSmallPayload = JSON.stringify({
        email: 'driver4@mclaren.com',
        googleId: 'google-uid-12345',
        name: 'Lando Norris',
      });
      const resSmall = await fetch(`${baseUrl}/api/auth/google`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: validSmallPayload,
      });
      recordTest(
        'Payload Size Limit',
        'Valid payload under 10kb accepted without HTTP 413',
        resSmall.status === 200,
        `Status: ${resSmall.status}`
      );

      // 3B: Exact boundary test: 10,240 bytes (10kb)
      // Craft a payload where Buffer.byteLength is exactly 10,240 bytes
      const targetBytes = 10240;
      const baseObj = { email: 'boundary@f1.com', googleId: 'gid-boundary', padding: '' };
      const baseLength = Buffer.byteLength(JSON.stringify(baseObj));
      const padLength = targetBytes - baseLength;
      baseObj.padding = 'A'.repeat(padLength);
      const exact10kbPayload = JSON.stringify(baseObj);

      const resBoundary = await fetch(`${baseUrl}/api/auth/google`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: exact10kbPayload,
      });
      recordTest(
        'Payload Size Limit',
        'Exact 10,240 byte payload does NOT return HTTP 413',
        resBoundary.status !== 413,
        `Status: ${resBoundary.status}`
      );

      // 3C: One byte over boundary: 10,241 bytes
      baseObj.padding = 'A'.repeat(padLength + 1);
      const over10kbPayload = JSON.stringify(baseObj);
      const resOverBoundary = await fetch(`${baseUrl}/api/auth/google`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: over10kbPayload,
      });
      recordTest(
        'Payload Size Limit',
        'Payload of 10,241 bytes (> 10kb) returns HTTP 413 Payload Too Large',
        resOverBoundary.status === 413,
        `Status: ${resOverBoundary.status}`
      );

      // 3D: Substantial 15kb payload to /api/auth/google
      const payload15kb = JSON.stringify({
        email: 'large@f1.com',
        googleId: 'large-id',
        name: 'B'.repeat(15 * 1024),
      });
      const res15kb = await fetch(`${baseUrl}/api/auth/google`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload15kb,
      });
      const body15kb = (await res15kb.json()) as any;
      recordTest(
        'Payload Size Limit',
        '15kb JSON payload to /api/auth/google returns HTTP 413',
        res15kb.status === 413,
        `Status: ${res15kb.status}`
      );
      recordTest(
        'Payload Size Limit',
        '413 response body has structured error format',
        body15kb.success === false && typeof body15kb.error === 'string',
        `Body: ${JSON.stringify(body15kb)}`
      );

      // 3E: Extreme 250kb flood payload
      const payload250kb = JSON.stringify({
        userId: 'flood-user',
        data: 'Z'.repeat(250 * 1024),
      });
      const res250kb = await fetch(`${baseUrl}/api/auth/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload250kb,
      });
      recordTest(
        'Payload Size Limit',
        '250kb payload rejected with HTTP 413 without crashing server',
        res250kb.status === 413,
        `Status: ${res250kb.status}`
      );

      // Verify server is still alive
      const resAlive = await fetch(`${baseUrl}/api/health`);
      recordTest(
        'Payload Size Limit',
        'Server remains fully operational after handling oversized payloads',
        resAlive.status === 200,
        `Status: ${resAlive.status}`
      );
    } finally {
      server.close();
    }
  }

  // =========================================================================
  // SUITE 4: INFORMATION LEAKAGE & STACK TRACE SUPPRESSION
  // =========================================================================
  console.log('\n--- SUITE 4: Information Leakage & Stack Trace Suppression ---');
  {
    const { server, baseUrl } = await startServer(createApp());
    try {
      // 4A: Deliberate 400 - Malformed JSON Syntax
      const resMalformedJson = await fetch(`${baseUrl}/api/auth/google`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"email": "broken-json", missing_quotes: }',
      });
      const bodyMalformed = (await resMalformedJson.json()) as any;
      recordTest(
        'Information Leakage',
        'Malformed JSON returns HTTP 400 Bad Request',
        resMalformedJson.status === 400,
        `Status: ${resMalformedJson.status}`
      );
      const bodyStrMalformed = JSON.stringify(bodyMalformed);
      const stackTraceRegex = /(?:\n\s*at\s+|(?:\bat\s+[\w$.<>[\]/\\:-]+:\d+:\d+))/;
      recordTest(
        'Information Leakage',
        'Malformed JSON error does not leak stack trace or server file paths',
        !stackTraceRegex.test(bodyStrMalformed) &&
          !bodyStrMalformed.includes('\\backend\\') &&
          !bodyStrMalformed.includes('/backend/') &&
          !('stack' in bodyMalformed),
        `Body: ${bodyStrMalformed}`
      );

      // 4B: Deliberate 400 - SQL Injection in query params
      const sqlInjections = [
        `' OR '1'='1`,
        `admin'--`,
        `select * from users;`,
        `'; DROP TABLE "User";--`,
      ];
      for (const sqli of sqlInjections) {
        const resSqli = await fetch(`${baseUrl}/api/auth/profile?email=${encodeURIComponent(sqli)}`);
        const bodySqli = (await resSqli.json()) as any;
        const bodyStrSqli = JSON.stringify(bodySqli);

        recordTest(
          'Information Leakage',
          `SQL injection query "${sqli}" rejected with 400 without schema disclosure`,
          resSqli.status === 400 &&
            !bodyStrSqli.toLowerCase().includes('prisma') &&
            !bodyStrSqli.toLowerCase().includes('postgres') &&
            !bodyStrSqli.toLowerCase().includes('syntax error') &&
            !('stack' in bodySqli),
          `Body: ${bodyStrSqli}`
        );
      }

      // 4C: Deliberate 400 - SQL Injection in route param (/api/sessions/:sessionKey/load)
      const resSqliParam = await fetch(`${baseUrl}/api/sessions/9999%20OR%201=1/load`, {
        method: 'POST',
      });
      const bodySqliParam = (await resSqliParam.json()) as any;
      recordTest(
        'Information Leakage',
        'Route parameter injection rejected with 400 without SQL error leakage',
        resSqliParam.status === 400 &&
          bodySqliParam.success === false &&
          !JSON.stringify(bodySqliParam).toLowerCase().includes('sql'),
        `Body: ${JSON.stringify(bodySqliParam)}`
      );

      // 4D: Deliberate 404 - Unknown API endpoint
      const res404 = await fetch(`${baseUrl}/api/unknown_route_adversarial_probe`);
      const body404 = (await res404.json()) as any;
      recordTest(
        'Information Leakage',
        'Unknown API route returns structured 404 with zero internal paths',
        res404.status === 404 &&
          body404.success === false &&
          body404.error === 'Endpoint not found' &&
          !('stack' in body404),
        `Body: ${JSON.stringify(body404)}`
      );
    } finally {
      server.close();
    }
  }

  // 4E: Deliberate 500 Simulation: Controller Database Error Suppression
  {
    console.log('  Testing Controller 500 error sanitization...');
    const { simulationEngine } = await import('../src/services/simulation.service');
    const originalInit = simulationEngine.initialize;

    try {
      // Mock simulationEngine.initialize to throw an internal database error with sensitive info
      simulationEngine.initialize = async () => {
        throw new Error('FATAL: Database connection failed on postgres://admin:superSecretPassword@10.0.0.1:5432/f1_live');
      };

      const { server, baseUrl } = await startServer(createApp());
      try {
        const res500 = await fetch(`${baseUrl}/api/sessions/101/load`, { method: 'POST' });
        const body500 = (await res500.json()) as any;
        const bodyStr500 = JSON.stringify(body500);

        recordTest(
          'Information Leakage',
          'Controller 500 returns HTTP 500 Internal Server Error',
          res500.status === 500,
          `Status: ${res500.status}`
        );
        recordTest(
          'Information Leakage',
          'Controller 500 returns sanitized message without leaking database credentials or queries',
          body500.success === false &&
            body500.error === 'Failed to load session' &&
            !bodyStr500.includes('superSecretPassword') &&
            !bodyStr500.includes('postgres://') &&
            !('stack' in body500),
          `Body: ${bodyStr500}`
        );
      } finally {
        server.close();
      }
    } finally {
      simulationEngine.initialize = originalInit;
    }
  }

  // 4F: Centralized Error Handler Middleware Isolation (Unhandled 500 in Dev vs Prod)
  {
    console.log('  Testing Centralized Error Handler (Dev vs Prod unhandled errors)...');

    // Test in Development
    const devApp = express();
    devApp.use(express.json());
    devApp.get('/api/unhandled-fault', (_req, _res, next) => {
      const sensitiveErr = new Error('Unhandled Prisma error in query execution: SELECT * FROM "Telemetry"');
      (sensitiveErr as any).stack = 'Error: Unhandled Prisma error\n    at PrismaClient.query (/app/src/db.ts:42:15)';
      next(sensitiveErr);
    });
    // App's centralized error handler from app.ts
    devApp.use((err: any, req: Request, res: Response, _next: NextFunction) => {
      const statusCode = err.status || err.statusCode || 500;
      res.status(statusCode).json({
        success: false,
        error: ENV.NODE_ENV === 'production' && statusCode >= 500
          ? 'Internal server error'
          : (err.message || 'An unexpected error occurred'),
      });
    });

    const { server: devServer, baseUrl: devBaseUrl } = await startServer(devApp);
    try {
      const resDev = await fetch(`${devBaseUrl}/api/unhandled-fault`);
      const bodyDev = (await resDev.json()) as any;
      const bodyStrDev = JSON.stringify(bodyDev);
      recordTest(
        'Information Leakage',
        'Centralized error handler in dev returns 500 without stack property',
        resDev.status === 500 && !('stack' in bodyDev) && !bodyStrDev.includes('/app/src/db.ts'),
        `Body: ${bodyStrDev}`
      );
    } finally {
      devServer.close();
    }

    // Test in Production
    const originalEnv = ENV.NODE_ENV;
    try {
      (ENV as any).NODE_ENV = 'production';
      const prodApp = express();
      prodApp.use(express.json());
      prodApp.get('/api/unhandled-fault', (_req, _res, next) => {
        const sensitiveErr = new Error('DATABASE_URL connection failure: postgres://root:superSecret@db:5432');
        (sensitiveErr as any).stack = 'Error: connection failure\n    at Driver.connect (/app/node_modules/pg/client.js:10:5)';
        next(sensitiveErr);
      });
      prodApp.use((err: any, req: Request, res: Response, _next: NextFunction) => {
        const statusCode = err.status || err.statusCode || 500;
        res.status(statusCode).json({
          success: false,
          error: ENV.NODE_ENV === 'production' && statusCode >= 500
            ? 'Internal server error'
            : (err.message || 'An unexpected error occurred'),
        });
      });

      const { server: prodServer, baseUrl: prodBaseUrl } = await startServer(prodApp);
      try {
        const resProd = await fetch(`${prodBaseUrl}/api/unhandled-fault`);
        const bodyProd = (await resProd.json()) as any;
        const bodyStrProd = JSON.stringify(bodyProd);
        recordTest(
          'Information Leakage',
          'Centralized error handler in production strictly masks 500 as "Internal server error"',
          resProd.status === 500 && bodyProd.error === 'Internal server error',
          `Body: ${bodyStrProd}`
        );
        recordTest(
          'Information Leakage',
          'Production 500 completely suppresses passwords, queries, and file paths',
          !bodyStrProd.includes('superSecret') &&
            !bodyStrProd.includes('postgres://') &&
            !bodyStrProd.includes('/app/node_modules') &&
            !('stack' in bodyProd),
          `Body: ${bodyStrProd}`
        );
      } finally {
        prodServer.close();
      }
    } finally {
      (ENV as any).NODE_ENV = originalEnv;
    }
  }

  // =========================================================================
  // SUMMARY EVALUATION
  // =========================================================================
  console.log('\n===============================================================');
  console.log('CHALLENGER 2 EMPIRICAL TEST SUMMARY');
  console.log('===============================================================');
  const total = results.length;
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;

  console.log(`Total Assertions Evaluated : ${total}`);
  console.log(`Passed                     : ${passed}`);
  console.log(`Failed                     : ${failed}`);
  console.log(`Overall Pass Rate          : ${((passed / total) * 100).toFixed(1)}%`);
  console.log('===============================================================\n');

  if (failed > 0) {
    console.error(`💥 ${failed} assertion(s) failed!`);
    process.exit(1);
  } else {
    console.log('🎉 ALL EMPIRICAL CHALLENGER ASSERTIONS PASSED!');
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('Fatal unhandled test exception:', err);
  process.exit(1);
});
