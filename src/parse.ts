import { readFile } from "node:fs/promises";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import XLSX from "xlsx";

export type BankRow = { date: string; description: string; amountMinor: number; currency: "TWD" | "USD"; balanceMinor: number; occurrence: number };

function dateValue(raw: string): string {
  const match = raw.trim().match(/^(\d{4})[\/.\-](\d{1,2})[\/.\-](\d{1,2})$/);
  if (!match) throw new Error("Unrecognized SCSB transaction date");
  return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
}

function money(raw: string, scale: number): number {
  const cleaned = raw.replaceAll(",", "").trim();
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(cleaned)) throw new Error("Unrecognized SCSB transaction amount");
  const value = Math.round(Number(cleaned) * scale);
  if (!Number.isSafeInteger(value)) throw new Error("SCSB transaction amount is out of range");
  return value;
}

function finish(rows: Omit<BankRow, "occurrence">[]): BankRow[] {
  const seen = new Map<string, number>();
  return rows.map((row) => {
    const key = JSON.stringify(row);
    const occurrence = (seen.get(key) ?? 0) + 1;
    seen.set(key, occurrence);
    return { ...row, occurrence };
  });
}

export async function parseTwdPdf(path: string): Promise<BankRow[]> {
  const document = await getDocument({ data: new Uint8Array(await readFile(path)), useSystemFonts: true }).promise;
  const rows: Omit<BankRow, "occurrence">[] = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    const lines = new Map<number, { x: number; text: string }[]>();
    for (const item of content.items) {
      if (!("str" in item) || !item.str.trim()) continue;
      const y = Math.round(item.transform[5]);
      const line = lines.get(y) ?? [];
      line.push({ x: item.transform[4], text: item.str.trim() });
      lines.set(y, line);
    }
    for (const line of [...lines.entries()].sort((a, b) => b[0] - a[0]).map(([, items]) => items.sort((a, b) => a.x - b.x))) {
      const date = line.find((item) => item.x < 100 && /^\d{4}\/\d{2}\/\d{2}$/.test(item.text))?.text;
      if (!date) continue;
      const column = (min: number, max: number) => line.filter((item) => item.x >= min && item.x < max).map((item) => item.text).join("").trim();
      const debit = column(190, 260);
      const credit = column(260, 340);
      if (Boolean(debit) === Boolean(credit)) throw new Error("SCSB PDF row has ambiguous debit and credit columns");
      const summary = column(100, 190);
      const memo = column(405, Infinity);
      const description = [summary, memo].filter(Boolean).join(" · ");
      if (!description) throw new Error("SCSB PDF row has no description");
      rows.push({ date: dateValue(date), description, amountMinor: credit ? money(credit, 1) : -money(debit, 1), currency: "TWD", balanceMinor: money(column(340, 405), 1) });
    }
  }
  return finish(rows);
}

export async function twdAccountSuffix(path: string): Promise<string> {
  const document = await getDocument({ data: new Uint8Array(await readFile(path)), useSystemFonts: true }).promise;
  const page = await document.getPage(1);
  const content = await page.getTextContent();
  const account = content.items.filter((item) => "str" in item).map((item) => item.str).find((value) => /\*+\d{2}$/.test(value));
  const suffix = account?.match(/(\d{2})$/)?.[1];
  if (!suffix) throw new Error("SCSB PDF account suffix is missing");
  return suffix;
}

export async function parseForeignXls(path: string): Promise<BankRow[]> {
  const workbook = XLSX.readFile(path);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) throw new Error("SCSB Excel file has no worksheet");
  const table = XLSX.utils.sheet_to_json<(string | number)[]>(sheet, { header: 1, defval: "" });
  const headings = (table[0] ?? []).map(String);
  if (headings.slice(0, 6).join("|") !== "日期|摘要|支出金額|存入金額|餘額|備註") throw new Error("SCSB Excel columns changed");
  const rows: Omit<BankRow, "occurrence">[] = [];
  for (const cells of table.slice(1)) {
    if (!String(cells[0] ?? "").trim()) continue;
    const date = dateValue(String(cells[0]));
    const debit = String(cells[2] ?? "").trim();
    const credit = String(cells[3] ?? "").trim();
    if (Boolean(debit) === Boolean(credit)) throw new Error("SCSB Excel row has ambiguous debit and credit columns");
    const description = [cells[1], cells[5]].map((value) => String(value ?? "").trim()).filter(Boolean).join(" · ");
    if (!description) throw new Error("SCSB Excel row has no description");
    rows.push({ date, description, amountMinor: credit ? money(credit, 100) : -money(debit, 100), currency: "USD", balanceMinor: money(String(cells[4]), 100) });
  }
  return finish(rows);
}
