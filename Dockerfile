# ---------------------------------------------------------------------------
# Indexer-only image.
#
# This image runs `indexer.ts` (the Turso-backed chain event indexer) and
# NOTHING else. It deliberately contains no Next.js build steps: the web app
# is deployed to Cloudflare Workers via OpenNext (`npm run deploy`), so a
# `next build` here would be dead weight and would drag the whole React /
# Tailwind toolchain into the image.
#
# Build:  docker build -t vibe-signals-indexer .
# Run:    docker run --env-file .env.local vibe-signals-indexer
# ---------------------------------------------------------------------------
FROM node:20-alpine

# `tsx` runs the TypeScript entrypoint directly, so no compile step is needed.
# `dotenv` is a runtime dependency of indexer.ts (it loads `.env.local`).
RUN npm install -g tsx@4

WORKDIR /app

# Install dependencies first so this layer is cached across source edits.
# `--ignore-scripts` skips native postinstall hooks we do not need here.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# Only the files the indexer actually reads. Copying the whole repo would pull
# in the Next.js app, which this image never executes.
COPY tsconfig.json ./
COPY indexer.ts ./
COPY lib ./lib
COPY scripts ./scripts

# The indexer opens an HTTP server for health checks; keep it non-root.
ENV NODE_ENV=production
USER node

# Secrets (TURSO_DATABASE_URL, TURSO_AUTH_TOKEN, RPC URLs) are injected at
# runtime via `--env-file` / platform secrets. Never bake them into the image.
CMD ["tsx", "indexer.ts"]
