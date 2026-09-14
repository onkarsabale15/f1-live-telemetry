#!/usr/bin/env node

/**
 * Unified E2E Test Suite Runner
 * 
 * Runs Tiers 1-4:
 * - Tier 1: Feature Coverage (REST & WebSocket Happy Path)
 * - Tier 2: Boundary, Null Destructuring & Security Hardening
 * - Tier 3: Concurrency, Rapid Switching & Reconnect Resilience
 * - Tier 4: Real-World Scenarios, DRS Sporting Rules & Telemetry Physics
 * 
 * Usage:
 *   node tests/e2e/run-all.js
 *   node tests/e2e/run-all.js --tier=1
 *   node tests/e2e/run-all.js --tier=2
 *   node tests/e2e/run-all.js --tier=3
 *   node tests/e2e/run-all.js --tier=4
 */

const { ensureServerRunning, teardownServer, runSuites } = require('./test-harness');

async function main() {
  console.log(`
🏎️ ====================================================================
   F1 LIVE TELEMETRY - COMPREHENSIVE E2E VERIFICATION SUITE
   Tiers 1-4: Feature, Boundary, Concurrency & Real-World Scenarios
====================================================================
`);

  // Parse command-line args for tier filtering
  const args = process.argv.slice(2);
  let targetTier = null;

  for (const arg of args) {
    const match = arg.match(/--tier=(\d)/i) || arg.match(/tier(\d)/i);
    if (match) {
      targetTier = parseInt(match[1], 10);
    }
  }

  let serverStartedByRunner = false;

  try {
    // 1. Ensure backend server is accessible
    await ensureServerRunning();
    serverStartedByRunner = true;

    // 2. Load test modules based on target tier
    if (!targetTier || targetTier === 1) {
      require('./tier1-feature.test');
    }
    if (!targetTier || targetTier === 2) {
      require('./tier2-boundary.test');
    }
    if (!targetTier || targetTier === 3) {
      require('./tier3-interactions.test');
    }
    if (!targetTier || targetTier === 4) {
      require('./tier4-scenarios.test');
    }
    if (!targetTier || targetTier === 5) {
      require('./tier5-adversarial-backend.test');
      require('./tier5-adversarial-frontend.test');
    }

    // 3. Execute test suites
    const filterName = targetTier ? `Tier ${targetTier}` : null;
    const results = await runSuites(filterName);

    // 4. Teardown
    await teardownServer();

    if (results.failed > 0) {
      console.log(`\n\x1b[31m❌ TEST SUITE FAILED: ${results.failed} test(s) failed out of ${results.total}.\x1b[0m\n`);
      process.exit(1);
    } else {
      console.log(`\n\x1b[32m✅ ALL E2E TESTS PASSED (${results.passed}/${results.total})\x1b[0m\n`);
      process.exit(0);
    }
  } catch (err) {
    console.error('\n\x1b[31m💥 Fatal Runner Error:\x1b[0m', err.message);
    if (err.stack) console.error(err.stack);
    await teardownServer().catch(() => {});
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
