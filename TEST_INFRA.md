# Test Infrastructure & Methodology: F1 Live Telemetry

## Overview
This document defines the End-to-End (E2E) Test Architecture, execution methodology, expected output derivations, and feature coverage matrix for the **F1 Live Telemetry, Track Tracking & Overtake Predictor** system.

The test suite operates strictly as an **opaque-box client** exercising the public HTTP REST APIs (`http://localhost:4000`) and the real-time WebSocket Gateway (`ws://localhost:4000`), completely decoupled from internal implementation details.

---

## 1. System Architecture Under Test

```
+-------------------------------------------------------------------------+
|                              E2E Test Client                            |
|             (Native Node.js Fetch + Socket.io Client Runner)            |
+--------------------+--------------------------------+-------------------+
                     | HTTP REST                      | WebSocket
                     v (Port 4000)                    v (ws://localhost:4000)
+------------------------------------+   +--------------------------------+
|          Express REST API          |   |       Socket.io Gateway        |
|  - /api/health                     |   |  - f1:v1:session_init          |
|  - /api/sessions                   |   |  - f1:v1:grid_snapshot         |
|  - /api/sessions/current           |   |  - f1:v1:telemetry_tick        |
|  - /api/sessions/:key/load         |   |  - f1:v1:playback_state        |
|  - /api/auth/profile               |   |  - client:v1:subscribe_driver  |
|  - /api/auth/google                |   |  - client:v1:playback_control  |
|  - /api/auth/settings              |   |  - error                       |
+------------------+-----------------+   +---------------+----------------+
                   |                                     |
                   +------------------+------------------+
                                      |
                                      v
                      +-------------------------------+
                      |       Simulation Engine       |
                      |  - 250ms Telemetry Loop (4Hz) |
                      |  - Monza 2024 Circuit Model   |
                      |  - Overtake Predictor Service |
                      +-------------------------------+
```

---

## 2. 4-Tier Testing Methodology

The E2E test suite adheres to a structured 4-tier verification hierarchy ensuring functional correctness, resilience against malicious/malformed inputs, stability under concurrent workloads, and domain fidelity against FIA Sporting Regulations.

### Tier 1: Feature Coverage (Happy Path)
- **Objective**: Verify standard, specification-compliant behavior for all external interfaces.
- **REST APIs**:
  - `GET /api/health`: Service status, timestamp, Redis status, Database status.
  - `GET /api/sessions`: List available historical/live sessions (verifies Monza 2024 session `9590`).
  - `GET /api/sessions/current`: Active session metadata, 20 drivers, initial playback state.
  - `POST /api/sessions/:sessionKey/load`: Dynamic session initialization.
  - `GET /api/auth/profile`: User retrieval with valid email parameter.
  - `POST /api/auth/google`: User profile upsert with valid Google OAuth payload.
  - `POST /api/auth/settings`: User preferences update (driver, speed unit, sound alerts).
- **WebSocket Gateway**:
  - Initial handshake and automatic `f1:v1:session_init` event emission.
  - Driver subscription (`client:v1:subscribe_driver`) and reception of high-resolution telemetry ticks (`f1:v1:telemetry_tick`).
  - Global grid snapshot broadcasts (`f1:v1:grid_snapshot`) containing 20 car states.
  - Playback controls (`client:v1:playback_control` for `pause`, `play`, `seek`, and `speed`).
  - Driver unsubscription (`client:v1:unsubscribe_driver`).

### Tier 2: Boundary & Corner Cases (Robustness & Security)
- **Objective**: Stress edge values, invalid types, extreme numbers, security boundaries, and attack payloads.
- **WebSocket Hardening (SEC-01, SEC-02, SEC-13)**:
  - Destructuring attack resilience: Sending `null`, `undefined`, empty object `{}`, or strings to `client:v1:subscribe_driver` and `client:v1:playback_control` must emit `error` events and **never crash the server**.
  - Mathematical poisoning: Sending `progress: NaN`, `progress: Infinity`, `progress: -Infinity`, or negative values (`progress: -0.5`) to `seek` action must be rejected with `error`.
  - Progress bounds: Enforce `progress` strictly in range `[0.0, 1.0]`. Values `> 1.0` or `< 0.0` rejected.
  - Playback speed bounds: Only speeds `[1, 2, 4]` accepted. Speeds `<= 0`, `3`, or `> 4` rejected.
  - Driver number bounds: Reject `0`, negative numbers, numbers `> 99`, non-integers.
- **REST Input Boundaries**:
  - Non-numeric or negative session keys in `POST /api/sessions/:key/load` must return `400 Bad Request`.
  - Malformed email strings in `GET /api/auth/profile` must return `400 Bad Request`.
  - Missing required fields in `POST /api/auth/google` and `POST /api/auth/settings` return `400 Bad Request`.
  - Out-of-range driver numbers or invalid speed units (`'KNOTS'`) in settings return `400 Bad Request`.
- **Security & Infrastructure Controls (F01, F03)**:
  - Body Parser Limit: Payloads exceeding `10kb` must return `413 Payload Too Large`.
  - Security Headers: `X-Content-Type-Options: nosniff` must be present.
  - CORS Whitelist: Unauthorized external origins (e.g. `http://evil-attacker.com`) must not receive permissive CORS grant headers.

### Tier 3: Cross-Feature Interactions & Concurrency
- **Objective**: Validate race condition prevention, memory stability, and connection lifecycle robustness under load.
- **Rapid Driver Switching Burst**:
  - Emits rapid sequence of driver subscriptions (e.g. Norris 4 -> Verstappen 1 -> Leclerc 16 -> Hamilton 44 -> Norris 4) within 20ms intervals while simultaneously toggling playback speeds.
  - Verifies zero server unhandled rejections, zero dropped connections, and correct delivery of final driver telemetry.
- **Multi-Client Concurrency**:
  - Spawns 5 concurrent WebSocket clients, each subscribed to distinct drivers (Drivers 1, 4, 16, 44, 81).
  - Verifies all clients receive high-frequency telemetry ticks and synchronized global grid snapshots without crosstalk or starvation.
- **Network Drop & Reconnection Resilience**:
  - Simulates socket disconnect during active telemetry stream followed by immediate reconnection.
  - Verifies clean session initialization, zero orphaned listeners, and no event multiplication.
- **Interleaved REST Control & WebSocket Streams**:
  - Triggers REST `POST /api/sessions/9590/load` while multiple clients are actively consuming WebSocket streams.
  - Verifies telemetry continuity and synchronized playback state transitions across all clients.

### Tier 4: Real-World Scenarios & F1 Domain Integrity
- **Objective**: Validate high-fidelity simulation physics, F1 sporting regulations, and overtake prediction metrics.
- **Full Race Simulation Continuity**:
  - Monitors live grid across consecutive simulation ticks.
  - Verifies grid always maintains exactly 20 cars with continuous position rankings 1 through 20 (no duplicate or missing ranks).
  - Verifies leader (P1) has `gapToLeader === 0` and `intervalToAhead === 0`.
  - Verifies followers (P2..P20) maintain strictly non-negative `gapToLeader > 0`.
- **DRS Sporting Regulations Verification (F13)**:
  - Leader rule: Race leader (P1) must **never** have DRS enabled (`drs === false`).
  - Follower rule: DRS can only be active if `intervalToAhead <= 1.000s` AND vehicle is within an authorized DRS zone with throttle applied.
- **FIA Broadcast Tyre Standards (F17)**:
  - Verifies compounds strictly match FIA standards: `SOFT`, `MEDIUM`, `HARD`, `INTERMEDIATE`, `WET`.
  - Verifies tyre age is a non-negative integer.
- **Cockpit Telemetry Physics Bounds**:
  - Speed: `0 <= speed <= 370 km/h`.
  - RPM: `0 <= rpm <= 15,000 RPM`.
  - Gear: `gear in [-1, 0, 1, 2, 3, 4, 5, 6, 7, 8]` (-1 = Reverse, 0 = Neutral).
  - Throttle: `0 <= throttle <= 100%`.
  - Brake: `0 <= brake <= 100%`.
  - No `NaN`, `null`, or `Infinity` across any numeric telemetry attributes.
- **Overtake Prediction Model Sanity (F10)**:
  - Active battles must have valid chaser/defender codes and positive gaps.
  - `probability` bounded in `[0, 100]`.
  - `estLapsToPass` is finite and `>= 0` (no division-by-zero `Infinity` or `NaN`).

---

## 3. Test Directory Structure & File Inventory

```
d:/Education/F1/
├── tests/
│   └── e2e/
│       ├── test-harness.js           # Shared test framework, assertion helpers, auto-server launcher & socket wrapper
│       ├── tier1-feature.test.js     # Tier 1: REST & WebSocket Happy Path suite
│       ├── tier2-boundary.test.js    # Tier 2: Boundary, Null Destructuring, NaN & Security suite
│       ├── tier3-interactions.test.js# Tier 3: Concurrency, Rapid Switching & Reconnect suite
│       ├── tier4-scenarios.test.js   # Tier 4: F1 Domain Rules, DRS, Tyre & Telemetry Physics suite
│       └── run-all.js                # Unified CLI runner with formatted reporting and exit code handling
├── package.json                      # Root workspace test runner scripts
├── TEST_INFRA.md                     # Test Architecture & Methodology (This document)
└── TEST_READY.md                     # Test Suite Publication & Execution Status
```

---

## 4. Execution Instructions

### Unified Execution
Run all test tiers (Tiers 1-4) sequentially:
```bash
npm test
# or
node tests/e2e/run-all.js
```

### Targeted Tier Execution
Run individual test tiers:
```bash
# Tier 1: Feature / Happy Path
node tests/e2e/run-all.js --tier=1

# Tier 2: Boundary & Security
node tests/e2e/run-all.js --tier=2

# Tier 3: Cross-Feature Interactions & Concurrency
node tests/e2e/run-all.js --tier=3

# Tier 4: Real-World Scenarios & F1 Domain
node tests/e2e/run-all.js --tier=4
```

### Environment Configuration
The test harness respects the following environment variables:
| Variable | Default | Description |
|---|---|---|
| `TEST_BACKEND_URL` | `http://localhost:4000` | Target HTTP REST API base URL |
| `TEST_WS_URL` | `http://localhost:4000` | Target WebSocket Gateway URL |
| `TEST_AUTO_START` | `true` | Automatically starts backend if not running on target port |
| `TEST_TIMEOUT` | `10000` | Per-test execution timeout in milliseconds |

---

## 5. Feature Coverage Traceability Matrix

| Feature ID | Feature Name | Test Suite File | Specific Test Cases |
|---|---|---|---|
| **F01** | REST Security Headers & CORS | `tier2-boundary.test.js` | `Security Headers - Nosniff present`, `CORS Policy - Reject unauthorized origin` |
| **F02** | REST Rate Limiting | `tier2-boundary.test.js` | `Rate Limiting Headers & Thresholds` |
| **F03** | Payload Size Limitation | `tier2-boundary.test.js` | `Body Parser - Rejects payload exceeding 10kb with 413` |
| **F04** | Centralized Error Handler | `tier2-boundary.test.js` | `Error Sanitization - No stack traces or raw db errors leaked` |
| **F05** | WebSocket Payload Validation | `tier2-boundary.test.js` | `Destructuring Attack - Null subscribe payload`, `Destructuring Attack - Null playback payload`, `Zod schema validation` |
| **F06** | Secrets & Credential Sanitization | `tier2-boundary.test.js` | `Error Response Sanitization` |
| **F07** | REST Auth & IDOR Hardening | `tier1-feature.test.js`, `tier2-boundary.test.js` | `Auth Profile validation`, `Settings payload boundaries`, `Invalid email 400` |
| **F08** | WebSocket Reconnection Churn Fix | `tier3-interactions.test.js` | `Rapid Driver Switching Burst`, `Drop & Rapid Reconnect` |
| **F09** | Simulation NaN & Seek Bounds Guard | `tier2-boundary.test.js` | `Mathematical Poisoning - NaN progress`, `Negative progress`, `Progress > 1.0` |
| **F10** | Simulation Math & Division Guard | `tier4-scenarios.test.js` | `Overtake Prediction - No NaN/Infinity in closingRate and estLapsToPass` |
| **F11** | Redis Gateway Race Condition Fix | `tier1-feature.test.js`, `tier3-interactions.test.js` | `In-memory fallback broadcast`, `Concurrent multi-client reception` |
| **F12** | Frontend Error Boundary | Next.js Build | Verified in build and component test |
| **F13** | Sector-Dependent DRS Logic | `tier4-scenarios.test.js` | `DRS Rule 1 - Leader never has DRS`, `DRS Rule 2 - Interval <= 1.000s in zone` |
| **F14** | Cumulative Lap & Timing Intervals | `tier4-scenarios.test.js` | `Timing Intervals - Leader gap=0, followers gap>0`, `Lap continuity` |
| **F15** | Authentic RPM Shift Light Progression | `tier4-scenarios.test.js` | `Cockpit Physics - RPM range 0-15000, gear -1 to 8` |
| **F16** | Tailwind Layout & LED Fix | Frontend Build | Verified in frontend build compilation |
| **F17** | FIA Standard Tyre Compound Colors | `tier4-scenarios.test.js` | `Tyre Compounds - FIA standard compounds (SOFT/MEDIUM/HARD/INTER/WET)` |
| **F18** | Dynamic High-DPI Canvas Resizing | Frontend Build | Verified in frontend build compilation |
| **F19** | Overtake Battle Card HUD Overhaul | `tier4-scenarios.test.js` | `Active battles metrics - confidence, probability, delta` |
| **F20** | Opaque-Box E2E Test Suite | `tests/e2e/run-all.js` | Unified multi-tier runner across Tiers 1-4 |

---

## 6. Expected Output Derivation & Verification Oracles

All expected values in the test suite are derived from the following authoritative specifications:
1. **`ORIGINAL_REQUEST.md`**: OWASP Top 10 vulnerabilities, rate limits, WebSocket crash protection, FIA tyre conventions.
2. **`PROJECT.md` Interface Contracts**:
   - `client:v1:subscribe_driver` accepts `{ driverNumber: number (1-99) }`.
   - `client:v1:playback_control` accepts `{ action: 'play' | 'pause' | 'seek', speed?: 1 | 2 | 4, progress?: number [0.0 - 1.0] }`.
   - `f1:v1:grid_snapshot` provides `position`, `gapToLeader`, `intervalToAhead`, `drs`, `compound`.
3. **FIA Formula 1 Sporting Regulations (2024)**:
   - Article 22: DRS may only be activated when driver is within 1.000 second of car ahead at detection point.
   - P1 car cannot activate DRS as there is no car ahead.
   - Tyre compound designations: SOFT, MEDIUM, HARD, INTERMEDIATE, WET.
4. **OpenF1 Telemetry Protocol**:
   - Monza Circuit Key: `9590`.
   - Coordinates, RPM ranges, speed limits.
