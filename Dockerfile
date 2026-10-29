# The base image tag MUST track the `playwright` version in package.json — the
# bundled browser build and the client are version-locked, or chromium.launch()
# fails at runtime. We also run `playwright install` below as belt-and-suspenders.
FROM mcr.microsoft.com/playwright:v1.60.0-jammy

WORKDIR /app

# Install deps deterministically. The default SCAN_MODE=http needs no extra deps;
# @libretexts/remedy-core (in-process, dev-only) is intentionally not installed here.
COPY package.json package-lock.json ./
RUN npm ci

# Build TypeScript -> dist/
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Ensure the Chromium build matching the installed Playwright is present
# (robust even if the base image tag drifts from the locked version).
RUN npx playwright install chromium && npm prune --omit=dev

# Drop root: run as the non-root user the Playwright image provides, with the
# Chromium sandbox ENABLED (do not set CHROMIUM_NO_SANDBOX).
RUN chown -R pwuser:pwuser /app
USER pwuser

ENTRYPOINT ["node", "dist/index.js"]
# e.g.  docker run --env-file .env adapt-a11y-scanner assignment 1234
