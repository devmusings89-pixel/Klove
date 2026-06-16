# Klove

**The operating system for family health** — a health concierge / "Chief of Staff" that
coordinates the *administrative* burden of healthcare across a household (never diagnosis).
Klove surfaces one actionable next step at a time; ~70% is handled by AI agents, ~30% routes
to a human concierge.

> Built by evolving the Svasa booking app. The DocCaller-style AI booking engine (Vapi voice +
> web + email) now powers Klove's **concierge handoff**, underneath a family-health coordination layer.

## What it does (V1)

- **Household model** — every member is their own `User`; the **Operator** (primary caregiver)
  manages the others via scoped, revocable **consent grants**. Minors / aging parents are
  login-less "managed" members the operator controls.
- **Connected records** — Apple Health, the **HealthX** records connector (aggregator), Gmail,
  and uploads feed one normalized, per-member **timeline** (the Family Health Graph).
- **Today briefing** — insights become approvable **Tasks**, bucketed *Needs You · Waiting · Handled*.
- **Appointment-prep hero** — a one-page brief + personalized questions, then authorize Klove to
  **book/coordinate** on a member's behalf; capture the visit summary into follow-ups.
- **Ask Klove / Show me** — a persistent agent surface that answers grounded over the family graph
  or escalates to the concierge.

## Architecture

```
iOS (SwiftUI · Today/Family/Records/Actions + Ask Klove)
      │  HTTP (+ x-user-email mock identity, or Supabase JWT live)
      ▼
Node/TS backend (Fastify + Prisma)
  • household / members / consent (resolveSubject consent chokepoint)
  • per-member records · timeline · sources · uploads
  • insight engine → tasks → Today · reminders · notifications
  • appointment prep · concierge book handoff · visit summary
  • ask (triage) · show-me · audit log
      │
      ├─▶ Vapi (voice) · web (Playwright) · email — concierge booking channels
      ├─▶ HealthX/aggregator (Metriport) · Apple Health · Gmail — record sources
      ├─▶ Stripe (concierge billing) · Resend (email) · APNs (push) · Supabase (auth/storage)
      └─▶ Anthropic (insights · prep questions · ask triage)
```

Every external service is **optional**: with no API keys the backend runs in **mock mode** and
the whole product is demoable offline. `GET /health` reports which services are live vs mock.

## Backend (`/backend`)

Node 20+ / TypeScript / Fastify / Prisma (SQLite dev, Postgres prod).

```bash
cd backend
npm install
cp .env.example .env        # fill keys to go live; leave blank for mock mode
npx prisma db push          # creates SQLite dev.db
npm run backfill-households # one-time: give existing users a household + self-membership
npm run dev                 # http://localhost:8080
npm test                    # consent matrix, backfill, scheduler
```

### Key endpoints

```
GET  /household                         operator's household + roster (auto-created)
POST /members · /members/:id/invite     add managed members · invite a consenting adult
POST /invites/:token/accept             invitee links their login + chooses what to share
GET  /members/:id/timeline · /summary   per-member normalized record (consent-gated)
POST /members/:id/sources/:type/connect connect Apple Health / HealthX / etc.
GET  /today · /tasks                    chief-of-staff briefing · action log
GET  /members/:id/prep                  appointment brief + questions (hero)
POST /members/:id/book                  concierge booking handoff (reuses Session engine)
POST /ask · /members/:id/show-me        agent triage · focused on-demand view
```

## iOS (`/ios`)

SwiftUI, iOS 17+, Swift 6, `@Observable` MVVM. Requires **full Xcode**.

```bash
brew install xcodegen
cd ios && xcodegen generate
open Klove.xcodeproj          # run on an iOS 17+ simulator
```

Set the backend URL in `ios/Klove/Config.swift`. Tabs: **Today · Family · Records · Actions**,
with a persistent **Ask Klove** button. Warm, non-blue, high-contrast design (`DesignSystem/Theme.swift`).

## Going live (per-service cutover — flip each via env, no code changes)

- **HealthX / records connector** (`AGGREGATOR_*`, Metriport BAA): identity-verify URL + FHIR webhook.
- **Apple Health**: re-add HealthKit + clinical-records entitlement under the `app.klove.client` bundle id.
- **Stripe** (`STRIPE_*`): concierge-tier billing (`PaymentService` + `/webhooks/stripe`).
- **Vapi + Resend** (`VAPI_*`, `RESEND_API_KEY`): email-first → voice escalation via the channel registry.
- **APNs** (`APNS_*`): `POST /devices/token` registers; `sendApns` implements the live send.
- **Supabase Auth** (`SUPABASE_JWT_SECRET`): iOS swaps `x-user-email` → `Authorization: Bearer`.

### HIPAA posture

OAuth tokens and insurance IDs are **envelope-encrypted at rest** (`crypto.ts`). Consent is
**legible and revocable** — `resolveSubject` denies a member's data the instant a grant is revoked.
Every consent change and action-on-behalf is recorded in an immutable **audit log** (`AuditEvent`).
Production adds BAAs (Supabase/Metriport/Vapi/Resend) and per-member Postgres **RLS** as a backstop.
