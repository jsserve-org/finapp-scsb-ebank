import { z } from "zod";

const openRouterResponse = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.union([z.string(), z.array(z.object({ type: z.string(), text: z.string().optional() }))]) }) })).min(1),
});

export class CaptchaUnreadableError extends Error {}

export async function readCaptcha(image: Buffer, apiKey: string, model: string): Promise<string> {
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      temperature: 0,
      messages: [{ role: "user", content: [
        { type: "text", text: "Read the five digits in this image. Reply with exactly five ASCII digits and no other text. If unreadable, reply UNKNOWN." },
        { type: "image_url", image_url: { url: `data:image/png;base64,${image.toString("base64")}` } },
      ] }],
    }),
  });
  if (!response.ok) throw new Error(`OpenRouter CAPTCHA request failed (${response.status})`);
  const parsed = openRouterResponse.parse(await response.json());
  const content = parsed.choices[0]!.message.content;
  const answer = typeof content === "string" ? content : content.map((part) => part.text ?? "").join(" ");
  const match = answer.trim().match(/^\d{5}$/);
  if (!match) throw new CaptchaUnreadableError("Luna could not confidently read the CAPTCHA after three images");
  return match[0];
}

const jevResponse = z.object({
  answers: z.object({ next: z.object({ type: z.literal("choice"), choice: z.string(), confidence: z.number() }) }),
});

export type Candidate = { id: string; text: string };

export async function chooseReadOnlyAction(
  candidates: Candidate[],
  state: string,
  apiKey: string,
  model: string,
): Promise<string | null> {
  if (candidates.length === 0) return null;
  const criteria = Object.fromEntries([
    ...candidates.map((candidate) => [candidate.id, candidate.text]),
    ["stop", "None of these controls safely lead toward downloading a bank statement"],
  ]);
  const response = await fetch("https://api.typesafe.ai/v1/systemone", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      state: { goal: "Find and download an existing bank statement or account transaction statement", page: state, candidates },
      questions: {
        next: {
          type: "choice",
          instructions: "Which listed read-only navigation or statement-download control should be clicked next? Choose stop when none is appropriate. Never choose payment, transfer, investment, settings, or account changes.",
          criteria,
        },
      },
    }),
  });
  if (!response.ok) throw new Error(`TypeSafe Jev request failed (${response.status})`);
  const result = jevResponse.parse(await response.json()).answers.next;
  if (result.choice === "stop" || result.confidence < 0.65) return null;
  return candidates.some((candidate) => candidate.id === result.choice) ? result.choice : null;
}
