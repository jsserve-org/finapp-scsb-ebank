import { chromium } from "playwright";
import { configuredSecrets } from "./secrets";
import { solveCaptcha } from "./captcha";

const key = configuredSecrets().OPENROUTER_API_KEY ?? process.env.OPENROUTER_API_KEY;
if (!key) throw new Error("OPENROUTER_API_KEY is required");

const browser = await chromium.launch({
  channel: process.env.SCSB_BROWSER_CHANNEL === "chromium" ? undefined : "chrome",
  headless: true,
});
try {
  const page = await browser.newPage({ locale: "zh-TW" });
  await page.goto("https://ebank.scsb.com.tw?access=Y", { waitUntil: "domcontentloaded" });
  const answer = await solveCaptcha(
    () => page.locator(".ved_img").screenshot(),
    async () => { await page.reload({ waitUntil: "domcontentloaded" }); },
    key,
    process.env.OPENROUTER_CAPTCHA_MODEL ?? "openai/gpt-6-luna",
  );
  console.log(`Headless SCSB CAPTCHA check passed: image captured and ${answer.length}-digit response returned`);
} finally {
  await browser.close();
}
