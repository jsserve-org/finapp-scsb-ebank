# SCSB eBank transaction-history fetcher

This Bun and Playwright automation downloads the most recent 30 days of transaction history for every visible TWD and foreign-currency account at [SCSB eBank](https://ebank.scsb.com.tw). It runs Chromium headlessly in Docker. OpenRouter's configured model reads the login image CAPTCHA; TypeSafe Jev's official API chooses among visible read-only controls if a known Playwright locator fails. Jev receives labels with digits removed, not credentials, balances, or the full page.

The downloaded files are bank transaction histories, not official monthly statements. The script does not initiate transfers, payments, investments, or account changes. If Ledgerly is configured, it imports new transactions, checks existing transactions to avoid duplicates, and suggests categories. Matching SCSB foreign-currency service fees are categorized as Fees directly.

## Deploy on a server

The image is published to `ghcr.io/jsserve-org/finapp-scsb-ebank:latest` by the GitHub Actions workflow on `main`. From a checkout of this repo:

```sh
cp .env.example .env
mkdir -p statements
chmod 700 statements
```

Fill `.env` with the account mapping and model options. Create `credentials.json` alongside it with these keys: `SCSB_ID`, `SCSB_USER_CODE`, `SCSB_PASSWORD`, `OPENROUTER_API_KEY`, and `TYPESAFE_API_KEY`. For Ledgerly import also add `LEDGERLY_API_URL` and `LEDGERLY_API_KEY`. The latter two can be omitted to download files only. Set `LEDGERLY_EXISTING_TWD_INDEX`, `LEDGERLY_EXISTING_TWD_SUFFIX`, and `LEDGERLY_EXISTING_TWD_ACCOUNT_ID` in `.env` only after identifying the correct existing account. An account-order fingerprint stops imports if the bank's account list changes unexpectedly.

Keep `credentials.json`, `.env`, and `statements/` private. All are ignored by Git; `credentials.json` is mounted read-only. The container does not persist a bank browser session.

```sh
chmod 600 credentials.json .env
docker compose -f compose.server.yml pull fetch
docker compose -f compose.server.yml run --rm fetch
```

For a daily run at 14:00 Asia/Taipei on a Linux server, set the host timezone appropriately or set `CRON_TZ=Asia/Taipei` if supported, then add this cron entry with the absolute path to your checkout:

```cron
0 14 * * * cd /absolute/path/to/finapp-scsb-ebank && flock -n /tmp/scsb-ebank-fetch.lock sh -c 'docker compose -f compose.server.yml pull fetch && docker compose -f compose.server.yml run --rm fetch' >> cron.log 2>&1
```

The image has no scheduler of its own. Each run starts a new login; SCSB signs out after about five minutes of inactivity. If the bank changes its pages or adds another verification step, an unattended run can fail. The statements remain in `./statements`.

## Develop locally

```sh
bun install --frozen-lockfile
bun run typecheck
bun test
docker compose -f compose.yml build fetch
```

The local Compose file builds from source. On macOS, `run-cron.sh` uses OrbStack and `lockf` for the local 14:00 schedule. For an interactive browser session, leave the bank credentials unset and run `bun run start` with `SCSB_HEADLESS=false` and `SCSB_BROWSER_CHANNEL=chrome`.

To inspect existing downloads without changing Ledgerly, run `bun run import:existing`; add `--apply` to import. `bun run categorize:existing --apply` categorizes uncategorized SCSB imports. The setup portal (`bun run setup:portal`) can create `credentials.json` locally; only expose it through a tunnel you control while entering credentials.
