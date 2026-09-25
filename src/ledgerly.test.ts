import { describe, expect, test } from "bun:test";
import { Ledgerly, bankTransactionId, planImport, type ImportFile } from "./ledgerly";

const existingAccount = {
  id: "existing-shanghai-account",
  name: "銀行帳號",
  institution: "上海商業儲蓄銀行",
  kind: "checking",
  balance: { amountMinor: 0, currency: "TWD" },
  updatedAt: "2026-09-25T00:00:00.000Z",
};

class StubLedgerly extends Ledgerly {
  constructor(private readonly prior: Awaited<ReturnType<Ledgerly["transactions"]>> = []) {
    super("http://127.0.0.1/", "unused");
  }
  override async accounts() { return [existingAccount]; }
  override async transactions() { return this.prior; }
}

const row = { date: "2026-09-25", description: "ATM transfer", amountMinor: 200, currency: "TWD" as const, balanceMinor: 500, occurrence: 1 };
const file: ImportFile = { section: "twd", index: 1, accountKey: "1", suffix: "65", rows: [row] };

describe("Ledgerly SCSB import", () => {
  test("converts TWD whole units to Ledgerly minor units", async () => {
    const plan = await planImport(new StubLedgerly(), [file], 2, existingAccount.id);
    expect(plan.accountCount).toBe(1);
    expect(plan.transactionCount).toBe(1);
    const accountOperation = plan.operations.find((item) => item.entity === "account");
    const transactionOperation = plan.operations.find((item) => item.entity === "transaction");
    const account = accountOperation?.action === "upsert" ? accountOperation.value : undefined;
    const transaction = transactionOperation?.action === "upsert" ? transactionOperation.value : undefined;
    expect(account && "balance" in account ? account.balance.amountMinor : null).toBe(50_000);
    expect(transaction && "amount" in transaction ? transaction.amount.amountMinor : null).toBe(20_000);
  });

  test("matches an existing transaction and preserves its description", async () => {
    const prior = [{ id: "manual-entry", accountId: existingAccount.id, description: "My own label", amount: { amountMinor: 20_000, currency: "TWD" }, bookedAt: "2026-09-25T00:00:00.000+08:00", pending: false, updatedAt: "2026-09-25T00:00:00.000Z" }];
    const plan = await planImport(new StubLedgerly(prior), [{ ...file, index: 2, accountKey: "2", suffix: "55" }], 2, existingAccount.id);
    expect(plan.transactionCount).toBe(0);
    expect(plan.matchedCount).toBe(1);
  });

  test("matches the bank memo when another transaction has the same date and amount", async () => {
    const prior = [
      { id: "original", accountId: existingAccount.id, description: "NAME-CHEAP.COM", amount: { amountMinor: 20_000, currency: "TWD" }, bookedAt: "2026-09-25T00:00:00.000+08:00", pending: false, updatedAt: "2026-09-25T00:00:00.000Z" },
      { id: "other", accountId: existingAccount.id, description: "Different merchant", amount: { amountMinor: 20_000, currency: "TWD" }, bookedAt: "2026-09-25T00:00:00.000+08:00", pending: false, updatedAt: "2026-09-25T00:00:00.000Z" },
    ];
    const prefixed = { ...file, index: 2, accountKey: "2", suffix: "55", rows: [{ ...row, description: "刷卡交易 · NAME-CHEAP.COM" }] };
    const plan = await planImport(new StubLedgerly(prior), [prefixed], 2, existingAccount.id);
    expect(plan.transactionCount).toBe(0);
    expect(plan.matchedCount).toBe(1);
  });

  test("does not reimport a rolling statement row", async () => {
    const first = await planImport(new StubLedgerly(), [{ ...file, index: 2, accountKey: "2", suffix: "55" }], 2, existingAccount.id);
    const inserted = first.operations.find((operation) => operation.entity === "transaction");
    if (!inserted || !("amount" in inserted.value)) throw new Error("Expected an inserted transaction");
    const next = await planImport(new StubLedgerly([inserted.value]), [{ ...file, index: 2, accountKey: "2", suffix: "55" }], 2, existingAccount.id);
    expect(next.transactionCount).toBe(0);
    expect(next.matchedCount).toBe(1);
    expect(bankTransactionId(file, row)).toBe(bankTransactionId({ ...file, rows: [row] }, row));
  });

  test("keeps an existing categorized Namecheap entry on a repeat download", async () => {
    const namecheap = { ...row, description: "刷卡交易 · NAME-CHEAP.COM", amountMinor: 478 };
    const prior = [{ id: "existing-namecheap", accountId: existingAccount.id, description: "NAME-CHEAP.COM", amount: { amountMinor: 47_800, currency: "TWD" }, bookedAt: "2026-09-25T09:00:00.000+08:00", pending: false, category: "Shopping", updatedAt: "2026-09-25T00:00:00.000Z" }];
    const statement: ImportFile = { ...file, index: 2, accountKey: "2", suffix: "55", rows: [namecheap] };
    const first = await planImport(new StubLedgerly(prior), [statement], 2, existingAccount.id);
    const second = await planImport(new StubLedgerly(prior), [statement], 2, existingAccount.id);
    expect(first.transactionCount).toBe(0);
    expect(second.transactionCount).toBe(0);
    expect(prior[0].category).toBe("Shopping");
  });
});
