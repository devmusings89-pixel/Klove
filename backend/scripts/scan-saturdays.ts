/**
 * Deterministically walk the patientsreach funnel for a given patient type, preferring the
 * "any provider" option, then scan the calendar for the earliest Saturday with openings.
 * Usage: npx tsx scripts/scan-saturdays.ts [new|returning] [weeks]
 */
import { chromium, type Page } from "playwright";

const START = "https://www.patientsreach.com/schedule/avondalesmiles/patient_types/";
const patientType = (process.argv[2] ?? "returning").toLowerCase();
const visitKeyword = process.argv[3] ?? ""; // e.g. "ADULT CLEANING" — picks that visit type
const MAX_WEEKS = Number(process.argv[4] ?? 24);
const visitRe = visitKeyword ? new RegExp(visitKeyword.replace(/\s+/g, "\\s+"), "i") : null;

const weekScan = (page: Page) =>
  page.evaluate(() => {
    const headers: { day: string; date: string; x: number }[] = [];
    for (const el of Array.from(document.querySelectorAll("*"))) {
      const t = (el as HTMLElement).innerText?.trim() ?? "";
      const m = t.match(/^(SUN|MON|TUE|WED|THU|FRI|SAT)\s+([A-Za-z]{3}\s+\d{1,2})$/);
      if (m && t.length < 20) {
        const r = el.getBoundingClientRect();
        if (r.width && !headers.some((h) => h.day === m[1])) headers.push({ day: m[1], date: m[2], x: r.left + r.width / 2 });
      }
    }
    const slots: { time: string; x: number }[] = [];
    for (const el of Array.from(document.querySelectorAll("button,[role=button],a"))) {
      const t = (el as HTMLElement).innerText?.trim() ?? "";
      if (/^\d{1,2}:\d{2}\s*(AM|PM)$/i.test(t)) {
        const r = el.getBoundingClientRect();
        if (r.width) slots.push({ time: t, x: r.left + r.width / 2 });
      }
    }
    const headerLine = (document.body.innerText.match(/Week of [^\n]+/) ?? [""])[0];
    const colW = headers.length > 1 ? Math.abs(headers.at(-1)!.x - headers[0].x) / (headers.length - 1) : 9999;
    const sat = headers.find((h) => h.day === "SAT");
    const satSlots = sat ? slots.filter((s) => Math.abs(s.x - sat.x) < colW / 2).map((s) => s.time) : [];
    const byDay: Record<string, number> = {};
    for (const h of headers) byDay[h.day] = slots.filter((s) => Math.abs(s.x - h.x) < colW / 2).length;
    return { headerLine, satDate: sat?.date, satSlots, byDay, hasCalendar: /Week of /.test(document.body.innerText) };
  });

async function clickByText(page: Page, re: RegExp): Promise<string | null> {
  const btns = page.locator("button, [role=button], a");
  const n = await btns.count();
  for (let i = 0; i < n; i++) {
    const txt = ((await btns.nth(i).innerText().catch(() => "")) || "").trim();
    if (txt && re.test(txt) && !/^back$/i.test(txt)) {
      await btns.nth(i).click({ timeout: 5000 }).catch(() => {});
      return txt;
    }
  }
  return null;
}

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage();
await page.setViewportSize({ width: 1400, height: 1000 });
try {
  await page.goto(START, { waitUntil: "networkidle", timeout: 45_000 });
  await page.waitForTimeout(2000);

  // 1) patient type
  const ptRe = patientType.startsWith("ret") || patientType.startsWith("exist") ? /returning|existing/i : /new patient/i;
  console.log("patient type ->", await clickByText(page, ptRe));
  await page.waitForTimeout(2500);

  // 2) walk funnel until a calendar appears (pick first visit type, prefer "any" provider)
  for (let step = 0; step < 6; step++) {
    const state = await weekScan(page);
    if (state.hasCalendar) break;
    const buttons = await page.locator("button, [role=button]").allInnerTexts();
    console.log(`funnel @ ${page.url().split("/schedule/avondalesmiles")[1]} options:`, JSON.stringify(buttons.map((b) => b.trim()).filter(Boolean).slice(0, 12)));
    const clicked =
      (visitRe && (await clickByText(page, visitRe))) ||
      (await clickByText(page, /see more options/i)) || // open a provider's full weekly calendar
      (await clickByText(page, /any|first available|all providers/i)) ||
      (await clickByText(page, /^(?!Earliest)/i)); // avoid "Earliest:" (jumps to booking); take a non-earliest button
    console.log("  clicked ->", clicked);
    await page.waitForTimeout(2500);
  }

  // 3) scan weeks for the earliest Saturday with openings
  let found = false;
  for (let week = 0; week < MAX_WEEKS && !found; week++) {
    const wk = await weekScan(page);
    if (!wk.hasCalendar) {
      console.log("(no calendar reached) at", page.url());
      break;
    }
    console.log(`wk ${week}: ${wk.headerLine} | ${JSON.stringify(wk.byDay)}`);
    if (wk.satSlots.length) {
      console.log(`\n*** EARLIEST SATURDAY WITH OPENINGS: SAT ${wk.satDate} -> ${JSON.stringify(wk.satSlots)} ***`);
      console.log("calendar URL:", page.url());
      found = true;
      break;
    }
    const before = wk.headerLine;
    const next = page.locator('[aria-label^="Next week"]');
    if (!(await next.count())) { console.log("(no Next week control)"); break; }
    await next.first().click({ timeout: 5000 }).catch(() => {});
    for (let i = 0; i < 20; i++) {
      await page.waitForTimeout(400);
      const now = await page.evaluate(() => (document.body.innerText.match(/Week of [^\n]+/) ?? [""])[0]);
      if (now && now !== before) break;
    }
  }
  if (!found) console.log("\n(no Saturday openings found in window)");
} catch (err) {
  console.error("error:", (err as Error).message);
} finally {
  await browser.close();
}
process.exit(0);
