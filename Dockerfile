# ---------------------------------------------------------------------------
# Vibe Signals — Background Indexer / Trade-Monitor Worker
#
# Packaged for Hugging Face Spaces (Docker SDK). HF runs containers as a
# non-root user with UID 1000 and expects the app to listen on port 7860.
#
# The node:20-alpine base image already ships a `node` user with UID 1000, so
# we reuse it instead of creating a new one (creating UID 1000 would fail with
# "adduser: uid '1000' in use").
#
# Secrets (TURSO_DATABASE_URL, TURSO_AUTH_TOKEN, SECONDARY_RPC_URL, ...) are
# injected at runtime via Space Secrets — never baked into this image.
# ---------------------------------------------------------------------------
FROM node:20-alpine

# Reuse the built-in non-root `node` user (UID 1000) required by HF Spaces.
USER node

# All app files live under the user's home directory.
WORKDIR /home/node/app

# Install dependencies first so Docker can cache this layer across code edits.
COPY --chown=node:node package*.json ./
RUN npm install --omit=dev --legacy-peer-deps
# Copy the rest of the application with correct ownership.
COPY --chown=node:node . .

# Hugging Face Spaces health-checks this port.
EXPOSE 7860

# Start the background indexer (tsx runs the TypeScript entry point directly).
CMD ["npm", "run", "worker"]
