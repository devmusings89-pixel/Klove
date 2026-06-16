/** Deterministic (no-LLM) probe of the Avondale/patientsreach scheduler calendar. */
import { chromium } from "playwright";

const CAL = "https://www.patientsreach.com/schedule/avondalesmiles/patient_types/new/visit_types/3/providers/AA/";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
try {
  await page.goto(CAL, { waitUntil: "networkidle", timeout: 45_000 });
  await page.waitForTimeout(2500);

  for (let week = 0; week < 8; week++) {
    const info = await page.evaluate(() => {
      const txt = (document.body?.innerText || "").replace(/\n{2,}/g, "\n").trim();
      const clickables = Array.from(document.querySelectorAll("button, a, [role=button]"))
        .map((e) => ((e as HTMLElement).innerText || e.getAttribute("aria-label") || "").trim())
        .filter(Boolean);
      return { url: location.href, text: txt.slice(0, 1200), clickables: [...new Set(clickables)].slice(0, 40) };
    });
    console.log(`\n===== view ${week} | ${info.url} =====`);
    console.log("CLICKABLES:", JSON.stringify(info.clickables));
    console.log("TEXT:\n" + info.text);

    // Try to advance to the next week/dates. Look for a forward control.
    const next = page.locator(
      'button:has-text("Next"), [aria-label*="next" i], button:has-text(">"), button:has-text("›"), button:has-text("More")',
    );
    if ((await next.count()) === 0) {
      console.log("(no next/forward control found — stopping)");
      break;
    }
    await next.first().click({ timeout: 5000 }).catch(() => console.log("(next click failed)"));
    await page.waitForTimeout(2000);
  }
} catch (err) {
  console.error("probe error:", (err as Error).message);
} finally {
  await page.screenshot({ path: "/tmp/sched.png", fullPage: true }).catch(() => {});
  await browser.close();
}
process.exit(0);
