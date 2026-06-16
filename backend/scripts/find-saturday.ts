/**
 * Deterministically scan the Avondale/patientsreach weekly calendar for the earliest SATURDAY
 * with open slots. Assigns each time-button to a day column by x-position. No LLM.
 * Usage: npx tsx scripts/find-saturday.ts [weeks]
 */
import { chromium } from "playwright";

const CAL = "https://www.patientsreach.com/schedule/avondalesmiles/patient_types/new/visit_types/3/providers/AA/";
const MAX_WEEKS = Number(process.argv[2] ?? 24);

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } } as never);
try {
  await page.goto(CAL, { waitUntil: "networkidle", timeout: 45_000 });
  await page.waitForTimeout(2500);

  let found = false;
  for (let week = 0; week < MAX_WEEKS && !found; week++) {
    const wk = await page.evaluate(() => {
      const days = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
      // Day-column headers: short elements starting with a weekday abbreviation.
      const headers: { day: string; date: string; x: number }[] = [];
      for (const el of Array.from(document.querySelectorAll("*"))) {
        const t = (el as HTMLElement).innerText?.trim() ?? "";
        const m = t.match(/^(SUN|MON|TUE|WED|THU|FRI|SAT)\s+([A-Za-z]{3}\s+\d{1,2})$/);
        if (m && t.length < 20) {
          const r = el.getBoundingClientRect();
          if (r.width && !headers.some((h) => h.day === m[1])) headers.push({ day: m[1], date: m[2], x: r.left + r.width / 2 });
        }
      }
      // Slot buttons: clickable elements whose text is a time.
      const slots: { time: string; x: number }[] = [];
      for (const el of Array.from(document.querySelectorAll("button, [role=button], a"))) {
        const t = (el as HTMLElement).innerText?.trim() ?? "";
        if (/^\d{1,2}:\d{2}\s*(AM|PM)$/i.test(t)) {
          const r = el.getBoundingClientRect();
          if (r.width) slots.push({ time: t, x: r.left + r.width / 2 });
        }
      }
      const headerLine = (document.body.innerText.match(/Week of [^\n]+/) ?? [""])[0];
      // Assign each slot to nearest day column.
      const colW = headers.length > 1 ? Math.abs(headers[headers.length - 1].x - headers[0].x) / (headers.length - 1) : 9999;
      const sat = headers.find((h) => h.day === "SAT");
      const satSlots = sat ? slots.filter((s) => Math.abs(s.x - sat.x) < colW / 2).map((s) => s.time) : [];
      const byDay: Record<string, number> = {};
      for (const h of headers) byDay[h.day] = slots.filter((s) => Math.abs(s.x - h.x) < colW / 2).length;
      return { headerLine, satDate: sat?.date, satSlots, byDay, headerDays: days.filter((d) => headers.some((h) => h.day === d)).length };
    });

    console.log(`wk ${week}: ${wk.headerLine} | per-day slots: ${JSON.stringify(wk.byDay)}`);
    if (wk.satSlots.length > 0) {
      console.log(`\n*** EARLIEST SATURDAY WITH OPENINGS: SAT ${wk.satDate} ***`);
      console.log("times:", JSON.stringify(wk.satSlots));
      found = true;
      break;
    }

    const next = page.locator('[aria-label^="Next week"]');
    if ((await next.count()) === 0) {
      console.log("(no Next week control — stopping)");
      break;
    }
    const before = wk.headerLine;
    await next.first().click({ timeout: 5000 }).catch(() => {});
    // Wait for the week to change.
    for (let i = 0; i < 20; i++) {
      await page.waitForTimeout(400);
      const now = await page.evaluate(() => (document.body.innerText.match(/Week of [^\n]+/) ?? [""])[0]);
      if (now && now !== before) break;
    }
  }
  if (!found) console.log("\n(no Saturday with openings found in scanned window)");
} catch (err) {
  console.error("scan error:", (err as Error).message);
} finally {
  await browser.close();
}
process.exit(0);
