import type { Page } from "playwright";
import type { WebSession } from "../web-session.js";
import type { BookingContext, ChannelResult } from "../types.js";
import type { PatientInfo } from "../../types.js";
import type { SchedulerAdapter } from "./types.js";

/**
 * Deterministic adapter for patientsreach.com schedulers ("Practice by Numbers" white-label).
 * Funnel: patient type → visit type → provider → weekly calendar → slot → form → OTP verify → confirm.
 *
 * No LLM — pure Playwright navigation + geometric day-column→slot mapping (far more reliable than
 * an agent on this site). Folds in the proven scan/book logic from scripts/.
 *
 * SAFETY: the final "confirm/book" click only fires when SVASA_SUBMIT=1. Otherwise book stops at
 * the confirm button (dry run) so tests never create a real appointment.
 */

const MAX_WEEKS = 30; // ~7 months out — covers through year-end; the scan stops early when the office's calendar runs out
const SUBMIT = process.env.SVASA_SUBMIT === "1";

export const patientsreachAdapter: SchedulerAdapter = {
  name: "patientsreach",
  matches(url) {
    return /patientsreach\.com/i.test(url);
  },

  async run(session, ctx) {
    const page = await session.getPage();
    return ctx.mode === "book" ? book(page, ctx) : gather(page, ctx);
  },

  async submitVerification(session, ctx, code) {
    const page = await session.getPage();
    const transcript = ["resumed after verification code entry"];
    const filled = await fillCode(page, code);
    transcript.push(`enter code -> ${filled ? "ok" : "no field found"}`);
    if (!filled) return { outcome: "failed", summary: "Could not find the verification code field.", transcript: transcript.join("\n") };
    await clickByText(page, /verify|confirm|submit|continue|^next$/i);
    await page.waitForTimeout(3000);
    return advance(page, ctx, transcript, /* noReverify */ true);
  },
};

// ---- gather: enumerate availability ----

async function gather(page: Page, ctx: BookingContext): Promise<ChannelResult> {
  const transcript: string[] = ["patientsreach gather"];
  if (!(await walkFunnel(page, ctx, transcript))) {
    return { outcome: "failed", summary: "Could not reach the scheduler calendar.", transcript: transcript.join("\n") };
  }

  const window = `${ctx.patient.acceptableWindow} ${ctx.patient.preferredTimes}`;
  const offered: string[] = [];
  const acceptable: string[] = [];

  for (let week = 0; week < MAX_WEEKS; week++) {
    const wk = await weekScan(page);
    if (!wk.hasCalendar) break;
    for (const d of wk.days) {
      for (const t of d.slots) {
        const label = `${d.day} ${d.date}, ${t}`;
        if (!offered.includes(label)) offered.push(label);
        if (matchesWindow(d.day, t, window) && !acceptable.includes(label)) acceptable.push(label);
      }
    }
    transcript.push(`${wk.weekHeader || `week ${week}`}: ${wk.days.map((d) => `${d.day}(${d.slots.length})`).join(" ")}`);
    if (acceptable.length >= 6) break; // enough to auto-book or present
    if (!(await nextWeek(page))) break;
  }

  if (!offered.length) {
    return { outcome: "no_availability", summary: "No open appointment slots were found on the scheduler.", transcript: transcript.join("\n") };
  }
  return {
    outcome: "options_collected",
    offeredSlots: offered.slice(0, 40),
    acceptableSlots: acceptable.slice(0, 12),
    summary: `Found ${offered.length} open slots; ${acceptable.length} within the requested window${acceptable.length ? ` (earliest: ${acceptable[0]})` : ""}.`,
    transcript: transcript.join("\n"),
  };
}

// ---- book: confirm one chosen slot ----

async function book(page: Page, ctx: BookingContext): Promise<ChannelResult> {
  const transcript: string[] = ["patientsreach book"];
  const slot = parseSlotLabel(ctx.chosenSlot);
  if (!slot) return { outcome: "failed", summary: `Unrecognized slot label: "${ctx.chosenSlot}".`, transcript: transcript.join("\n") };

  if (!(await walkFunnel(page, ctx, transcript))) {
    return { outcome: "failed", summary: "Could not reach the scheduler calendar.", transcript: transcript.join("\n") };
  }

  // Walk weeks to the one holding the chosen day/date with that time still open.
  let reached = false;
  for (let week = 0; week < MAX_WEEKS; week++) {
    const wk = await weekScan(page);
    if (!wk.hasCalendar) break;
    const hit = wk.days.find((d) => d.day === slot.day && sameDate(d.date, slot.date) && d.slots.some((s) => sameTime(s, slot.time)));
    if (hit) { reached = true; break; }
    if (!(await nextWeek(page))) break;
  }
  if (!reached) {
    return { outcome: "failed", summary: `The slot ${ctx.chosenSlot} is no longer available.`, transcript: transcript.join("\n") };
  }

  const clicked = await clickSlot(page, slot);
  transcript.push(`click slot ${ctx.chosenSlot} -> ${clicked}`);
  if (!clicked) return { outcome: "failed", summary: "Found the day but couldn't click the time slot.", transcript: transcript.join("\n") };
  await page.waitForTimeout(2200);

  await clickByText(page, /booking myself|for myself|^myself/i);
  await page.waitForTimeout(1500);

  await fillForm(page, ctx.patient, transcript);
  await page.waitForTimeout(900);

  return advance(page, ctx, transcript, false);
}

/**
 * Advance the booking form: detect confirmation, the OTP verification wall, or click Next/Confirm.
 * Returns "verification_needed" (holding the session) when the site demands a patient OTP.
 */
async function advance(page: Page, ctx: BookingContext, transcript: string[], noReverify: boolean): Promise<ChannelResult> {
  for (let step = 0; step < 8; step++) {
    const body = await page.evaluate(() => document.body.innerText);

    if (/confirmed|confirmation number|you'?re booked|appointment .*(booked|confirmed|scheduled)|booking (complete|confirmed)/i.test(body)) {
      transcript.push(`step ${step}: CONFIRMED`);
      return {
        outcome: "booked",
        appointmentDateTime: ctx.chosenSlot ?? "",
        confirmation: extractConfirmation(body),
        summary: `Appointment confirmed for ${ctx.chosenSlot ?? "the selected time"}.`,
        transcript: transcript.join("\n"),
      };
    }

    if (isVerificationStep(body)) {
      if (noReverify) {
        transcript.push(`step ${step}: code rejected`);
        return { outcome: "failed", summary: "The verification code was not accepted.", transcript: transcript.join("\n") };
      }
      // Trigger code delivery if the site asks how to send it (prefer email).
      await clickByText(page, /use email|send.*email|email me|email code/i);
      await page.waitForTimeout(1500);
      const after = await page.evaluate(() => document.body.innerText);
      const contact = /email/i.test(after) ? "your email" : /cell|phone|text|sms/i.test(after) ? "your phone" : "your email or phone";
      transcript.push(`step ${step}: verification required (${contact})`);
      return {
        outcome: "verification_needed",
        verificationContact: contact,
        summary: `The scheduler sent a one-time code to ${contact}. Enter it in the app to finish booking.`,
        transcript: transcript.join("\n"),
      };
    }

    const btns = (await page.locator("button, [role=button]").allInnerTexts()).map((t) => t.trim()).filter(Boolean);
    const finalBtn = btns.find((t) => /confirm|^book\b|schedule appointment|complete booking|^submit/i.test(t) && !/back/i.test(t));
    const nextBtn = btns.find((t) => /^next$|continue/i.test(t));
    transcript.push(`step ${step}: buttons=${JSON.stringify(btns.slice(0, 8))}`);

    if (finalBtn && !nextBtn) {
      if (!SUBMIT) {
        return { outcome: "failed", summary: `[dry-run] Reached final confirm ("${finalBtn}") but SVASA_SUBMIT is not set, so nothing was booked.`, transcript: transcript.join("\n") };
      }
      await clickByText(page, new RegExp(escapeRe(finalBtn), "i"));
      await page.waitForTimeout(4000);
      continue;
    }
    if (nextBtn) {
      // These multi-step screens block "Next" until the step's choice is picked. Select the sensible
      // default first (book for the patient; keep insurance as-is since it's on file).
      await clickByText(page, /booking myself|for myself|^myself$/i).catch(() => {});
      await clickByText(page, /insurance unchanged|same insurance|no changes/i).catch(() => {});

      const before = page.url() + body.slice(0, 80);
      let advanced = false;
      for (let tryN = 0; tryN < 3 && !advanced; tryN++) {
        await clickByText(page, /^next$|continue/i);
        await page.waitForTimeout(2500 + tryN * 1500); // dynamic forms sometimes need a beat to validate
        const now = page.url() + (await page.evaluate(() => document.body.innerText)).slice(0, 80);
        if (now !== before) advanced = true;
      }
      if (!advanced) {
        const dump = await page.evaluate(() => {
          const fields = Array.from(document.querySelectorAll("input,select,textarea")).map((el) => {
            const e = el as HTMLInputElement;
            return `${e.tagName}#${e.id || ""}[name=${e.name || ""}][type=${e.type || ""}]${e.required ? "*REQ" : ""} ph="${(e as HTMLInputElement).placeholder || ""}" val="${(e.value || "").slice(0, 24)}"`;
          });
          const errs = Array.from(document.querySelectorAll('[class*="error" i],[class*="invalid" i],[role="alert"],.help-block'))
            .map((e) => (e as HTMLElement).innerText?.trim()).filter(Boolean);
          return { fields, errs };
        }).catch(() => ({ fields: [], errs: [] }));
        transcript.push("FORM_FIELDS: " + JSON.stringify(dump.fields));
        transcript.push("FORM_ERRORS: " + JSON.stringify(dump.errs));
        return { outcome: "info_needed", missingInfo: ["A required field on the booking form could not be completed"], summary: "Form validation blocked progress.", transcript: transcript.join("\n") };
      }
      continue;
    }
    return { outcome: "failed", summary: "No forward button on the booking form.", transcript: transcript.join("\n") };
  }
  return { outcome: "failed", summary: "Booking did not reach a confirmation.", transcript: transcript.join("\n") };
}

// ---- funnel + calendar primitives ----

interface WeekState { hasCalendar: boolean; weekHeader: string; days: { day: string; date: string; slots: string[] }[] }

function weekScan(page: Page): Promise<WeekState> {
  return page.evaluate(() => {
    const headers: { day: string; date: string; x: number }[] = [];
    for (const el of Array.from(document.querySelectorAll("*"))) {
      const t = (el as HTMLElement).innerText?.trim() ?? "";
      const m = t.match(/^(SUN|MON|TUE|WED|THU|FRI|SAT)\s+([A-Za-z]{3}\s+\d{1,2})$/);
      if (m && t.length < 20) {
        const r = el.getBoundingClientRect();
        if (r.width && !headers.some((h) => h.day === m[1])) headers.push({ day: m[1], date: m[2].replace(/\s+/g, " "), x: r.left + r.width / 2 });
      }
    }
    const rawSlots: { time: string; x: number }[] = [];
    for (const el of Array.from(document.querySelectorAll("button,[role=button],a"))) {
      const t = (el as HTMLElement).innerText?.trim() ?? "";
      if (/^\d{1,2}:\d{2}\s*(AM|PM)$/i.test(t)) {
        const r = el.getBoundingClientRect();
        if (r.width) rawSlots.push({ time: t.toUpperCase().replace(/\s+/g, " "), x: r.left + r.width / 2 });
      }
    }
    const colW = headers.length > 1 ? Math.abs(headers[headers.length - 1].x - headers[0].x) / (headers.length - 1) : 9999;
    const days = headers.map((h) => ({ day: h.day, date: h.date, slots: rawSlots.filter((s) => Math.abs(s.x - h.x) < colW / 2).map((s) => s.time) }));
    const weekHeader = (document.body.innerText.match(/Week of [^\n]+/) ?? [""])[0];
    return { hasCalendar: /Week of /.test(document.body.innerText), weekHeader, days };
  });
}

async function nextWeek(page: Page): Promise<boolean> {
  const before = await weekHeaderText(page);
  const next = page.locator('[aria-label^="Next week"]');
  if (!(await next.count())) return false;
  await next.first().click({ timeout: 5000 }).catch(() => {});
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(400);
    const now = await weekHeaderText(page);
    if (now && now !== before) return true;
  }
  return true; // clicked; assume advanced even if header text matched
}

const weekHeaderText = (page: Page) => page.evaluate(() => (document.body.innerText.match(/Week of [^\n]+/) ?? [""])[0]);

async function walkFunnel(page: Page, ctx: BookingContext, transcript: string[]): Promise<boolean> {
  await page.waitForTimeout(2000);
  const status = (ctx.patient.patientStatus || "").toLowerCase();
  const ptRe = status.startsWith("ret") || status.startsWith("exist") ? /returning|existing/i : /new patient/i;
  transcript.push(`patient type -> ${await clickByText(page, ptRe)}`);
  await page.waitForTimeout(2500);

  const visitRe = reasonToVisit(ctx.patient.reason);
  for (let step = 0; step < 6; step++) {
    if ((await weekScan(page)).hasCalendar) return true;
    const clicked =
      (visitRe && (await clickByText(page, visitRe))) ||
      (await clickByText(page, /see more options/i)) ||
      (await clickByText(page, /any|first available|all providers/i)) ||
      (await clickByText(page, /^(?!Earliest)/i)); // first non-"Earliest:" button (avoids the jump-to-book shortcut)
    transcript.push(`funnel step ${step} -> ${clicked}`);
    await page.waitForTimeout(2500);
    if (!clicked) break;
  }
  return (await weekScan(page)).hasCalendar;
}

async function clickByText(page: Page, re: RegExp): Promise<string | null> {
  const b = page.locator("button, [role=button], a");
  const n = await b.count();
  for (let i = 0; i < n; i++) {
    const t = ((await b.nth(i).innerText().catch(() => "")) || "").trim();
    if (t && re.test(t) && !/^back$/i.test(t)) {
      await b.nth(i).click({ timeout: 5000 }).catch(() => {});
      return t;
    }
  }
  return null;
}

async function clickSlot(page: Page, slot: { day: string; date: string; time: string }): Promise<boolean> {
  return page.evaluate(({ day, date, time }) => {
    const headers: { day: string; date: string; x: number }[] = [];
    for (const el of Array.from(document.querySelectorAll("*"))) {
      const t = (el as HTMLElement).innerText?.trim() ?? "";
      const m = t.match(/^(SUN|MON|TUE|WED|THU|FRI|SAT)\s+([A-Za-z]{3}\s+\d{1,2})$/);
      if (m && t.length < 20) {
        const r = el.getBoundingClientRect();
        if (r.width && !headers.some((h) => h.day === m[1])) headers.push({ day: m[1], date: m[2].replace(/\s+/g, " "), x: r.left + r.width / 2 });
      }
    }
    const colW = headers.length > 1 ? Math.abs(headers[headers.length - 1].x - headers[0].x) / (headers.length - 1) : 9999;
    const col = headers.find((h) => h.day === day && h.date === date);
    if (!col) return false;
    const T = time.toUpperCase().replace(/\s+/g, " ");
    for (const el of Array.from(document.querySelectorAll("button,[role=button],a"))) {
      const t = ((el as HTMLElement).innerText?.trim() ?? "").toUpperCase().replace(/\s+/g, " ");
      if (t === T) {
        const r = el.getBoundingClientRect();
        if (r.width && Math.abs(r.left + r.width / 2 - col.x) < colW / 2) { (el as HTMLElement).click(); return true; }
      }
    }
    return false;
  }, slot);
}

// ---- form fill ----

async function fillForm(page: Page, p: PatientInfo, transcript: string[]): Promise<void> {
  const { first, last } = splitName(p.name);
  transcript.push(`first -> ${await fill(page, 'input[id*="first-name" i],input[name*="first" i]', first)}`);
  transcript.push(`last -> ${await fill(page, 'input[id*="last-name" i],input[name*="last" i]', last)}`);
  transcript.push(`phone -> ${await fill(page, 'input[id*="phone" i],input[name*="phone" i],input[type="tel"]', digits(p.patientPhone), true)}`);
  transcript.push(`dob -> ${await fill(page, 'input[id*="birth" i],input[name*="birth" i]', dobDigits(p.dob), true)}`);
  if (p.patientEmail) transcript.push(`email -> ${await fill(page, 'input[type="email"],input[id*="email" i],input[name*="email" i]', p.patientEmail)}`);
  await page.getByRole("checkbox").first().check().catch(async () => {
    await page.locator('input[type="checkbox"]').first().check().catch(() => {});
  });
}

async function fill(page: Page, selectors: string, value: string, keystrokes = false): Promise<boolean> {
  if (!value) return false;
  const loc = page.locator(selectors).first();
  if (!(await loc.count())) return false;
  await loc.scrollIntoViewIfNeeded().catch(() => {});
  await loc.click().catch(() => {});
  if (keystrokes) await loc.pressSequentially(value, { delay: 50 }).catch(() => {});
  else await loc.fill(value).catch(() => {});
  return true;
}

async function fillCode(page: Page, code: string): Promise<boolean> {
  const single = page.locator('input[autocomplete="one-time-code"], input[name*="code" i], input[id*="code" i], input[name*="otp" i], input[id*="otp" i]');
  if (await single.count()) {
    await single.first().click().catch(() => {});
    await single.first().pressSequentially(code, { delay: 60 }).catch(() => {});
    return true;
  }
  const boxes = page.locator('input[maxlength="1"]');
  const n = await boxes.count();
  if (n >= code.length && n > 1) {
    for (let i = 0; i < code.length; i++) {
      await boxes.nth(i).click().catch(() => {});
      await boxes.nth(i).pressSequentially(code[i], { delay: 60 }).catch(() => {});
    }
    return true;
  }
  const any = page.locator('input[type="text"], input[type="tel"], input:not([type])').first();
  if (await any.count()) {
    await any.click().catch(() => {});
    await any.pressSequentially(code, { delay: 60 }).catch(() => {});
    return true;
  }
  return false;
}

// ---- pure helpers ----

function reasonToVisit(reason: string): RegExp | null {
  const r = (reason || "").toLowerCase();
  if (/clean|checkup|check-up|hygiene|prophy|routine/.test(r)) return /clean|checkup|hygiene|prophy/i;
  if (/new patient|exam/.test(r)) return /exam|new patient/i;
  if (/emergency|pain|urgent|tooth ?ache|broken/.test(r)) return /emergency|urgent|pain/i;
  if (/whiten/.test(r)) return /whiten/i;
  return null;
}

export function matchesWindow(day: string, time: string, window: string): boolean {
  const w = (window || "").toLowerCase().trim();
  if (!w) return true;

  // Day constraints.
  const dayAliases: Record<string, string[]> = {
    SUN: ["sun", "sunday"], MON: ["mon", "monday"], TUE: ["tue", "tues", "tuesday"], WED: ["wed", "wednesday"],
    THU: ["thu", "thur", "thurs", "thursday"], FRI: ["fri", "friday"], SAT: ["sat", "saturday"],
  };
  const mentionsWeekend = /weekend/.test(w);
  const mentionsWeekday = /weekday|week day|business day/.test(w);
  const mentionedDays = Object.entries(dayAliases)
    .filter(([, aliases]) => aliases.some((a) => new RegExp(`\\b${a}\\b`).test(w)))
    .map(([k]) => k);
  const hasDayConstraint = mentionedDays.length > 0 || mentionsWeekend || mentionsWeekday;

  // Time-of-day constraints.
  const tod: [number, number][] = [];
  if (/morning/.test(w)) tod.push([0, 12]);
  if (/afternoon/.test(w)) tod.push([12, 17]);
  if (/evening|night/.test(w)) tod.push([17, 24]);
  const after = w.match(/after\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  const before = w.match(/before\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  const hasTimeConstraint = tod.length > 0 || !!after || !!before;

  // No real constraint (e.g. "any time", "asap", "flexible", "earliest") → anything is acceptable. But a
  // phrase like "Saturday any time" DOES constrain the day — "any" must not override the day filter.
  if (!hasDayConstraint && !hasTimeConstraint) return true;

  let dayOk = true;
  if (hasDayConstraint) {
    const allowed = new Set(mentionedDays);
    if (mentionsWeekend) { allowed.add("SAT"); allowed.add("SUN"); }
    if (mentionsWeekday) ["MON", "TUE", "WED", "THU", "FRI"].forEach((d) => allowed.add(d));
    dayOk = allowed.has(day);
  }

  const hour = parseHour(time);
  let timeOk = true;
  if (tod.length && hour != null) timeOk = tod.some(([lo, hi]) => hour >= lo && hour < hi);
  if (after && hour != null) timeOk = timeOk && hour >= to24(after);
  if (before && hour != null) timeOk = timeOk && hour < to24(before);

  return dayOk && timeOk;
}

function parseHour(time: string): number | null {
  const m = time.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!m) return null;
  let h = parseInt(m[1], 10) % 12;
  if (/pm/i.test(m[3])) h += 12;
  return h;
}

function to24(m: RegExpMatchArray): number {
  let h = parseInt(m[1], 10);
  const ap = m[3]?.toLowerCase();
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  return h;
}

export function parseSlotLabel(label: string | undefined): { day: string; date: string; time: string } | null {
  const m = label?.match(/^(SUN|MON|TUE|WED|THU|FRI|SAT)\s+([A-Za-z]{3}\s+\d{1,2}),?\s+(\d{1,2}:\d{2}\s*(?:AM|PM))$/i);
  if (!m) return null;
  return { day: m[1].toUpperCase(), date: m[2].replace(/\s+/g, " "), time: m[3].toUpperCase().replace(/\s+/g, " ") };
}

const sameTime = (a: string, b: string) => a.toUpperCase().replace(/\s+/g, " ").trim() === b.toUpperCase().replace(/\s+/g, " ").trim();
const sameDate = (a: string, b: string) => a.replace(/\s+/g, " ").trim().toLowerCase() === b.replace(/\s+/g, " ").trim().toLowerCase();

function splitName(name: string): { first: string; last: string } {
  const parts = (name || "").trim().split(/\s+/).filter(Boolean);
  return { first: parts[0] || "", last: parts.slice(1).join(" ") || parts[0] || "" };
}

const digits = (s: string) => (s || "").replace(/[^0-9]/g, "");

function dobDigits(dob: string): string {
  const d = digits(dob);
  // ISO yyyy-mm-dd → mmddyyyy (what masked DOB inputs expect)
  if (/^\d{4}-\d{2}-\d{2}/.test(dob || "")) return d.slice(4, 6) + d.slice(6, 8) + d.slice(0, 4);
  return d;
}

function isVerificationStep(body: string): boolean {
  return /(verification|one[- ]time|security)\s*code|enter the code|we (sent|texted|emailed)|confirm your (email|phone|cell|number)|use email|use cell phone/i.test(body);
}

function extractConfirmation(body: string): string {
  const m = body.match(/confirmation\s*(?:number|#|code)?\s*[:#]?\s*([A-Z0-9-]{4,})/i);
  return m ? m[1] : "";
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
