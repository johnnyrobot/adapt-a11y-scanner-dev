# Playwright base image ships Chromium + the right system libs, so the bridge
# runs headless out of the box (as a job, worker, or one-shot container).
FROM mcr.microsoft.com/playwright:v1.48.0-jammy

WORKDIR /app

# Install deps (Chromium already present in the base image).
COPY package.json package-lock.json* ./
RUN npm ci --omit=optional || npm install --omit=optional

# Build TypeScript -> dist/
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# For SCAN_MODE=in-process, also install/link @libretexts/remedy-core:
#   RUN npm install @libretexts/remedy-core
# (omitted by default — the default SCAN_MODE=http needs no extra deps.)

ENTRYPOINT ["node", "dist/index.js"]
# e.g.  docker run --env-file .env adapt-a11y-scanner assignment 1234
