import { createHash } from "node:crypto";
import { z } from "zod";
import type { BankRow } from "./parse";

const moneySchema = z.object({ amountMinor: z.number().int(), currency: z.string() });
const accountSchema = z.object({ id: z.string(), name: z.string(), institution: z.string(), kind: z.string(), balance: moneySchema, updatedAt: z.string() });
const transactionSchema = z.object({ id: z.string(), accountId: z.string(), description: z.string(), amount: moneySchema, bookedAt: z.string(), pending: z.boolean(), category: z.string().optional(), updatedAt: z.string() });
const syncSchema = z.object({ cursor: z.string(), changes: z.array(z.object({ entity: z.string(), entityId: z.string(), action: z.string(), value: z.unknown() })), acceptedMutationIds: z.array(z.string()) });
type Account = z.infer<typeof accountSchema>;
type Transaction = z.infer<typeof transactionSchema>;
export type Operation =
  | { mutationId: string; entity: "account" | "transaction"; action: "upsert"; entityId: string; value: Account | Transaction; baseVersion: 0 }
  | { mutationId: string; entity: "transaction"; action: "upsert"; entityId: string; value: { category: string }; baseVersion: 0 };
export type ImportFile = { section: "twd" | "foreign"; index: number; accountKey: string; suffix?: string; rows: BankRow[] };

function stableId(value: string): string {
  const hex = createHash("sha256").update(value).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function bankTransactionId(file: ImportFile, row: BankRow): string {
  return stableId(`scsb-transaction|${file.section}|${file.accountKey}|${JSON.stringify(row)}`);
}

export function bankAccountId(file: ImportFile): string {
  return stableId(`scsb-account|${file.section}|${file.accountKey}`);
}

export class Ledgerly {
  constructor(private readonly baseUrl: string, private readonly apiKey: string) {}

  private async request(path: string, body?: object): Promise<unknown> {
    const response = await fetch(new URL(path, this.baseUrl), {
      method: body ? "POST" : "GET",
      headers: { authorization: `Bearer ${this.apiKey}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) throw new Error(`Ledgerly ${path} failed with HTTP ${response.status}`);
    return response.json();
  }

  async accounts(): Promise<Account[]> {
    return z.array(accountSchema).parse(await this.request("/v1/accounts"));
  }

  async transactions(): Promise<Transaction[]> {
    const latest = new Map<string, Transaction>();
    let cursor = "0";
    while (true) {
      const response = syncSchema.parse(await this.request("/v1/sync", { cursor, operations: [], protocolVersion: 2 }));
      for (const change of response.changes) {
        if (change.entity !== "transaction") continue;
        if (change.action === "delete") latest.delete(change.entityId);
        else latest.set(change.entityId, transactionSchema.parse(change.value));
      }
      if (response.cursor === cursor || response.changes.length < 500) break;
      cursor = response.cursor;
    }
    return [...latest.values()];
  }

  async apply(operations: Operation[]): Promise<void> {
    for (let offset = 0; offset < operations.length; offset += 100) {
      const batch = operations.slice(offset, offset + 100);
      const result = syncSchema.parse(await this.request("/v1/sync", { cursor: "0", operations: batch, protocolVersion: 2 }));
      if (result.acceptedMutationIds.length !== batch.length || batch.some((item) => !result.acceptedMutationIds.includes(item.mutationId))) {
        throw new Error("Ledgerly rejected one or more import operations");
      }
    }
  }
}

function signature(accountId: string, date: string, amountMinor: number, currency: string): string {
  return `${accountId}|${date.slice(0, 10)}|${amountMinor}|${currency}`;
}

export function bankMemo(description: string): string {
  return description.split(" · ").at(-1)!.normalize("NFKC").replace(/\s+/g, "").toUpperCase();
}

function ledgerlyMinor(value: number, currency: BankRow["currency"]): number {
  return currency === "TWD" ? value * 100 : value;
}

export async function planImport(client: Ledgerly, files: ImportFile[], existingTwdIndex: number, existingTwdAccountId: string): Promise<{ operations: Operation[]; accountCount: number; transactionCount: number; matchedCount: number }> {
  const accounts = await client.accounts();
  const existing = accounts.filter((account) => account.id === existingTwdAccountId && account.institution === "上海商業儲蓄銀行" && account.balance.currency === "TWD");
  if (existing.length !== 1) throw new Error("Configured Ledgerly account ID is not the Shanghai Bank TWD account");
  const transactions = await client.transactions();
  const existingIds = new Set(transactions.map((transaction) => transaction.id));
  const operations: Operation[] = [];
  const pending = new Map<string, { row: BankRow; accountId: string; id: string }[]>();
  const knownAccounts = new Set(accounts.map((account) => account.id));
  const now = new Date().toISOString();

  for (const file of files) {
    const existingTwd = file.section === "twd" && file.index === existingTwdIndex;
    const accountId = existingTwd ? existing[0].id : bankAccountId(file);
    if (!knownAccounts.has(accountId)) {
      const currency = file.section === "twd" ? "TWD" : "USD";
      const account: Account = { id: accountId, name: file.section === "twd" ? `上海銀行帳戶（末兩碼 ${file.suffix ?? file.index}）` : `上海銀行外幣帳戶 ${file.index}（USD）`, institution: "上海商業儲蓄銀行", kind: "checking", balance: { amountMinor: file.rows.at(-1) ? ledgerlyMinor(file.rows.at(-1)!.balanceMinor, currency) : 0, currency }, updatedAt: now };
      operations.push({ mutationId: stableId(`scsb-create-account|${accountId}`), entity: "account", action: "upsert", entityId: accountId, value: account, baseVersion: 0 });
      knownAccounts.add(accountId);
    }
    for (const row of file.rows) {
      const id = bankTransactionId(file, row);
      const key = signature(accountId, row.date, ledgerlyMinor(row.amountMinor, row.currency), row.currency);
      const group = pending.get(key) ?? [];
      group.push({ row, accountId, id });
      pending.set(key, group);
    }
  }

  const existingBySignature = new Map<string, Transaction[]>();
  for (const transaction of transactions) {
    const key = signature(transaction.accountId, transaction.bookedAt, transaction.amount.amountMinor, transaction.amount.currency);
    const group = existingBySignature.get(key) ?? [];
    group.push(transaction);
    existingBySignature.set(key, group);
  }
  let matchedCount = 0;
  let transactionCount = 0;
  for (const [key, incoming] of pending) {
    const prior = existingBySignature.get(key) ?? [];
    for (const item of incoming) {
      if (existingIds.has(item.id)) {
        const present = prior.findIndex((transaction) => transaction.id === item.id);
        if (present >= 0) prior.splice(present, 1);
        matchedCount++;
        continue;
      }
      const exactDescription = prior.find((transaction) => bankMemo(transaction.description) === bankMemo(item.row.description));
      const unique = incoming.length === 1 && prior.length === 1 ? prior[0] : undefined;
      const match = exactDescription ?? unique;
      if (match) {
        matchedCount++;
        prior.splice(prior.indexOf(match), 1);
        continue;
      }
      const transaction: Transaction = { id: item.id, accountId: item.accountId, description: item.row.description, amount: { amountMinor: ledgerlyMinor(item.row.amountMinor, item.row.currency), currency: item.row.currency }, bookedAt: `${item.row.date}T12:00:00.000+08:00`, pending: false, updatedAt: now };
      operations.push({ mutationId: stableId(`scsb-create-transaction|${item.id}`), entity: "transaction", action: "upsert", entityId: item.id, value: transaction, baseVersion: 0 });
      transactionCount++;
    }
  }
  return { operations, accountCount: operations.filter((operation) => operation.entity === "account").length, transactionCount, matchedCount };
}
