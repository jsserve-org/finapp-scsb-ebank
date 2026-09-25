import { afterEach, describe, expect, it, mock } from "bun:test";
import { chooseReadOnlyAction, readCaptcha } from "./models";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe("model routing", () => {
  it("sends only the CAPTCHA image to the configured OpenRouter model", async () => {
    let endpoint = "";
    let body = "";
    globalThis.fetch = Object.assign(mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      endpoint = String(input);
      body = String(init?.body);
      return Response.json({ choices: [{ message: { content: "12345" } }] });
    }), { preconnect: originalFetch.preconnect });
    expect(await readCaptcha(Buffer.from("image"), "test-key", "openai/gpt-6-luna")).toBe("12345");
    expect(endpoint).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(body).toContain("openai/gpt-6-luna");
    expect(body).toContain(Buffer.from("image").toString("base64"));
  });

  it("uses the official Jev endpoint and stops on low confidence", async () => {
    let endpoint = "";
    globalThis.fetch = Object.assign(mock(async (input: RequestInfo | URL) => {
      endpoint = String(input);
      return Response.json({ answers: { next: { type: "choice", choice: "option-1", confidence: 0.4 } } });
    }), { preconnect: originalFetch.preconnect });
    expect(await chooseReadOnlyAction([{ id: "option-1", text: "對帳單" }], "read-only navigation", "test-key", "jev-latest")).toBeNull();
    expect(endpoint).toBe("https://api.typesafe.ai/v1/systemone");
  });
});
