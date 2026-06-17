# Klove — Persona-Driven E2E Test Plan (UX → Backend)

> Grounded in the V1 architecture spec (`Lō x Klove V1`: wedge, 4 design pillars, 6 core journeys
> J1–J6, the 9-state workflow, Screen Inventory Batch 1/2) **and** the running system (iOS app +
> Fastify backend on `:8080`, Postgres/Prisma). Each case drives the **real app** (idb taps/text +
> screenshots) and asserts at **both** the UI layer and the backend layer.

## The persona we test as

**Maya, 47** — the "neglected middle" operator the spec is built for. She runs a **9-person care
circle**:
- **Herself** (migraines, prediabetes — A1c watch)
- **Raj**, husband (consenting adult, own employer insurance)
- **4 kids**: Aanya (14), Vivaan (11), Diya (8), Arjun (5) — all on the **family plan**
- **2 aging parents**: Dad/Robert (Medicare + supplement, 3 providers, another city) and Mom/Sushila
  (Medicare Advantage)

Maya is exactly the spec's "woman in her 40s–50s, family with chronic conditions." Every test below
is judged by **"does this actually work for Maya?"** — not just "does the screen render."

### The details that make-or-break it for Maya (explicit product requirements)

These came from real caregiver friction and are first-class **must-pass** requirements:

- **R1 — Insurance is a wallet, not a field.** Maya holds *many* cards: family plan, Raj's plan,
  Dad's Medicare + supplement, Mom's Medicare Advantage. The operator must manage a **collection**
  of insurance cards. *(Current impl: single plan, operator-only — FAILS.)*
- **R2 — Insurance is per-member.** Maya must add/edit a card **for any member** (Dad's Medicare,
  not her BCBS). *(Current impl: only the operator's own — FAILS.)*
- **R3 — Booking is by name, not "Me".** When she books Dad's cardiology visit, the form must say
  **"Booking for Robert (Dad)"**, never an abstract "Me" entity. *(Current impl: member picker shows
  "Me"/displayName as an entity — WEAK.)*
- **R4 — Booking links a specific card.** She must **choose which insurance card** the office gets
  (Dad → Medicare). *(Current impl: auto-uses `insurance[0]`, no choice — FAILS.)*

## Harness & environment

- **Driver:** `idb` (`idb_companion` + `fb-idb`): `idb ui describe-all|tap|text|swipe`,
  `xcrun simctl io booted screenshot`. Tab can be forced via
  `defaults write app.klove.client initialTab …` + relaunch. Helper: `/tmp/klove_tap.py`.
- **Backend:** `:8080`; `GET /health` exposes live/mock modes. Auth = `x-user-email` header
  (sim user `devmusings89@icloud.com`).
- **Mode (current box):** healthExtraction **live** (OpenRouter, funded — PDF works), vapi live,
  storage live, stripe mock, gmail/aggregator mock.
- **Assertions:** UI (screenshot + a11y label) **and** backend (REST read or Prisma script run from
  inside `backend/`). Every visual case runs **light + dark**.

## Conventions
`E2E-<area>-<n>` · Priority P0/P1/P2 · each lists **Pre / UI steps / Assert(UI) / Assert(backend) / Deps**.

---

## Iteration 1 — MUST PASS (the named details + the journeys that prove them)

> These are the cases this iteration drives to green. They encode R1–R4 and the persona-critical
> happy paths of J1, J2, J4, J5.

### INS — Insurance wallet (R1, R2)
- **E2E-INS-1 (P0) Operator adds multiple cards.** Settings → My Info → Insurance → add "Family Plan
  (BCBS)" → **Add another card** → "Raj — Aetna PPO". Assert UI: both cards listed. Assert backend:
  `GET /profile` (or wallet endpoint) returns **≥2** `InsurancePlan` rows for the operator's profile.
- **E2E-INS-2 (P0) Add insurance for a member.** Family → Dad → Insurance → add "Medicare Part B" +
  "AARP Supplement". Assert UI: Dad shows 2 cards. Assert backend: Dad's profile has 2 plans;
  operator's wallet unchanged.
- **E2E-INS-3 (P1) Edit / delete a card.** Remove a card → gone from list + DB.
- **E2E-INS-4 (P1) Scan card still works** and lands in the *new* multi-card model (adds, not
  overwrites).

### BOOK — Named booking + linked insurance (R3, R4)
- **E2E-BOOK-1 (P0) Book by name.** Family → Dad → Book a visit. Assert UI: header reads
  **"Booking for Robert"** (real name), not "Me". Assert backend: session/booking `patientInfo.name`
  == "Robert".
- **E2E-BOOK-2 (P0) Link insurance at booking.** In Dad's booking, an **insurance picker** lists
  Dad's cards (Medicare, Supplement); select Medicare → book. Assert UI: chosen card shown on the
  confirm. Assert backend: the booking carries the **selected** plan's carrier/memberId (Medicare),
  not the operator's `[0]`.
- **E2E-BOOK-3 (P1) Default + override.** Picker defaults to the member's primary card; operator can
  override. Booking for a kid defaults to Family Plan.
- **E2E-BOOK-4 (P1) Provisional → propagates.** Booked visit appears in Today/Actions/member timeline
  with the right name + amber "Hold" (light+dark). *(Verified pre-fix: propagation works.)*

### J2 — Connect data + assign to the right person (incl. real PDF)
- **E2E-DOC-1 (P0) Upload PDF → extract → records.** Upload the Quest lab PDF; poll
  `GET /health-records/documents/:id` to `extracted`. Assert backend: **≥70 observations + reports**
  created. Assert UI: Records timeline shows the new lab entries; out-of-range values (Ferritin low,
  Lipoprotein(a) high, ApoB high, Vit D low) carry abnormal flags.
  *(Verified 2026-06-17 at API layer: 73 observations, 17 reports extracted.)*
- **E2E-DOC-2 (P0) Assign to member.** Upload must let Maya say **whose record this is** (per spec
  "Assign to member"). Assert backend: observations attach to the chosen member, not always the
  operator. *(Current impl gap: reachable upload is camera-only/image, operator-scoped — FIX.)*
- **E2E-DOC-3 (P1) Non-health doc** → `skipped_non_health` + "No health data found".

### J1 — Onboard the household (operator-first)
- **E2E-ONB-1 (P0) First run → value-first home.** Fresh install → name self as operator → set own
  profile/DOB → skip family → land on Today **with a seeded first action** (per spec "seeds the queue
  with one easy first action"). Assert backend: user+household+operator profile exist.
- **E2E-ONB-2 (P1) Onboard-herself-first guard** — flow never leads with "add your family".

### J5 — Managing an aging parent (the Tier-2 / hardest case)
- **E2E-FAM-1 (P0) Add aging parent as delegated member** (Dad) → appears in Family + Today
  "watching". Assert backend: `User{managed:true, managedBy:operator}` + consent grant.
- **E2E-FAM-2 (P1) Per-member context** — Dad's profile shows his timeline/meds/insurance distinct
  from Maya's.

### Cross-cutting
- **E2E-X-1 (P0) Dark-mode parity** on every screen touched above (no half-light/half-dark).
- **E2E-X-2 (P1) Three statuses** (Handled/Needs-you/Waiting) render correctly per spec.

---

## Iteration 2+ — documented backlog (run once Iteration 1 is green)

- **J3 proactive reminder** (detect A1c overdue + low refill → nudge → act in one tap → close loop):
  REM-1..4. Needs an insight/gap detector + reminder ticks.
- **J4 hero appointment prep** (assemble brief → questions → authorize → arrive prepared → capture
  summary → follow-ups): PREP-1..5 + visit summary. `AppointmentBriefView` exists.
- **J6 show-me** (grounded, cited, ephemeral trend/summary/report): SHOW-1..3.
- **Tasks** quick-done / delegate-to-concierge: TASK-1..4.
- **Appointment detail** reschedule/cancel/log-summary: APPT-1..3 *(verified manually)*.
- **Consent** grant/revoke/category-gating; **invite-by-link** deep-link accept: CONS-1..3.
- **Medications** schedule + dose tracking + adherence + missed-dose surfacing + haptics: MED-1..4.
- **Settings**: notifications/reminder cadence (debounced, optimistic-revert), sign-out: SET-1..2.
- **Sources**: connect Apple Health/Gmail/aggregator (mock) → timeline populates: SRC-1..2.

---

## Spec-vs-implementation gaps feeding the fix list

1. **Insurance: single plan, operator-only** → build a wallet (collection) + per-member management
   (R1, R2). Model already has `Profile.insurance InsurancePlan[]`; API uses only `[0]`.
2. **Booking: no patient-name emphasis, no card selection** → named booking + insurance picker
   (R3, R4); backend accepts `insurancePlanId`.
3. **Upload: reachable UI is camera-only/image, operator-scoped; `UploadView` (PDF/Photos/file) is
   dead code; no "Assign to member"** → wire `UploadView` in (or add PDF + member-assign to
   `MemberConnectView`) per Batch-2 "Upload document" + "Assign to member".
4. **`BookingAssistantView` (conversational) unreachable** — reconcile with spec (Ask/conversational
   is marked *Future* in the inventory, so dead-code is acceptable for V1; consider deleting).

## Automation approach
Wrap idb primitives as `tap/type/expect/screenshot/assertBackend`; seed/reset per-user fixtures for
determinism; tag tests by mode dependency. P0 smoke order: ONB-1 → INS-1 → INS-2 → BOOK-1 → BOOK-2 →
DOC-1, each light+dark.

---

## Iteration results (live verification log)

- **2026-06-17 · Insurance wallet + named booking (R1–R4):** PASS. Backend (curl): operator
  multi-card wallet; per-member wallet independent of operator; booking echoes real `patientName`;
  insurance selection by `insurancePlanId` (default→member primary, explicit override, no operator
  leak). Live app (idb): Dad's wallet lists cards (Medicare · Part B "Primary"); booking shows
  "Patient: Dad Robert" + insurance picker; confirmation reads **"For Dad Robert · Insurance:
  Medicare Part B"**.
- **2026-06-17 · J2 PDF extraction:** PASS at API layer — Quest lab PDF → 73 observations + 17
  reports (OpenRouter funded).
- **2026-06-17 · J2 "assign to member" (E2E-DOC-2):** FIXED — `MemberConnectView` now offers
  "Upload a PDF or photo" (`.fileImporter` → `uploadForMember`), so a lab PDF attaches to the chosen
  member (not just the operator) and powers that member's timeline + brief.
- **2026-06-17 · J4 appointment-prep HERO flow:** PASS (live). Brief engine is grounded — for a
  member with records it generates real counts + cited questions ("My records show 75 observations…
  can you walk me through"). Live app for Dad Robert: "Dad Robert's next visit" → Snapshot (0
  results · 1 visit) → **Recent: Cardiology follow-up** (pulled from the real booking) → editable
  drafted **Questions to ask** → **"Have Klove book & coordinate"** + authorization. Backend
  `/prep` (brief + questions), `saveQuestions`, `authorize-booking`, `book`, and
  visit-summary→follow-ups all present.

- **2026-06-17 · J3 proactive health reminder:** PASS. Detection engine (`analysis.ts` +
  `guidelines.ts`) already flags abnormal labs + due/overdue screenings & monitoring (A1c, lipid,
  mammogram, etc.) and promotes watch/urgent insights into Today as "needs_you" tasks — verified
  grounded in the real Quest labs (10 alerts: Lp(a), Vitamin D, ApoB, A1c, Glucose…; tasks "Glucose
  out of range", "A1c out of range" in Today). Added the spec's missing third decision — **Snooze**:
  `POST /tasks/:id/snooze` (state→snoozed, dueAt=+N days) + a resurface tick (snoozed→needs_you when
  due) + a Snooze menu (3d/1wk/2wk) in `TaskDetailView`. Verified: snoozing a task removes it from
  Today's needs-you and schedules its return.

- **2026-06-17 · J6 show-me on demand:** PASS. `/show-me` returned a filtered timeline + grounded
  trend series; ADDED the spec's headline output — a **plain-language, grounded, cited summary**
  (`runText`, records-only, no invention/advice). Verified: "Show me my A1c" →
  *"Your latest Hemoglobin A1c was 6.4% on 2026-06-17, flagged abnormal — up from 5.6% on 2026-03-27,
  an upward trend."* + 2-point chart. `ShowMeView` now renders the summary card above the chart.
  Known limitation: the keyword filter misses medical synonyms (apob↔apolipoprotein) — future.
- **2026-06-17 · J5 managing an aging parent:** COVERED by composition (verified). Its pieces all
  exist and were exercised: delegated member add (Dad Robert, consent active), per-member sources +
  PDF/photo upload (assign-to-member), per-member **timeline that merges multiple sources into one
  coherent view** (verified: A1c appears from both `gmail` and `upload` in one timeline), concierge
  booking/coordination, and Today surfacing per-member tasks. Not-yet-built J5 refinements: Tier-2
  bulk historical import, and cross-source medication reconciliation (dedup the same drug across
  providers).

- **2026-06-17 · Refinements:** (1) **J6 synonym-aware retrieval** — show-me now expands query terms
  (stop-word removal + medical synonyms: cholesterol→LDL/HDL/ApoB, a1c→hemoglobin a1c, vitamin→25-OH,
  etc.), so "show me my cholesterol and ApoB" / "vitamin D" now match the right analytes and produce
  grounded summaries (verified). (2) **Secondary insurance (primary + backup)** — added
  `InsurancePlan.isSecondary` (schema pushed, client regenerated); `addInsurance`/`updateInsurance`
  manage the single primary + single backup slot; `buildPatientInfo` orders primary→secondary; the
  booking picker labels cards "(primary)/(backup)". Verified: a 2nd card flagged secondary →
  `primary=false secondary=true` while the first stays primary. (3) Wallet **edit/delete a card**
  (`EditInsuranceView`) + member **PDF/photo upload**. (4) Fixed a latent `e.date` null-safety TS
  error. Backend `tsc` clean; iOS build green.
- **2026-06-17 · Consent/invite deep-link accept (CONS):** PASS (already implemented; verified
  end-to-end, no code changes needed). (A) **Live deep link** — `simctl openurl klove://invite/<token>`
  opens `AcceptInviteView` ("Join on Klove" → "What to share" Everything toggle + "Let them"
  View/Manage/Operate). URL scheme registered in Info.plist; `InviteCoordinator.handle` parses
  scheme/host/token. (B) **Backend round-trip** — operator invites Cat (token bound to invitee email)
  → invitee accepts → `{ok, accessLevel:manage, categories:[all]}`; Cat's consent flips to **active,
  managed=false** with membership repointed to the real user. (C) **Identity-binding security** —
  accept with a mismatched email → **403**; correct email → **200**. (Note: this exercised the
  curl-side household — Cat/Nonn are now owned by test invitees; harmless test data.)
- **2026-06-17 · Test-data cleanup:** removed curl-added test members + throwaway insurance cards;
  un-snoozed the glucose task; reduced duplicate cards on the demo "Dad Robert".

### Still open (next iterations / refinements)
Consent/invite deep-link accept; medications dose-tracking UI depth; J5 med reconciliation + Tier-2
bulk import; J6 synonym-aware retrieval; a calm push on new proactive tasks (J3 step 2 "right
channel"); fully-automated DOC-2 UI run (PDF into the simulator file picker).
