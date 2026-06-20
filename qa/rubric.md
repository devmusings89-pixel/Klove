# Klove QA evaluation rubric

The QA agent judges every screen and flow through **three lenses**. A scenario isn't "passing" just
because the happy path completes — it passes when it's **correct**, **looks designed**, and **does the
work for the customer**. Score each lens, and log findings in the format at the bottom.

---

## Lens A — Functional & data consistency

Does it actually work, and does the data stay true across screens?

- The flow completes end-to-end; primary actions do what they say.
- **Cross-screen truth:** the office you picked is the office shown on confirm and tracked in Today; the
  insurance/member/DOB shown matches what was selected; a name entered once appears everywhere (roster,
  headers, booking picker).
- Back / Cancel / Edit return cleanly; state persists across navigation and relaunch where it should.
- No dead-ends, no stuck spinners, no silently-dropped input. Errors are surfaced, not swallowed.
- Empty, loading, and error states exist and are correct (not a blank screen or a crash).
- In mock mode, anything not live is honestly labeled ("Simulated") rather than faking success.

## Lens B — The designer's eye

Would a senior product designer ship this screen next to the rest of the app? Hold it against the
**editorial-monochrome system** (`ios/Klove/DesignSystem/Theme.swift` + `Components.swift`):

- **Typography:** serif display headings (`.kloveSerifHeading`/`.kloveTitle`), semantic body/label fonts
  (`.kloveBody`, `.kloveBodyStrong`, `.kloveCaption`, `.kloveLabel`) — not raw `.title`/`.caption`.
  Tracked-uppercase section labels (`SectionLabel`).
- **Color:** monochrome ink/paper tokens (`Theme.ink`, `inkSecondary`, `background`, `surface`,
  `surfaceSunken`, `accent`) — no stray system blue/grey, no off-palette color. Status color (network
  badges) only where it earns its place.
- **Surfaces & rhythm:** `kloveCard`/`kloveCardSunken` (hairline border, continuous radius), spacing on
  the `Theme.Spacing` scale, radii on `Theme.Radius`. Consistent padding/alignment; no magic-number drift.
- **States:** empty/loading/error states are composed and on-brand, not default placeholders.
- **Polish:** visual hierarchy reads at a glance; transitions feel intentional; **dark mode** and
  **Dynamic Type** hold up; copy is warm, concise, human (no corporate filler, no robotic templating);
  iconography is consistent.
- Flag pixel-level inconsistencies *relative to sibling screens* (e.g. this card is off-brand next to
  PhysicianSearch/Profile/Today).

## Lens C — "Klove does the work, not the customer"

The core promise: the customer hired Klove to take work *off* their plate. Flag every moment the app
hands work *back*.

**Penalize:**
- Re-asking for anything already on file (name, DOB, insurance, address, a saved provider).
- Free-text or manual entry where Klove could infer, autofill, or pre-resolve (e.g. typing an office
  name instead of choosing a known/searched provider; re-entering a carrier Klove already has).
- Manual lookups pushed to the user ("find the office's phone number and paste it here").
- Dead-ends that return the task to the user instead of Klove finishing or proposing a next step.
- Excessive taps / fields / steps for a job Klove could do in one move.
- No proactive follow-through after an answer ("want me to book that?", "I can add this to your visit
  questions") — a passive screen that just sits there.
- Making the user remember context the app already has (cross-flow amnesia).

**Reward:**
- Autofill from on-file data; a provider already resolved with exact phone/website; one-tap confirm.
- Klove doing the legwork (resolving the office, checking insurance, drafting questions) and only asking
  for a genuine decision.
- Proactive, well-timed next-step offers; continuity ("the dermatology visit you're booking…").

For each Lens-C finding, write the concrete fix as **"Klove should …"** (what the app should do instead
of the user).

---

## Severity

- **blocker** — broken, data-wrong, dead-end, or a trust-breaking "Klove made me do its job."
- **major** — wrong/again-asked data, a clearly off-brand screen, or meaningful avoidable user toil.
- **minor** — noticeable polish or small friction; not shipping-blocking on its own.
- **polish** — nit; spacing/copy/icon refinement.

## Finding format (used in every report)

```
- [LENS A|B|C] [severity] (screen) Observation.
  → Klove should / Fix: <concrete, specific suggestion>.
  evidence: <screenshot filename>
```

## Per-scenario report shape (`qa/reports/<scenario>.md`)

1. **Scenario** + precondition/launch env, and **Status**: pass / partial / fail.
2. **Journey** — the steps actually driven, each with its screenshot filename.
3. **Findings** — the list above, grouped by lens, ordered by severity.
4. **Scorecard** — one line each: Functional _/5 · Design _/5 · Does-the-work _/5, with a one-sentence
   verdict and the single highest-impact fix.
