# Klove Production — Milestone 1: Reliable Web Bookings

**Context.** Klove is becoming a real (startup) product, pursuing HIPAA compliance, for booking
medical appointments across channels. We proved the web channel can drive a real, complex
scheduler (Avondale → patientsreach) end-to-end to the verification gate. This milestone makes
the **web channel production-grade and reliable**, with the patient-in-the-loop verification flow
that real schedulers require. Compliance-sensitive choices are baked in now (audit, consent,
BAA-able LLM) to avoid expensive retrofits.

**Goal of M1:** the `web` channel reliably books real appointments on the common scheduling
platforms — autonomous where possible, patient-in-the-loop for verification — with audit + safety
suitable for a HIPAA-bound product.

---

## Why web-first is high-leverage
Most practices don't run bespoke sites — they use a handful of white-label schedulers
(Practice-by-Numbers/patientsreach, NexHealth, Zocdoc, Solv, LocalMed). An **adapter per platform**
covers thousands of offices reliably, far better than a generic LLM guessing each site.

---

## Workstreams

### W1 — Deterministic scanning *in the channel* (not scripts)
Fold the proven logic from `scripts/` (`scan-saturdays.ts`, `find-saturday.ts`, `book-avondale.ts`)
into `channels/web.ts`:
- Hybrid engine: **deterministic** funnel navigation + availability enumeration (geometric
  day/slot mapping, calendar pagination, multi-visit-type/provider) with the **LLM** for
  unfamiliar layouts/decisions.
- Gather mode returns ordered `offeredSlots` + `acceptableSlots`; book mode targets an exact slot.
- Keep the resilient `WebSession` (popup adoption, crash relaunch, real UA, real-keystroke fills).

### W2 — Scheduler-platform adapters
`channels/web/adapters/{patientsreach,nexhealth,zocdoc,solv,generic}.ts`. Detect by host/URL.
Each encodes the funnel (patient type → visit type → provider → calendar → slot → form → verify →
confirm) + selectors + masks. **patientsreach first** (already mapped). Generic LLM adapter as
fallback for unknown platforms.

### W3 — Patient-in-the-loop verification (`awaiting_verification`)
Real schedulers send an OTP to the patient. New session/target state mirroring
`awaiting_choice`/`awaiting_info`:
- Agent reaches the OTP step → triggers the code (patient-chosen channel) → session →
  `awaiting_verification` → push/SMS/email + in-app "enter your code".
- Patient submits code (`POST /sessions/:id/verify`) → agent **resumes the live session** → enters
  code → final confirm → `booked`.
- Requires a **durable/holdable browser session** across the wait (see W4).
- Also handle other mid-flow asks (insurance unchanged?, someone-else) via the same pause/resume.

### W4 — Browser fleet + session persistence
- Managed, scalable, **BAA-able** headful browsers: evaluate **Browserbase** (confirm BAA) vs
  self-hosted Playwright workers on a container pool.
- **Hold/resume sessions** for the verification wait (keep the page alive minutes between
  trigger-code and enter-code), with timeouts.
- CAPTCHA/anti-bot detection → graceful **fallback to the voice channel**.

### W5 — Safety, consent & audit (HIPAA-aware)
- Per-booking **audit log**: every navigate/click/field + screenshots, retained + encrypted.
- **Consent gate** before any real submit; **never** auto-enter payment card / SSN / full member #
  (route to patient).
- **Idempotency** (no double-booking), rate limiting, per-platform ToS allowlist, dry-run/preview.

### W6 — BAA-covered LLM
OpenRouter→Claude is great for dev, but for PHI we need a BAA. Plan: move the web brain to a
**BAA-covered path** (Anthropic API under BAA, or Claude on Bedrock under AWS BAA) while keeping
the pluggable provider layer. OpenRouter/local stays for non-PHI dev/testing.

### W7 — Reliability harness + metrics
Fixture/sandbox tests per platform, per-platform **booking-success metrics**, canary monitors,
alerting on regressions.

---

## Sequencing
- **M1a (prove the pattern):** W1 (scanner→channel) + W2 patientsreach adapter + W3
  verification-in-the-loop → first fully real, repeatable booking on patientsreach (Avondale).
- **M1b (run it for real):** W4 managed browser + session hold/resume + W5 audit/consent + the
  minimal infra to host a holdable worker (Postgres + a queue/worker, real domain/HTTPS).
- **M1c (breadth + trust):** W2 NexHealth/Zocdoc/Solv adapters + W6 BAA LLM + W7 harness/metrics.

## Minimal infra this milestone depends on (pulled from the broader platform roadmap)
Postgres, a persistent worker process (holds browser sessions), real domain + HTTPS for
push/webhooks, secrets management. (Full accounts/multi-tenant/billing are later milestones.)

## Out of scope for M1 (later milestones)
Multi-tenant accounts, App Store release, Stripe live billing, full HIPAA program (policies,
pen-test, BAA paperwork beyond LLM), messaging/fax/FHIR/Zocdoc-API channels.

## Verification of M1
Repeatable **real** booking on patientsreach (a willing test practice or a sandbox), incl. the
OTP-in-the-loop, with a complete audit trail; success-rate metric ≥ target on the covered
platforms; clean fallback to voice on CAPTCHA/unsupported.
