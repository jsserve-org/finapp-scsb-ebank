import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { configuredSecrets } from "./secrets";
import { Ledgerly, bankTransactionId, type ImportFile, type Operation } from "./ledgerly";
import { parseForeignXls, parseTwdPdf } from "./parse";
import { suggestCategories } from "./categories";

const secrets = configuredSecrets();
if (!secrets.LEDGERLY_API_URL || !secrets.LEDGERLY_API_KEY || !secrets.OPENROUTER_API_KEY) throw new Error("Ledgerly or OpenRouter configuration is missing");
const client = new Ledgerly(secrets.LEDGERLY_API_URL, secrets.LEDGERLY_API_KEY);
const directory = resolve(process.env.SCSB_OUTPUT_DIR ?? "./statements");
const latest = new Map<string, string>();
for (const name of await readdir(directory)) {
  const match = name.match(/^scsb-(twd|foreign)-account-(\d+)-\d{8}-\d{8}-\d+\.(pdf|xls)$/);
  if (!match) continue;
  const key = `${match[1]}-${match[2]}`;
  if (!latest.has(key) || name > latest.get(key)!) latest.set(key, name);
}
const ids = new Set<string>();
for (const [key, name] of latest) {
  const [section, indexText] = key.split("-") as ["twd" | "foreign", string];
  const path = resolve(directory, name);
  const rows = section === "twd" ? await parseTwdPdf(path) : await parseForeignXls(path);
  const file: ImportFile = { section, index: Number(indexText), accountKey: indexText, rows };
  for (const row of rows) ids.add(bankTransactionId(file, row));
}
const pending = (await client.transactions()).filter((transaction) => ids.has(transaction.id) && !transaction.category);
console.log(`Uncategorized SCSB imports: ${pending.length}`);
if (pending.length) {
  const suggestions = await suggestCategories(pending.map((transaction) => ({ id: transaction.id, description: transaction.description, amountMinor: transaction.amount.amountMinor, currency: transaction.amount.currency })), secrets.OPENROUTER_API_KEY, process.env.OPENROUTER_CATEGORY_MODEL ?? "openai/gpt-6-luna");
  console.log(`OpenRouter category suggestions: ${suggestions.size}`);
  if (process.argv.includes("--apply")) {
    const operations: Operation[] = pending.flatMap((transaction) => {
      const category = suggestions.get(transaction.id);
      return category ? [{ mutationId: crypto.randomUUID(), entity: "transaction", action: "upsert", entityId: transaction.id, value: { category }, baseVersion: 0 }] : [];
    });
    await client.apply(operations);
    console.log("Category suggestions applied");
  } else {
    console.log("Dry run only. Pass --apply to categorize.");
  }
}
