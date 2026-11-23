/**
 * Headless smoke check of the web app against live Testnet: every page renders, the Overview reads
 * the registries, the pool and the oracle, nothing logs an error, and the phone layout does not
 * scroll sideways. Wallet flows need a real wallet and are not covered here.
 *
 *   pnpm --filter @sigmax/stellar-web dev   (in another terminal)
 *   pnpm smoke:web
 *
 *   WEB_URL           default http://localhost:5174
 *   CHROMIUM_PATH     browser binary (default: Playwright's cached headless shell)
 *   SCREENSHOT_DIR    where to write page screenshots (default: no screenshots)
 */

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { chromium } from "playwright-core";

const URL = process.env.WEB_URL ?? "http://localhost:5174";

function cachedHeadlessShell(): string | undefined {
  const root = join(homedir(), ".cache", "ms-playwright");
  if (!existsSync(root)) return undefined;
  const dir = readdirSync(root)
    .filter((d) => d.startsWith("chromium_headless_shell-"))
    .sort()
    .pop();
  const bin = dir && join(root, dir, "chrome-headless-shell-linux64", "chrome-headless-shell");
  return bin && existsSync(bin) ? bin : undefined;
}

async function main() {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? cachedHeadlessShell() });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  const shot = async (name: string) => {
    if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.SCREENSHOT_DIR, `${name}.png`), fullPage: true });
  };

  await page.goto(`${URL}/#overview`);
  await page.locator(".row-k", { hasText: /^Reflector price$/ }).waitFor({ timeout: 90_000 });
  await page.waitForTimeout(1_000);
  await shot("overview");
  const rows = await page.locator(".row").allInnerTexts();
  console.log(`overview:\n${rows.map((r) => `  ${r.replace(/\n/g, ": ")}`).join("\n")}`);

  for (const tab of ["leader", "follower"]) {
    await page.goto(`${URL}/#${tab}`);
    await page.locator("h2").first().waitFor({ timeout: 30_000 });
    await shot(tab);
    console.log(`${tab}: ${(await page.locator("h2").allInnerTexts()).join(" / ")}`);
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${URL}/#overview`);
  await page.locator(".row-k", { hasText: /^Reflector price$/ }).waitFor({ timeout: 90_000 });
  await shot("overview-phone");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  await browser.close();

  console.log(`phone layout scrolls sideways: ${overflow}`);
  console.log(`console errors: ${errors.length ? `\n  ${errors.join("\n  ")}` : "none"}`);
  if (overflow || errors.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
