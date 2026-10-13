# ---------------------------------------------------------------------------
# Vibe Signals — Background Indexer / Trade-Monitor Worker
#
# Packaged for Hugging Face Spaces (Docker SDK). HF runs containers as a
# non-root user with UID 1000 and expects the app to listen on port 7860.
# Secrets (TURSO_DATABASE_URL, TURSO_AUTH_TOKEN, SECONDARY_RPC_URL, ...) are
# injected at runtime via Space Secrets — never baked into this image.
# ---------------------------------------------------------------------------
FROM node:20-alpine

# Create the non-root user required by Hugging Face Spaces (UID 1000).
RUN adduser -D -u 1000 user

# All app files live under the user's home directory.
WORKDIR /home/user/app

# Install dependencies first so Docker can cache this layer across code edits.
COPY --chown=user:user package.json package-lock.json ./
RUN npm ci --omit=dev || npm install --omit=dev

# Copy the rest of the application with correct ownership.
COPY --chown=user:user . .

# Drop privileges — the worker must not run as root.
USER user

# Hugging Face Spaces health-checks this port.
EXPOSE 7860

# Start the background indexer (tsx runs the TypeScript entry point directly).
CMD ["npm", "run", "worker"]
