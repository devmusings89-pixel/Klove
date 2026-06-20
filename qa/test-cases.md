# Klove E2E test-case catalog

Scenarios the QA agent drives on the live simulator, grouped by job-to-be-done. Each is evaluated with
all three lenses in [`rubric.md`](./rubric.md). The agent writes one report per scenario to `qa/reports/`.

**Seed:** run `npm run seed:e2e` first — household **"The Carter Family"**, operator
`operator@klove.e2e` (Alyssa, Aetna PPO, A1c trend + diabetes), members **Theo** (minor),
**Margaret** (aging parent, Medicare + Medigap), **Jordan** (consenting adult, *pending*), saved
providers, upcoming + past appointments, an in-flight booking, and needs_you/waiting/handled tasks.

**Launch env (see `qa/README.md`):**
- `AUTHED` = `API_BASE_URL=http://localhost:8080 KLOVE_TEST_EMAIL=operator@klove.e2e` → boots into MainTab as Alyssa.
- `FRESH` = `API_BASE_URL=http://localhost:8080` (no test email) + wiped app data → first-run / onboarding.

Severity legend and finding format are in the rubric. IDs are stable so reports can reference them.

---

## A. Account & onboarding  (launch: FRESH)

- **A1 First run → identify.** Welcome carousel → "Sign In" → identify step. Verify the sign-in options
  (Apple / Google / email) render and the brand intro reads well. *Does-the-work:* is the path to "in the
  app" short, or does it interrogate the user up front? (Note: pure mock mode may not complete real
  Supabase signup — see README; run identify against a dev Supabase project if needed.)
- **A2 About you.** Enter full name + DOB. Verify the name later appears in the roster/header (Lens A
  cross-screen). *Does-the-work:* only ask what Klove can't get otherwise.
- **A3 Care circle.** Add a first family member during onboarding (→ AddMember). Verify it lands in the roster.
- **A4 Notifications.** Toggle push / channels. Verify honest copy and that skipping is allowed.
- **A5 Re-auth.** With a wiped token but `hasOnboarded`, verify `ReAuthView` appears (not onboarding) and recovers.
- **A6 Sign out.** Settings → Sign out → returns to onboarding; confirm no stale data leaks on next login.

## B. Household & members  (launch: AUTHED)

- **B1 Roster.** Family tab shows Alyssa, Theo, Margaret, Jordan with correct relationships, member types,
  and consent dots (Jordan = pending). Verify per-member "needs you" indicators.
- **B2 Add a minor.** Add a child → appears immediately, managed, active consent.
- **B3 Add an aging parent.** Same, relationship = parent.
- **B4 Invite a consenting adult.** Add adult → InviteMember sheet → copy/share link. Verify the invite
  link + that the member sits in "pending" until accepted. *Does-the-work:* is sharing one tap?
- **B5 Switch member context.** Where member pickers exist (booking, records, search), switching to
  Margaret carries her data through (Lens A).
- **B6 Edit / remove member.** Edit a member's details; verify persistence.

## C. Insurance & profile  (launch: AUTHED)

- **C1 Add insurance (manual).** Profile → add a card (carrier/plan/member ID). Verify it joins the
  wallet and shows in the booking insurance picker. *Does-the-work:* minimal fields, sane defaults.
- **C2 Scan card (mock).** Exercise the scan-card entry; verify on-device/"photo not uploaded" framing and
  graceful mock behavior.
- **C3 Demographics.** Edit name/DOB/phone/address; verify it flows to bookings (Klove shouldn't re-ask).
- **C4 Primary / backup.** Margaret has Medicare (primary) + Medigap (backup); verify both render with
  correct roles and the right one is offered by default when booking for her.

## D. Booking  (launch: AUTHED)  — the highest-value flows

- **D1 Book from Actions.** Actions "+" → Book → form. Verify editorial styling (serif heading, paper bg,
  tokenized type — recent restyle). Patient + insurance prefilled for Alyssa (Lens C: no re-asking).
- **D2 Choose a provider — saved.** "Choose a provider" → pick "Glow Dermatology" from saved → confirmed
  chip shows exact name/phone/website/address. Confirm & book → tracked in Today.
- **D3 Choose a provider — search by name.** Type "Overlake" → select the office (not a city), chip carries
  exact contact. *Regression guard:* a city like "Bellevue" must NOT be selectable as a provider.
- **D4 Find a specialist (into booking).** Choose provider → "Find a specialist" → condition → ranked
  results → "Use this provider" returns into the booking with the specialist filled in.
- **D5 Needs-provider path.** Reason only ("Botox for migraines"), no provider → Review → expect "Pick a
  provider" (NOT an auto-selected random clinic). *Regression guard* for the silent-Places-pick bug.
- **D6 Confirm & track.** Confirm a ready booking → confirmation screen (serif heading, live card / "in
  Today & Actions") → appears in Today/Actions.
- **D7 Book for a parent.** Switch to Margaret → her Medicare card is the default; booking carries her DOB.
- **D8 Couldn't-reach-office.** A booking with no reachable office → honest "nothing scheduled, saved to
  Actions" (no fabricated hold). *Does-the-work:* does it offer to finish, or just dump it back?

## E. Ask Klove  (launch: AUTHED)

- **E1 Health question.** "How's my A1c trend?" → grounded answer from seeded labs (7.4→6.9→6.3), no diagnosis.
- **E2 Ask to book.** "Find appointments for botox for migraines" → expect Klove to ask for the office /
  point to Find-a-specialist, NOT confidently name a random institute. *Regression guard.*
- **E3 Multi-turn memory.** After E2, ask "how did you select that center?" → it references the prior turn
  instead of "I haven't selected any center." *Regression guard* (ask history).
- **E4 Cross-flow consistency.** The seed has an in-flight booking with **Overlake Neurology**. Ask "which
  office am I booking with?" → it names Overlake Neurology and attributes it as the user's choice.
- **E5 Proactivity.** After an informational answer, does Klove offer the obvious next step (Lens C)?

## F. Physician search  (launch: AUTHED)

- **F1 Search.** Condition (e.g. "psoriasis") + location → ranked specialists; specialty resolves; disclaimer present.
- **F2 In-network badges.** Each result shows a network badge vs Alyssa's Aetna; verify the badge states + colors.
- **F3 Detail + reviews.** Open a result → credentials, reviews (highlighted terms), insurance section, CTA.
- **F4 Save to directory.** Save a result → confirm it joins "your providers" (visible later in booking).
- **F5 Book from detail.** "Book an appointment" → BookAppointment opens with the provider prefilled (Lens C).

## G. Today / Actions / Records  (launch: AUTHED)

- **G1 Today briefing.** Needs-you / waiting / handled buckets populated from seed; upcoming appointments
  (Glow Derm in 5d, Overlake Cardiology in 12d) render with provider + local date (no off-by-one).
- **G2 Member filter.** Filter Today by Margaret → only her items; visual selected-state correct.
- **G3 Task detail.** Open the "A1c due" needs-you task → actions available; open the handled "Dermatology
  visit" → shows confirmation GD-4471.
- **G4 Records timeline.** Records → Timeline shows the A1c observations + past physical, grouped by month.
- **G5 Records by type.** Segment to Records → grouped by labs/conditions/etc.; the diabetes condition shows.
- **G6 Appointment detail.** Open an upcoming appointment → provider, time, member, verification state.

## H. Settings & trust  (launch: AUTHED)

- **H1 Connected sources.** Settings → sources list with Connect buttons.
- **H2 Notification prefs.** Toggle + reminder lead-time picker persist.
- **H3 System status.** Mock subsystems honestly badged "Simulated" (Lens A honesty).
- **H4 Legal + version.** Disclaimer + version render.

## I. Cross-cutting  (run against representative screens)

- **I1 Dark mode.** Re-run D1/D6/G1 in dark appearance → tokens invert cleanly, contrast holds.
- **I2 Dynamic Type.** Bump to a large type size on a dense screen (Today, Booking recap) → no clipping/overlap.
- **I3 Empty states.** A member with no records/appointments → composed empty state, not a blank.
- **I4 Loading & error.** Kill the backend mid-flow → honest error, recovery path (not an infinite spinner).
- **I5 VoiceOver labels.** Spot-check that key controls have meaningful accessibility labels.

---

### Suggested first pass
Run **A (onboarding) → B2/B4 → C1 → D1–D6 → E2–E4 → F1/F5 → G1/G3**. These cover the full
"create account → add family → insurance → book (the work Klove should do) → ask → verify" arc and hit
every regression guard from the recent provider-selection + agent fixes.
