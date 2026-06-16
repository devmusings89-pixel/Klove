/**
 * REAL booking: Avondale Smiles (patientsreach) — Returning patient, Adult Cleaning,
 * Sat Oct 3 2026 10:30 AM, for Prakash Ahuja. Deterministic navigation + real-keystroke form fill.
 * Screenshots to /tmp/book-*.png. DRY RUN by default; set SUBMIT=1 to actually confirm.
 */
import { chromium, type Page } from "playwright";

const SUBMIT = process.env.SUBMIT === "1";
const START = "https://www.patientsreach.com/schedule/avondalesmiles/patient_types/";
const TARGET_WEEK = "September 27 to October 3";
const TARGET_DAY = "SAT";
const TARGET_TIME = "10:30 AM";
const P = { first: "Prakash", last: "Ahuja", phone: "2063518641", dobDigits: "09281984", email: "prakashahuja.84@gmail.com" };

async function clickText(page: Page, re: RegExp): Promise<string | null> {
  const b = page.locator("button, [role=button], a");
  for (let i = 0; i < (await b.count()); i++) {
    const t = ((await b.nth(i).innerText().catch(() => "")) || "").trim();
    if (t && re.test(t) && !/^back$/i.test(t)) { await b.nth(i).click({ timeout: 5000 }).catch(() => {}); return t; }
  }
  return null;
}
const wait = (p: Page, ms = 2200) => p.waitForTimeout(ms);
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage();
await page.setViewportSize({ width: 1400, height: 1000 });
let shot = 0;
const snap = async (tag: string) => { await page.screenshot({ path: `/tmp/book-${shot++}-${tag}.png`, fullPage: true }).catch(() => {}); };

async function fill(selectors: string, value: string, keystrokes = false): Promise<boolean> {
  const loc = page.locator(selectors).first();
  if (!(await loc.count())) return false;
  await loc.scrollIntoViewIfNeeded().catch(() => {});
  await loc.click().catch(() => {});
  if (keystrokes) await loc.pressSequentially(value, { delay: 50 }).catch(() => {});
  else await loc.fill(value).catch(() => {});
  return true;
}

try {
  await page.goto(START, { waitUntil: "networkidle", timeout: 45_000 });
  await wait(page);
  console.log("1) patient type ->", await clickText(page, /returning|existing/i)); await wait(page);
  console.log("2) visit type ->", await clickText(page, /ADULT\s+CLEANING/i)); await wait(page);
  console.log("3) provider ->", await clickText(page, /see more options/i)); await wait(page);

  let reached = false;
  for (let i = 0; i < 25; i++) {
    const header = await page.evaluate(() => (document.body.innerText.match(/Week of [^\n]+/) ?? [""])[0]);
    if (header.includes(TARGET_WEEK)) { reached = true; break; }
    const next = page.locator('[aria-label^="Next week"]');
    if (!(await next.count())) break;
    await next.first().click({ timeout: 5000 }).catch(() => {});
    for (let j = 0; j < 20; j++) { await page.waitForTimeout(400); const h = await page.evaluate(() => (document.body.innerText.match(/Week of [^\n]+/) ?? [""])[0]); if (h !== header) break; }
  }
  if (!reached) throw new Error("could not reach target week");

  const clicked = await page.evaluate(({ day, time }) => {
    const headers: { day: string; x: number }[] = [];
    for (const el of Array.from(document.querySelectorAll("*"))) {
      const t = (el as HTMLElement).innerText?.trim() ?? "";
      const m = t.match(/^(SUN|MON|TUE|WED|THU|FRI|SAT)\s+[A-Za-z]{3}\s+\d{1,2}$/);
      if (m && t.length < 20) { const r = el.getBoundingClientRect(); if (r.width && !headers.some((h) => h.day === m[1])) headers.push({ day: m[1], x: r.left + r.width / 2 }); }
    }
    const colW = headers.length > 1 ? Math.abs(headers[headers.length - 1].x - headers[0].x) / (headers.length - 1) : 9999;
    const col = headers.find((h) => h.day === day); if (!col) return false;
    for (const el of Array.from(document.querySelectorAll("button,[role=button],a"))) {
      if ((el as HTMLElement).innerText?.trim().toUpperCase() === time.toUpperCase()) {
        const r = el.getBoundingClientRect();
        if (r.width && Math.abs(r.left + r.width / 2 - col.x) < colW / 2) { (el as HTMLElement).click(); return true; }
      }
    }
    return false;
  }, { day: TARGET_DAY, time: TARGET_TIME });
  console.log("4) clicked SAT Oct 3 10:30 AM:", clicked);
  if (!clicked) throw new Error("slot button not found");
  await wait(page);

  await clickText(page, /booking myself|for myself/i); await wait(page, 1500);

  // Real-keystroke fill so the site's input masks + validation register.
  console.log("first:", await fill('input[id*="first-name" i],input[name*="first" i]', P.first));
  console.log("last:", await fill('input[id*="last-name" i],input[name*="last" i]', P.last));
  console.log("phone:", await fill('input[id*="phone" i],input[name*="phone" i],input[type="tel"]', P.phone, true));
  console.log("dob:", await fill('input[id*="birth" i],input[name*="birth" i]', P.dobDigits, true));
  console.log("email:", await fill('input[type="email"],input[id*="email" i],input[name*="email" i]', P.email));
  await page.getByRole("checkbox").first().check().catch(async () => { await page.locator('input[type="checkbox"]').first().check().catch(() => {}); });
  await wait(page, 900);
  await snap("filled");

  for (let step = 0; step < 6; step++) {
    const body = await page.evaluate(() => document.body.innerText);
    if (/confirmed|confirmation number|you'?re booked|appointment .*(booked|confirmed|scheduled)|booking (complete|confirmed)/i.test(body)) {
      console.log("\n*** BOOKING CONFIRMED ***\n" + body.split("\n").filter(Boolean).slice(0, 30).join("\n"));
      await snap("confirmed"); break;
    }
    const btns = (await page.locator("button, [role=button]").allInnerTexts()).map((t) => t.trim()).filter(Boolean);
    const finalBtn = btns.find((t) => /confirm|^book|schedule appointment|complete booking|submit/i.test(t) && !/back/i.test(t));
    const nextBtn = btns.find((t) => /^next$|continue/i.test(t));
    console.log(`step ${step}: buttons=${JSON.stringify(btns.slice(0, 8))}`);
    await snap(`step-${step}`);

    if (finalBtn && !nextBtn) {
      if (!SUBMIT) { console.log(`\n[DRY RUN] reached final confirm. Would click "${finalBtn}". Set SUBMIT=1 to book for real.`); await snap("preconfirm"); break; }
      console.log(`clicking FINAL: "${finalBtn}"`); await clickText(page, new RegExp(esc(finalBtn), "i")); await wait(page, 4000); continue;
    }
    if (nextBtn) {
      const before = page.url() + body.slice(0, 80);
      await clickText(page, /^next$|continue/i); await wait(page, 2500);
      const after = page.url() + (await page.evaluate(() => document.body.innerText)).slice(0, 80);
      if (after === before) { console.log("Next did not advance — validation still failing"); await snap("stuck"); break; }
      continue;
    }
    console.log("(no forward button)"); break;
  }
} catch (err) {
  console.error("BOOK ERROR:", (err as Error).message); await snap("error");
} finally {
  await browser.close();
}
process.exit(0);
