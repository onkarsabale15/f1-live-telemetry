# Comprehensive Architecture Plan: OpenF1 API Optimization & Client-Side Offloading

> **Status**: DRAFT / ON HOLD (No code modifications started)  
> **Document Location**: `d:/Education/F1/API_OPTIMIZATION_PLAN.md`  
> **Scope**: Rate-limit compliance (30 req/min), multi-purpose whole-grid batching, client-side offloading, and zero false data integrity.

---

## 1. Executive Summary & Problem Statement

### The Problem:
1. **OpenF1 Free Tier Rate Limits**:
   - $\le 3 \text{ requests / second}$ (burst limit).
   - $\le 30 \text{ requests / minute}$ ($= 0.5 \text{ requests / second}$ average sustained).
2. **Previous Inefficiencies**:
   - The backend was polling every 5 seconds, making 4 to 7 concurrent requests per poll cycle (\~48–65 requests/minute). This repeatedly breached the 30 req/min limit, resulting in `HTTP 429 Too Many Requests`.
   - When OpenF1 paywalled live data (`HTTP 401`), static fallback coordinates were seeded without motion, causing frozen or misleading states.
   - The backend was performing heavy statistical computations (e.g. 22-car pairwise overtake probabilities, linear regression for tyre degradation slopes, closing rate histories) on every tick, adding Node.js event-loop overhead and network payload bloat.

### The Objective:
- **Strictly satisfy the 30 req/min limit** with a 13% safety buffer (max 26 req/min).
- **Enforce the Zero False Data Rule**: Never display fake coordinates or fabricated battles. If live data is unavailable, state the reality transparently.
- **Offload non-essential calculations from the backend to the browser client**, drastically reducing backend CPU/memory pressure, Redis bandwidth, and WebSocket payload sizes.

---

## 2. Core Architecture: Multi-Purpose Whole-Grid Batching

A fundamental finding of the OpenF1 API is that **omitting `driver_number` causes endpoints to return the entire 22-car grid in a single HTTP response**.

We never need to query drivers individually. One single API call delivers the entire field:

```
                          ┌───────────────────────────────┐
                          │  1 Single OpenF1 API Request  │
                          │   (e.g., GET /car_data)       │
                          └───────────────┬───────────────┘
                                          │
                   ┌──────────────────────┼──────────────────────┐
                   ▼                      ▼                      ▼
           Cockpit Dials         3-Driver Comparison    Leaderboard Speeds
           (Focused Car)         (3 Selected Cars)      (All 22 Drivers)
```

### Multi-Purpose Endpoint Map:
1. **`GET /car_data` (1 call)**:
   - Powers Cockpit Speedometer, 15-LED RPM Tachometer, Gear Indicator, Throttle/Brake Pedal Meters.
   - Powers Live 3-Driver Comparison Panel (Speed, Throttle, Brake, Gear, RPM).
   - Powers Leaderboard speed column for all 22 cars.
   - Powers Overtake Radar speed delta calculation (`chaserSpeed - defenderSpeed`) and DRS status.
2. **`GET /intervals` (1 call)**:
   - Powers Leaderboard intervals ("Interval to Car Ahead" and "Gap to Leader").
   - Powers Overtake Radar duel detection ($\le 2.0\text{s}$ attack window, $\le 1.0\text{s}$ DRS zone).
   - Powers Live 3-Driver Comparison Panel delta gaps.
3. **`GET /location` (1 call)**:
   - Powers 2D Circuit Map coordinates for all 22 cars.
   - Powers initial circuit boundary calculation and track reference spline.
4. **`GET /laps` (1 call)**:
   - Powers the Global Race Lap Counter (`max(lap_number)`).
   - Powers completed session scrubber timeline bounds (`date_start + lap_duration`).
   - Powers Comparison lap pace charts and sector analysis.
5. **`GET /stints` (1 call)**:
   - Powers tyre compound badges (Soft, Medium, Hard, Wet, Inter) and tyre age.
   - Powers stint degradation analysis.

---

## 3. Client-Side Offloading (Reducing Backend Pressure)

To keep the backend lightweight and responsive, we partition the workload: **the backend acts as a pure telemetry pipeline**, while **the browser client executes statistical formulas and visual transformations**.

```
┌────────────────────────────────────────────────────────┐
│                   BACKEND ROLE                         │
│ • Fetch OpenF1 batch endpoints under 30 req/min budget │
│ • Store in-memory maps of the 22 drivers               │
│ • Broadcast raw synchronized telemetry via WebSocket   │
└───────────────────────────┬────────────────────────────┘
                            │ Raw DriverLiveState[]
                            ▼
┌────────────────────────────────────────────────────────┐
│               BROWSER (CLIENT) ROLE                    │
│ • 60 FPS LERP Car Interpolation along Track Canvas     │
│ • Overtake Duel Detection & Probability Formula        │
│ • Tyre Degradation Linear Regression & Pit Prediction  │
│ • Multi-Driver Comparison Deltas & Filtering           │
│ • 15-LED Shift Light Activation Logic                  │
└────────────────────────────────────────────────────────┘
```

### Calculations Offloaded to the Browser:

| Calculation | Previous Location | Proposed Location | Why Move to Browser? |
|---|---|---|---|
| **Overtake Battles & Probabilities** | Backend (`prediction.service.ts`) | **Browser (`useOvertakeRadar.ts`)** | The browser receives `grid` with all 22 car intervals and speeds. Running the sigmoid formula and closing-rate window for 3–5 duels in the browser takes < 0.1ms, eliminating 30-second interval history buffers on the server. |
| **Tyre Degradation Slope (Least Squares)** | Backend (`comparison.controller.ts`) | **Browser (`LiveComparisonPanel.tsx`)** | Fitting linear regression $y = mx + b$ over 10–20 lap times is trivial for JavaScript in the browser. Moving it to the client avoids backend controller recalculations on every driver selection change. |
| **Predicted Next Pit Stop Window** | Backend (`comparison.controller.ts`) | **Browser (`LiveComparisonPanel.tsx`)** | Derived directly from tyre age, compound baseline, and degradation slope. The browser can compute this instantly when the user toggles drivers. |
| **Head-to-Head Pace Deltas** | Backend (`comparison.controller.ts`) | **Browser (`LiveComparisonPanel.tsx`)** | Calculating `driver1.bestLap - driver2.bestLap` is instantaneous in the browser. |
| **Circuit Coordinate LERP (60 FPS)** | Browser (`CircuitCanvas.tsx`) | **Browser (`CircuitCanvas.tsx`)** | *Already in browser.* Smooths 7-second OpenF1 pulses into fluid 60 FPS motion without burdening the network. |

---

## 4. Prioritized Polling Cadence & Mathematical Budget

We divide our OpenF1 calls into **3 prioritized frequency tiers**. This guarantees that high-volatility metrics (speed, position) refresh regularly while low-volatility data (tyre stints, session calendar) does not waste API calls.

```
TIER 1: High Urgency (Every 7.5 seconds - 8 cycles / minute)
  ├── 1. GET /location   (All 22 car coordinates)
  └── 2. GET /car_data   (All 22 car speeds, RPM, gear, throttle, brake, DRS)
  Rate: 8 cycles × 2 calls = 16 calls / minute

TIER 2: Moderate Urgency (Every 15 seconds - 4 cycles / minute)
  ├── 3. GET /position   (All 22 classification ranks)
  └── 4. GET /intervals  (All 22 interval & leader gaps)
  Rate: 4 cycles × 2 calls = 8 calls / minute

TIER 3: Strategy & Stints (Every 60 seconds - 1 cycle / minute)
  ├── 5. GET /laps       (All 22 lap timing arrays)
  └── 6. GET /stints     (All 22 tyre compounds & stint ages)
  Rate: 1 cycle × 2 calls = 2 calls / minute

===================================================================
TOTAL SUSTAINED API RATE: 16 + 8 + 2 = 26 requests / minute
RATE LIMIT ALLOWANCE: 30 requests / minute
SAFETY MARGIN: 4 requests / minute (13.3% unused buffer)
BURST PER SECOND: Max 2 calls staggered by >= 500ms (Limit is 3 req/s)
===================================================================
```

### Detailed Timeline Schedule (Over 60 Seconds):

- **00.0s**: `/location`, `/car_data` (Calls 1, 2)
- **07.5s**: `/location`, `/car_data`, `/position` (Calls 3, 4, 5)
- **15.0s**: `/location`, `/car_data`, `/intervals` (Calls 6, 7, 8)
- **22.5s**: `/location`, `/car_data`, `/position` (Calls 9, 10, 11)
- **30.0s**: `/location`, `/car_data`, `/intervals` (Calls 12, 13, 14)
- **37.5s**: `/location`, `/car_data`, `/position` (Calls 15, 16, 17)
- **45.0s**: `/location`, `/car_data`, `/intervals` (Calls 18, 19, 20)
- **52.5s**: `/location`, `/car_data` (Calls 21, 22)
- **60.0s**: `/location`, `/car_data`, `/laps`, `/stints` (Calls 23, 24, 25, 26)

---

## 5. Zero False Data Integrity Policy

To maintain 100% data authenticity:
1. **No Artificial Coordinates**: If OpenF1's free tier locks down during an active race (`HTTP 401`), the engine will **never generate fake car movements or simulated laps**.
2. **Transparent UI Status**:
   - If real-time data is flowing: 🟢 **`OPENF1 REAL-TIME FEED`**
   - If user is reviewing past race: 🔵 **`SESSION REPLAY`**
   - If OpenF1 live session is paywalled: 🟡 **`AWAITING LIVE FEED — OpenF1 free tier is restricted during live sessions. Replays of completed sessions remain available in Match Explorer.`**
3. **Graceful Degradation**: If an individual endpoint fails or returns 404 (e.g. `/intervals` during Qualifying), the UI displays `"No gap data for this session format"` instead of fabricating zero-second intervals.

---

## 6. Implementation Roadmap (When Ready to Proceed)

1. **Step 1: Backend Polling Loop Refactoring (`simulation.service.ts`)**:
   - Replace monolithic `pollAndBroadcast` with the 3-tiered scheduler (7.5s, 15s, 60s).
   - Add a 500ms delay between staggered batch requests.
2. **Step 2: Client-Side Formula Migration (`frontend/src/domain/formulas.ts`)**:
   - Export mathematical formulas (`calculateOvertakeProbability`, `calculateClosingRate`, `computeSlope`) to a shared frontend utility.
   - Run overtake duels and tyre degradation directly inside `OvertakeRadar.tsx` and `LiveComparisonPanel.tsx`.
3. **Step 3: UI Status Communication (`PlaybackBar.tsx`)**:
   - Wire the live data source state to render the authentic status badge.
4. **Step 4: End-to-End Verification**:
   - Verify rate limiter logs confirm $\le 26 \text{ req/min}$.
   - Verify zero 429 and zero 401 errors.
   - Run `npm run build` on both frontend and backend.
