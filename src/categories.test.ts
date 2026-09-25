import { expect, spyOn, test } from "bun:test";
import { knownCategory, suggestCategories } from "./categories";

test("SCSB foreign currency service fees are categorized without an AI request", async () => {
  expect(knownCategory("外幣服務費－OP")).toBe("Fees");
  expect(knownCategory("外幣服務費-PA")).toBe("Fees");
  expect(knownCategory("外幣服務費用商品")).toBeUndefined();

  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(Object.assign(
    () => { throw new Error("Unexpected OpenRouter request"); },
    { preconnect: globalThis.fetch.preconnect },
  ));
  try {
    const result = await suggestCategories([
      { id: "fee", description: "外幣服務費－OP", amountMinor: -800, currency: "TWD" },
    ], "unused", "unused");
    expect(result.get("fee")).toBe("Fees");
  } finally {
    fetchSpy.mockRestore();
  }
});
