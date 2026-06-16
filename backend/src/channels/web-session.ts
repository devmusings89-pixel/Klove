import { chromium, type Page, type Browser, type BrowserContext } from "playwright";

export const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export const refSelector = (ref: string) => `[data-klove-ref="${ref}"]`;

/**
 * Resilient browser session: adopts popups/new tabs as the active page, and relaunches +
 * re-navigates to the last URL if the page or browser crashes (real SPA schedulers do this).
 *
 * Two ways to drive it:
 * - LLM agent loop → `exec(tool, input)` (snapshot/navigate/click/type/select).
 * - Deterministic adapter → `getPage()` for direct Playwright locators/evaluate.
 */
export class WebSession {
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;
  private url = "";

  async start(url: string): Promise<void> {
    this.url = url;
    await this.open();
  }

  /** Live Playwright page (for deterministic adapters). Self-heals if it was closed. */
  async getPage(): Promise<Page> {
    await this.ensure();
    return this.page!;
  }

  private async open(): Promise<void> {
    this.browser = await chromium.launch({
      headless: true,
      args: ["--disable-dev-shm-usage", "--no-sandbox", "--disable-blink-features=AutomationControlled"],
    });
    this.context = await this.browser.newContext({ userAgent: USER_AGENT, viewport: { width: 1400, height: 1000 }, ignoreHTTPSErrors: true });
    this.context.on("page", (p) => (this.page = p)); // adopt popups / new tabs
    this.page = await this.context.newPage();
    await this.page.goto(this.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  }

  private async ensure(): Promise<void> {
    if (!this.browser || !this.browser.isConnected()) {
      try { await this.close(); } catch { /* ignore */ }
      await this.open();
      return;
    }
    if (!this.page || this.page.isClosed()) {
      const live = this.context!.pages().filter((p) => !p.isClosed());
      this.page = live.at(-1) ?? (await this.context!.newPage());
      if (this.page.url() === "about:blank" && this.url) {
        await this.page.goto(this.url, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
      }
    }
  }

  /** Run an LLM tool; self-heal once if the page/browser was closed mid-action. */
  async exec(name: string, input: Record<string, unknown>): Promise<string> {
    try {
      return await this.run(name, input);
    } catch (err) {
      const msg = (err as Error).message;
      if (/closed|crash|detached|Target/i.test(msg)) {
        await this.ensure();
        try {
          return `(recovered) ${await this.run(name, input)}`;
        } catch (e2) {
          return `error after recovery: ${(e2 as Error).message}`;
        }
      }
      return `error: ${msg}`;
    }
  }

  private async run(name: string, input: Record<string, unknown>): Promise<string> {
    await this.ensure();
    const page = this.page!;
    switch (name) {
      case "snapshot":
        this.url = page.url();
        return await snapshot(page);
      case "navigate":
        await page.goto(String(input.url), { waitUntil: "domcontentloaded", timeout: 30_000 });
        this.url = page.url();
        return `navigated to ${page.url()}`;
      case "click":
        await page.click(refSelector(String(input.ref)), { timeout: 8_000 });
        await (this.page ?? page).waitForLoadState("domcontentloaded", { timeout: 6_000 }).catch(() => {});
        await (this.page ?? page).waitForTimeout(600);
        this.url = this.page?.url() ?? this.url;
        return "clicked";
      case "type":
        await page.fill(refSelector(String(input.ref)), String(input.text), { timeout: 8_000 });
        return "typed";
      case "select":
        await page
          .selectOption(refSelector(String(input.ref)), { label: String(input.value) })
          .catch(async () => {
            await page.selectOption(refSelector(String(input.ref)), String(input.value));
          });
        return "selected";
      default:
        return `unknown tool ${name}`;
    }
  }

  async close(): Promise<void> {
    try {
      await this.browser?.close();
    } catch {
      /* ignore */
    }
  }
}

/** Tag interactable elements with data-klove-ref and return a compact page summary. */
export async function snapshot(page: Page): Promise<string> {
  const data = await page.evaluate(() => {
    // Clear refs from any previous snapshot so each ref maps to exactly one current element.
    document.querySelectorAll("[data-klove-ref]").forEach((e) => e.removeAttribute("data-klove-ref"));
    const sel = "a, button, input, textarea, select, [role=button], [role=link], [role=option]";
    const els = Array.from(document.querySelectorAll(sel));
    const out: { ref: string; tag: string; type: string; name: string; value: string }[] = [];
    let i = 0;
    for (const el of els) {
      const r = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      if (r.width === 0 || r.height === 0 || style.visibility === "hidden" || style.display === "none") continue;
      const ref = `r${i++}`;
      el.setAttribute("data-klove-ref", ref);
      const e = el as HTMLInputElement;
      const name =
        el.getAttribute("aria-label") ||
        (el as HTMLElement).innerText?.trim().slice(0, 60) ||
        el.getAttribute("placeholder") ||
        el.getAttribute("name") ||
        el.getAttribute("title") ||
        "";
      out.push({ ref, tag: el.tagName.toLowerCase(), type: e.type || "", name, value: e.value || "" });
    }
    const text = (document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 1500);
    return { url: location.href, title: document.title, elements: out.slice(0, 80), text };
  });
  return JSON.stringify(data);
}
