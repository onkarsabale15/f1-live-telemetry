# F1 Telemetry & OpenF1 Architecture Guidelines

## 1. OpenF1 API Constraints & Guardrails
- **Session-Dependent Endpoints**:
  - /intervals is ONLY available for Race and Sprint sessions. It returns HTTP 404 for Practice and Qualifying.
  - Always guard gap-dependent features (e.g. hasGapData) to prevent displaying misleading 0.00s intervals or fake overtake battles during non-race sessions.
- **Parc Fermé Telemetry Bounding**:
  - Cars idle after the checkered flag. Queries for latest telemetry in completed sessions must be bounded near race end (date_start + lap_duration), or they will display stationary/idle engine telemetry.
- **Rate Limiting (HTTP 429)**:
  - OpenF1 rate limits aggressive bursts. Stagger initial data fetches with delays (>= 500ms) and implement exponential backoff on 429 responses.
- **Dynamic Track Geometry**:
  - Do not hardcode circuit coordinate splines. Derive track geometry dynamically by subsampling a representative lap from /location coordinates.

## 2. Grid & Season Regulations
- **Dynamic Roster Sizing**:
  - Never hardcode the grid size to 20 cars. The 2026 season features 22 cars across 11 teams (including Cadillac and Audi).
  - Driver lists, team colors, and acronyms must be dynamically fetched from OpenF1 /drivers?session_key=..., falling back to FALLBACK_DRIVERS_2026 only on API failure.

## 3. Session Navigation & State Pinning
- **Session Pinning (isPinned)**:
  - When the user explicitly selects a historical race via Match Explorer or REST, pin the session.
  - Background auto-detection (which periodically checks for live or newer races) must NOT overwrite a pinned user-selected session until the user navigates away or unpins.
- **Session State Cleansing**:
  - When switching sessions, immediately purge all in-memory driver coordinates, telemetry, lap caches, and overtake predictions to prevent visual artifacts from the previous race leaking into the new one.
