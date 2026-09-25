import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { chromium, type Page, type Locator } from "playwright";
import { z } from "zod";
import { chooseReadOnlyAction, type Candidate } from "./models";
import { solveCaptcha } from "./captcha";
import { configuredSecrets } from "./secrets";
import { Ledgerly, planImport, type ImportFile } from "./ledgerly";
import { parseForeignXls, parseTwdPdf, twdAccountSuffix } from "./parse";
import { categorizeImportOperations } from "./categories";

const env = z.object({
  SCSB_ID: z.string().optional(),
  SCSB_USER_CODE: z.string().optional(),
  SCSB_PASSWORD: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_CAPTCHA_MODEL: z.string().default("openai/gpt-6-luna"),
  OPENROUTER_CATEGORY_MODEL: z.string().default("openai/gpt-6-luna"),
  TYPESAFE_API_KEY: z.string().optional(),
  TYPESAFE_MODEL: z.string().default("jev-latest"),
  SCSB_OUTPUT_DIR: z.string().default("./statements"),
  SCSB_HEADLESS: z.enum(["true", "false"]).default("false"),
  SCSB_BROWSER_CHANNEL: z.enum(["chrome", "chromium"]).default("chrome"),
  SCSB_LOGIN_TIMEOUT_MS: z.coerce.number().int().positive().default(180_000),
  LEDGERLY_API_URL: z.string().url().optional(),
  LEDGERLY_API_KEY: z.string().optional(),
  LEDGERLY_EXISTING_TWD_INDEX: z.coerce.number().int().positive().optional(),
  LEDGERLY_EXISTING_TWD_SUFFIX: z.string().regex(/^\d{2}$/).optional(),
  LEDGERLY_EXISTING_TWD_ACCOUNT_ID: z.string().uuid().optional(),
  LEDGERLY_IMPORT_DRY_RUN: z.enum(["true", "false"]).default("false"),
}).parse({ ...process.env, ...configuredSecrets() });

const BANK_URL = "https://ebank.scsb.com.tw?access=Y";
const SAFE_LABEL = /對帳單|帳單|交易明細|交易紀錄|帳戶|存匯|存款|餘額|下載|匯出|列印|statement|download|export|account|transaction|查詢/iu;
const FORBIDDEN_LABEL = /轉帳|轉入|轉出|匯款|繳費|付款|申購|贖回|買入|賣出|變更|設定|刪除|transfer|payment|trade|delete|settings/iu;

function safeLabel(value: string): string {
  return value.replace(/\d+/g, "[number]").replace(/\s+/g, " ").trim().slice(0, 100);
}

async function loggedIn(page: Page): Promise<boolean> {
  return !(await page.locator("#userId").isVisible().catch(() => false));
}

async function login(page: Page): Promise<void> {
  await page.goto(BANK_URL, { waitUntil: "domcontentloaded" });
  await page.locator("#userId").waitFor({ state: "visible", timeout: 30_000 }).catch(() => undefined);
  if (await loggedIn(page)) return;

  const { SCSB_ID: id, SCSB_USER_CODE: userCode, SCSB_PASSWORD: password } = env;
  if (id && userCode && password) {
    if (!env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY is required for automatic CAPTCHA entry");
    const captcha = page.locator(".ved_img");
    const code = await solveCaptcha(
      async () => {
        await captcha.waitFor({ state: "visible" });
        return captcha.screenshot();
      },
      async () => { await page.reload({ waitUntil: "domcontentloaded" }); },
      env.OPENROUTER_API_KEY,
      env.OPENROUTER_CAPTCHA_MODEL,
    );
    await page.locator("#userId").fill(id);
    await page.locator("#idNumber").fill(userCode);
    await page.locator("#pppd").fill(password);
    await page.locator("#verified").fill(code);
    await page.getByRole("button", { name: "登入", exact: true }).click();
  } else {
    console.log("Complete SCSB login in the opened browser. The automation will continue afterward.");
  }

  await page.locator("#userId").waitFor({ state: "hidden", timeout: env.SCSB_LOGIN_TIMEOUT_MS }).catch(() => {
    throw new Error("SCSB login did not complete. Check the browser for a CAPTCHA error or an additional bank verification step.");
  });
  await page.waitForLoadState("domcontentloaded").catch(() => undefined);
  await page.locator('button[data-menu-id="twde"]').waitFor({ state: "visible", timeout: 30_000 }).catch(() => {
    throw new Error("SCSB login form closed, but the account menu did not become available");
  });
}

async function candidates(page: Page): Promise<Candidate[]> {
  return page.locator("a, button, [role='button'], [role='menuitem']").evaluateAll((elements) => {
    let index = 0;
    const found: Candidate[] = [];
    for (const element of elements) {
      const html = element as HTMLElement;
      if (html.getBoundingClientRect().width === 0 || html.getBoundingClientRect().height === 0) continue;
      const text = (html.innerText || html.getAttribute("aria-label") || html.getAttribute("title") || "").replace(/\s+/g, " ").trim();
      if (!text || text.length > 100) continue;
      const id = `scsb-option-${index++}`;
      html.setAttribute("data-scsb-option", id);
      found.push({ id, text });
    }
    return found;
  }).then((items) => items
    .map((item) => ({ id: item.id, text: safeLabel(item.text) }))
    .filter((item) => SAFE_LABEL.test(item.text) && !FORBIDDEN_LABEL.test(item.text))
    .slice(0, 40));
}

async function clickKnownOrJev(page: Page, target: Locator, goal: string): Promise<void> {
  if (!page.url().startsWith("https://ebank.scsb.com.tw/")) throw new Error("Navigation left the SCSB eBank origin");
  try {
    await target.click({ timeout: 6_000 });
    return;
  } catch (error) {
    if (!env.TYPESAFE_API_KEY) throw new Error(`Playwright could not find ${goal}; configure TYPESAFE_API_KEY for the Jev fallback`, { cause: error });
  }
  const options = await candidates(page);
  const id = await chooseReadOnlyAction(options, `Find ${goal} in the SCSB read-only menu`, env.TYPESAFE_API_KEY, env.TYPESAFE_MODEL);
  if (!id) throw new Error(`Jev could not safely find ${goal}`);
  await page.locator(`[data-scsb-option="${id}"]`).click({ timeout: 6_000 });
}

type Section = { name: "twd" | "foreign"; route: string; menu: readonly string[]; queryPath: string; format: "PDF" | "EXCEL"; extension: "pdf" | "xls" };
const SECTIONS: readonly Section[] = [
  { name: "twd", route: "#/twde/qr/01/01", menu: ["twde", "twdeqr", "twdeqr01"], queryPath: "/twde/twdeqr01/query", format: "PDF", extension: "pdf" },
  { name: "foreign", route: "#/fode/qr/01/01", menu: ["fode", "fodeqr", "fodeqr01"], queryPath: "/fode/fodeqr01/query", format: "EXCEL", extension: "xls" },
];

async function openHistory(page: Page, section: Section): Promise<void> {
  if (!page.url().includes(section.route)) {
    for (const id of section.menu) {
      await clickKnownOrJev(page, page.locator(`button[data-menu-id="${id}"]`), `${section.name} account inquiry menu`);
    }
  }
  await page.waitForURL((url) => url.href.includes(section.route), { timeout: 30_000 });
  await page.waitForFunction(() => {
    const account = document.querySelector<HTMLSelectElement>("#account");
    return Boolean(account && account.getBoundingClientRect().width > 0 && !account.disabled && account.options.length > 1);
  }, undefined, { timeout: 45_000 }).catch(() => {
    throw new Error(`SCSB ${section.name} account selector did not become ready`);
  });
}

function lastThirtyDays(): { start: string; end: string; slug: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  const day = Number(parts.find((part) => part.type === "day")?.value);
  const end = new Date(Date.UTC(year, month - 1, day));
  const start = new Date(end.getTime() - 29 * 24 * 60 * 60 * 1000);
  const format = (date: Date) => `${date.getUTCFullYear()}/${String(date.getUTCMonth() + 1).padStart(2, "0")}/${String(date.getUTCDate()).padStart(2, "0")}`;
  return { start: format(start), end: format(end), slug: `${format(start).replaceAll("/", "")}-${format(end).replaceAll("/", "")}` };
}

async function downloadStatement(page: Page, outputDir: string, accountIndex: number, period: ReturnType<typeof lastThirtyDays>, section: Section): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt++) {
    await clickKnownOrJev(page, page.getByRole("button", { name: "下載", exact: true }), "下載");
    const downloadPromise = page.waitForEvent("download", { timeout: 90_000 }).catch(() => null);
    await clickKnownOrJev(page, page.locator(`a.dropdown-item[value="${section.format}"]`), `${section.format}檔`);
    const download = await downloadPromise;
    if (!download) continue;
    const destination = resolve(outputDir, `scsb-${section.name}-account-${accountIndex}-${period.slug}-${Date.now()}.${section.extension}`);
    try {
      await download.saveAs(destination);
    } catch (error) {
      if (!download.url().startsWith("blob:")) throw error;
      const bytes = await page.evaluate(async (url) => Array.from(new Uint8Array(await (await fetch(url)).arrayBuffer())), download.url());
      await writeFile(destination, Buffer.from(bytes), { mode: 0o600 });
    }
    await chmod(destination, 0o600);
    const header = (await readFile(destination)).subarray(0, 8);
    const valid = section.format === "PDF"
      ? header.subarray(0, 5).equals(Buffer.from("%PDF-"))
      : header.equals(Buffer.from("d0cf11e0a1b11ae1", "hex"));
    if (!valid) {
      throw new Error(`SCSB returned an unexpected ${section.format} file for ${section.name} account ${accountIndex}`);
    }
    return destination;
  }
  throw new Error(`SCSB did not deliver a ${section.format} download for ${section.name} account ${accountIndex}`);
}

async function downloadAllStatements(page: Page, outputDir: string): Promise<{ files: ImportFile[]; accountOrder: Record<string, string> }> {
  const period = lastThirtyDays();
  const saved: ImportFile[] = [];
  const accountOrder: Record<string, string> = {};
  for (const section of SECTIONS) {
    await openHistory(page, section);
    const accounts = await page.locator("#account option").evaluateAll((options) => options
      .map((option) => (option as HTMLOptionElement).value)
      .filter((value) => value.trim().length > 0));
    for (const [index, value] of accounts.entries()) {
      accountOrder[`${section.name}-${index + 1}`] = createHash("sha256").update(value).digest("hex");
      await page.locator("#account").selectOption(value);
      await page.locator("#radio3").check();
      const dates = page.locator('input[placeholder="請輸入日期"]');
      if (await dates.count() !== 2) throw new Error("SCSB changed the date fields on its transaction inquiry page");
      await dates.nth(0).fill(period.start);
      await dates.nth(1).fill(period.end);
      const responsePromise = page.waitForResponse((response) => response.url().includes(section.queryPath) && response.request().method() === "POST", { timeout: 20_000 });
      await page.getByRole("button", { name: "確認", exact: true }).click();
      const response = await responsePromise;
      if (!response.ok()) throw new Error(`SCSB query failed for ${section.name} account ${index + 1} (${response.status()})`);
      await page.getByRole("button", { name: "下載", exact: true }).waitFor({ state: "visible", timeout: 10_000 });
      const destination = await downloadStatement(page, outputDir, index + 1, period, section);
      const suffix = section.name === "twd" ? await twdAccountSuffix(destination) : undefined;
      if (section.name === "twd" && index + 1 === env.LEDGERLY_EXISTING_TWD_INDEX && env.LEDGERLY_EXISTING_TWD_SUFFIX) {
        if (suffix !== env.LEDGERLY_EXISTING_TWD_SUFFIX) throw new Error("SCSB existing Ledgerly account no longer matches the expected bank account suffix");
      }
      const rows = section.name === "twd" ? await parseTwdPdf(destination) : await parseForeignXls(destination);
      saved.push({ section: section.name, index: index + 1, accountKey: String(index + 1), suffix, rows });
      console.log(`Saved ${section.name} account ${index + 1} of ${accounts.length}: ${destination}`);
    }
  }
  return { files: saved, accountOrder };
}

async function verifyAccountOrder(outputDir: string, current: Record<string, string>): Promise<void> {
  const path = resolve(outputDir, ".account-order.json");
  let previous: Record<string, string> | undefined;
  try {
    previous = JSON.parse(await readFile(path, "utf8")) as Record<string, string>;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  if (previous && JSON.stringify(previous) !== JSON.stringify(current)) throw new Error("SCSB account order changed; review the Ledgerly account mapping before importing");
  if (!previous) await writeFile(path, JSON.stringify(current), { mode: 0o600, flag: "wx" });
}

async function main(): Promise<void> {
  if (env.SCSB_HEADLESS === "true" && !(env.SCSB_ID && env.SCSB_USER_CODE && env.SCSB_PASSWORD)) {
    throw new Error("Headless mode requires SCSB_ID, SCSB_USER_CODE, and SCSB_PASSWORD");
  }
  const outputDir = resolve(env.SCSB_OUTPUT_DIR);
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  const browser = await chromium.launch({
    channel: env.SCSB_BROWSER_CHANNEL === "chrome" ? "chrome" : undefined,
    headless: env.SCSB_HEADLESS === "true",
  });
  const context = await browser.newContext({
    acceptDownloads: true,
    locale: "zh-TW",
  });
  const page = await context.newPage();
  try {
    await login(page);
    const { files: saved, accountOrder } = await downloadAllStatements(page, outputDir);
    console.log(`Saved ${saved.length} transaction-history file(s)`);
    if (env.LEDGERLY_API_URL || env.LEDGERLY_API_KEY) {
      if (!env.LEDGERLY_API_URL || !env.LEDGERLY_API_KEY || !env.LEDGERLY_EXISTING_TWD_INDEX || !env.LEDGERLY_EXISTING_TWD_SUFFIX || !env.LEDGERLY_EXISTING_TWD_ACCOUNT_ID) throw new Error("Ledgerly import requires API URL, API key, and existing TWD account mapping");
      await verifyAccountOrder(outputDir, accountOrder);
      const client = new Ledgerly(env.LEDGERLY_API_URL, env.LEDGERLY_API_KEY);
      const plan = await planImport(client, saved, env.LEDGERLY_EXISTING_TWD_INDEX, env.LEDGERLY_EXISTING_TWD_ACCOUNT_ID);
      console.log(`Ledgerly import: ${plan.accountCount} accounts, ${plan.transactionCount} new transactions, ${plan.matchedCount} existing matches`);
      if (env.LEDGERLY_IMPORT_DRY_RUN !== "true") {
        if (env.OPENROUTER_API_KEY && plan.transactionCount > 0) {
          try {
            const count = await categorizeImportOperations(plan.operations, env.OPENROUTER_API_KEY, env.OPENROUTER_CATEGORY_MODEL);
            console.log(`Categorized ${count} new Ledgerly transaction(s)`);
          } catch {
            console.warn("OpenRouter categorization failed; importing transactions without categories");
          }
        }
        await client.apply(plan.operations);
        console.log("Ledgerly import completed");
      }
    }
  } finally {
    await browser.close();
  }
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
