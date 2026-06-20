# Klove E2E QA harness

An agent that drives the iOS app on the simulator through real user journeys and reviews each through
three lenses — **functional/data-consistency**, a **senior designer's eye**, and **"Klove does the work,
not the customer."**

- [`test-cases.md`](./test-cases.md) — the scenario catalog (IDs A1…I5).
- [`rubric.md`](./rubric.md) — the three lenses, severity, and report format.
- [`klove-qa.agent.md`](./klove-qa.agent.md) — **tracked source of truth** for the agent that drives +
  evaluates. The repo ignores `.claude/`, so activate it by copying to the runtime path Claude Code reads:
  `cp qa/klove-qa.agent.md .claude/agents/klove-qa.md` (keep the two in sync if you edit either).
- `reports/` — per-scenario output (gitignored).

## Prerequisite

**XcodeBuildMCP must be attached to the session** (the project's standard Xcode tool — see the root
`CLAUDE.md`). It's what lets the agent `describe_ui` / `tap` / `type_text` / `screenshot` the simulator.
Without it the agent can't drive the app. (`idb` is an alternative but isn't installed here.)

## One-time / per-run setup

1. **Backend in mock mode on :8080**
   ```bash
   cd backend
   npm run dev            # Fastify on http://localhost:8080, all subsystems mock
   ```

2. **Seed the deterministic household** (idempotent — safe to rerun to reset state)
   ```bash
   cd backend
   npm run seed:e2e       # → "The Carter Family", operator operator@klove.e2e
   ```

3. **Build, install, and launch the app on a booted simulator**, pointed at the local backend.
   Build uses the verified Xcode flow (full Xcode at `/Applications/Xcode.app`; project & scheme `Klove`):
   ```bash
   cd ios && xcodegen generate
   DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild \
     -project Klove.xcodeproj -scheme Klove \
     -destination 'platform=iOS Simulator,name=iPhone 17' \
     -derivedDataPath build build
   ```
   Then install/launch with the right env per scenario (via XcodeBuildMCP `launch_app_sim`, or `simctl`):

   - **Authenticated scenarios** (B–I) — boot straight in as the seeded operator:
     ```
     API_BASE_URL=http://localhost:8080
     KLOVE_TEST_EMAIL=operator@klove.e2e
     ```
   - **Onboarding scenarios** (A) — wipe app data and launch FRESH with only:
     ```
     API_BASE_URL=http://localhost:8080
     ```

   `API_BASE_URL` is read from Info.plist (`Config.swift`); set it via an `.xcconfig`/Info.plist override
   or the build setting. `KLOVE_TEST_EMAIL` / `KLOVE_TEST_BEARER` are read from the **process environment**
   at launch (DEBUG only — `AuthService.swift`), so pass them as launch env.

### Auth note (mock vs Supabase)

In mock mode the app authenticates via the dev `x-user-email` header, and `KLOVE_TEST_EMAIL` sets that
identity + marks onboarding complete so authenticated scenarios skip the login UI. The **account-creation
scenarios (group A)** drive the real onboarding UI; the email/password identify step talks to Supabase
directly, so if Supabase isn't configured it won't complete a real signup. Run group A against a **dev
Supabase project** (set `SUPABASE_URL`/`SUPABASE_ANON_KEY`), or treat A1's identify step as a visual/flow
review only. Everything else runs on pure mock.

## Running the agent

Invoke the `klove-qa` subagent once per scenario (or per group), passing the scenario ID(s). It reads the
catalog + rubric, drives the flow, screenshots each state, and writes `reports/<id>.md`. Example asks:

- "Run klove-qa on **D1–D6** (booking)."
- "Run klove-qa on the **onboarding group (A)**."

The orchestrator (main session) can fan these out and then collate a summary across reports.

**Reset between runs:** rerun `npm run seed:e2e` and relaunch (wipe app data for onboarding runs).

## Suggested first pass

`A → B2/B4 → C1 → D1–D6 → E2–E4 → F1/F5 → G1/G3` — covers the full
create-account → add-family → insurance → book → ask → verify arc and every regression guard from the
recent provider-selection + agent fixes.
