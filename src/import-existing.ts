import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { configuredSecrets } from "./secrets";
import { Ledgerly, planImport, type ImportFile } from "./ledgerly";
import { parseForeignXls, parseTwdPdf, twdAccountSuffix } from "./parse";
import { categorizeImportOperations } from "./categories";

const config = z.object({
  SCSB_OUTPUT_DIR: z.string().default("./statements"),
  LEDGERLY_API_URL: z.string().url(),
  LEDGERLY_API_KEY: z.string().min(1),
  LEDGERLY_EXISTING_TWD_INDEX: z.coerce.number().int().positive(),
  LEDGERLY_EXISTING_TWD_SUFFIX: z.string().regex(/^\d{2}$/),
  LEDGERLY_EXISTING_TWD_ACCOUNT_ID: z.string().uuid(),
}).parse({ ...process.env, ...configuredSecrets() });

const directory = resolve(config.SCSB_OUTPUT_DIR);
const latest = new Map<string, string>();
for (const filename of await readdir(directory)) {
  const match = filename.match(/^scsb-(twd|foreign)-account-(\d+)-\d{8}-\d{8}-(\d+)\.(pdf|xls)$/);
  if (!match) continue;
  const key = `${match[1]}-${match[2]}`;
  if (!latest.has(key) || Number(match[3]) > Number(latest.get(key)?.match(/-(\d+)\.(?:pdf|xls)$/)?.[1] ?? 0)) latest.set(key, filename);
}
const files: ImportFile[] = [];
for (const [key, filename] of latest) {
  const [section, indexText] = key.split("-") as ["twd" | "foreign", string];
  const path = resolve(directory, filename);
  const suffix = section === "twd" ? await twdAccountSuffix(path) : undefined;
  if (section === "twd" && Number(indexText) === config.LEDGERLY_EXISTING_TWD_INDEX && suffix !== config.LEDGERLY_EXISTING_TWD_SUFFIX) {
    throw new Error("SCSB existing Ledgerly account does not match the expected bank account suffix");
  }
  files.push({ section, index: Number(indexText), accountKey: indexText, suffix, rows: section === "twd" ? await parseTwdPdf(path) : await parseForeignXls(path) });
}
if (files.length === 0) throw new Error("No downloaded SCSB transaction-history files were found");
const client = new Ledgerly(config.LEDGERLY_API_URL, config.LEDGERLY_API_KEY);
const plan = await planImport(client, files, config.LEDGERLY_EXISTING_TWD_INDEX, config.LEDGERLY_EXISTING_TWD_ACCOUNT_ID);
console.log(`Ledgerly import: ${plan.accountCount} accounts, ${plan.transactionCount} new transactions, ${plan.matchedCount} existing matches`);
if (process.argv.includes("--apply")) {
  const secrets = configuredSecrets();
  if (secrets.OPENROUTER_API_KEY && plan.transactionCount > 0) {
    try {
      const count = await categorizeImportOperations(plan.operations, secrets.OPENROUTER_API_KEY, process.env.OPENROUTER_CATEGORY_MODEL ?? "openai/gpt-6-luna");
      console.log(`Categorized ${count} new Ledgerly transaction(s)`);
    } catch {
      console.warn("OpenRouter categorization failed; importing transactions without categories");
    }
  }
  await client.apply(plan.operations);
  console.log("Ledgerly import completed");
} else {
  console.log("Dry run only. Pass --apply to import.");
}
