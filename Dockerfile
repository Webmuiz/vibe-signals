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
# Upgrade to Node 22 to satisfy EBADENGINE requirements
FROM node:22-alpine

# Create the app directory and assign ownership to the node user FIRST
RUN mkdir -p /home/node/app && chown -R node:node /home/node/app

# Set the working directory
WORKDIR /home/node/app

# Now switch to the non-root user
USER node

# Copy package files with correct ownership
COPY --chown=node:node package*.json ./

# Install bypassing peer dependency conflicts
RUN npm install --omit=dev --legacy-peer-deps

# Copy the rest of the application files
COPY --chown=node:node . .

EXPOSE 7860

CMD ["npm", "run", "worker"]