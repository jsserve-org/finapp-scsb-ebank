import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

const storedSecrets = z.object({
  SCSB_ID: z.string(),
  SCSB_USER_CODE: z.string(),
  SCSB_PASSWORD: z.string(),
  OPENROUTER_API_KEY: z.string(),
  TYPESAFE_API_KEY: z.string(),
  LEDGERLY_API_URL: z.string().url().optional(),
  LEDGERLY_API_KEY: z.string().optional(),
});

export function configuredSecrets(): Partial<z.infer<typeof storedSecrets>> {
  try {
    return storedSecrets.parse(JSON.parse(readFileSync(resolve(import.meta.dir, "../credentials.json"), "utf8")));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
    throw new Error("Private SCSB credentials file is invalid", { cause: error });
  }
}
