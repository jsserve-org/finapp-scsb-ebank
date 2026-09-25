import { afterEach, expect, it, mock } from "bun:test";
import { solveCaptcha } from "./captcha";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

it("refreshes an unreadable image before returning a CAPTCHA code", async () => {
  let calls = 0;
  let refreshes = 0;
  globalThis.fetch = Object.assign(mock(async () => Response.json({ choices: [{ message: { content: ++calls === 1 ? "UNKNOWN" : "12345" } }] })), { preconnect: originalFetch.preconnect });
  const code = await solveCaptcha(async () => Buffer.from("image"), async () => { refreshes++; }, "test-key", "openai/gpt-6-luna");
  expect(code).toBe("12345");
  expect(calls).toBe(2);
  expect(refreshes).toBe(1);
});
