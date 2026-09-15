# Contributing

Thanks for considering a contribution to APEX F1. This is a personal project, but PRs, issues, and forks are welcome.

## Getting set up

The fastest path is Docker (see [README.md](README.md#quick-start-docker--recommended)):

```bash
docker compose up --build
```

For active development, run backend and frontend dev servers directly instead — both auto-reload on change:

```bash
cd backend && npm install && npm run dev    # http://localhost:4000
cd frontend && npm install && npm run dev   # http://localhost:3000
```

Postgres/Redis are optional for local dev (see the [environment variables table](README.md#environment-variables)); without them, live viewing still works but replay/archival is disabled.

## Before opening a PR

1. **Type-check both sides:**
   ```bash
   cd backend && npx tsc --noEmit
   cd frontend && npx tsc --noEmit
   ```
2. **Run the test suite** from the repo root:
   ```bash
   npm test
   ```
   It auto-detects a running backend (from `docker compose up` or `npm run dev`) or spins up an in-process one itself.
3. **If you touched anything user-visible in the frontend**, actually run it in a browser and check the change — type checks and tests verify correctness, not that a UI change looks or works right.
4. Keep the diff scoped to what the PR describes. Unrelated cleanup, even obviously-correct cleanup, belongs in its own PR.

## Code conventions

- **TypeScript strict mode** on both sides — don't weaken `tsconfig.json`'s `strict` setting or add `any` to route around a type error; fix the type.
- **Comments explain *why*, not *what*.** A comment justified only by "this is what the code does" should be deleted — the code already says that. Reserve comments for a non-obvious constraint, a workaround for a specific upstream quirk (OpenF1's `"+1 LAP"` placeholder, Prisma's connection-pool ceiling, etc.), or an invariant a reader could otherwise break by "simplifying" the code.
- **Validate at the boundary.** REST/WebSocket payloads are validated with Zod at the point they enter the system (see `backend/src/app.ts`, `backend/src/websocket/socket.server.ts`); code past that point trusts its inputs rather than re-checking them.
- **Fail soft on optional infrastructure.** Postgres and Redis are both optional — `getPrismaClient()` returns `null` and the message bus falls back to an in-process `EventEmitter` rather than crashing the process. If you add a new dependency on either, follow the same pattern instead of making it load-bearing.
- **Per-viewer state stays per-viewer.** The replay system's independence between browser tabs (see `backend/src/services/replay-session.service.ts`'s module doc) depends on every piece of scrub-position-dependent state — interval history, smoothed probabilities, etc. — being owned by the caller (a socket's `ReplayState`) rather than a shared singleton. A new feature that needs its own cross-tick state should follow the same "caller owns the Map, service just reads/writes what it's handed" shape.
- **No unverified claims in comments or commit messages** — if a fix addresses a specific bug, describe the actual failure mode, not a guess at it.

## Commit messages

- Written in the imperative mood ("Fix X", not "Fixed X" or "Fixes X"), first line under ~70 characters, body explaining *why* the change was needed when that isn't obvious from the diff alone.
- No AI/assistant co-authorship attribution lines in commits or PR descriptions for this repo.

## Reporting bugs / requesting features

Open a GitHub issue. For a bug, include: what you expected, what happened instead, and — if it's data/prediction related — the session key and roughly where in the race it occurred, since OpenF1 data availability varies session to session.
