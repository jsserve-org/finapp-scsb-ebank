import { configuredSecrets } from "./secrets";

const config: Record<string, string | undefined> = { ...process.env, ...configuredSecrets() };
const required = ["SCSB_ID", "SCSB_USER_CODE", "SCSB_PASSWORD", "OPENROUTER_API_KEY", "TYPESAFE_API_KEY", "LEDGERLY_API_URL", "LEDGERLY_API_KEY", "LEDGERLY_EXISTING_TWD_INDEX", "LEDGERLY_EXISTING_TWD_SUFFIX", "LEDGERLY_EXISTING_TWD_ACCOUNT_ID"] as const;
const missing: string[] = required.filter((name) => !config[name]?.trim());
if (config.SCSB_HEADLESS !== "true") missing.push("SCSB_HEADLESS=true");

if (missing.length > 0) {
  console.error(`Unattended SCSB run needs: ${missing.join(", ")}. Use the one-time setup portal or configure the private files locally.`);
  process.exitCode = 1;
} else {
  console.log("Unattended SCSB configuration is present.");
}
