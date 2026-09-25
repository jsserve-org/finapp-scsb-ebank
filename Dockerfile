FROM oven/bun:1.3.6 AS bun-runtime

FROM mcr.microsoft.com/playwright:v1.55.0-noble
COPY --from=bun-runtime /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src

ENV SCSB_HEADLESS=true \
    SCSB_BROWSER_CHANNEL=chromium \
    SCSB_OUTPUT_DIR=/app/statements
CMD ["bun", "run", "src/index.ts"]
