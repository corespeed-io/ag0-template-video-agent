# ================================
# Stage 1 — Build chat UI (pnpm)
# ================================
FROM node:24-slim AS frontend-build
RUN corepack enable
WORKDIR /app/ui
# Install deps first for better layer caching

COPY ui/package.json ui/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY ui/ ./
RUN pnpm build

# ================================
# Stage 2 — Install Remotion deps (pnpm)
# ================================
FROM node:24-slim AS remotion-deps
RUN corepack enable
WORKDIR /app/remotion
COPY remotion/package.json remotion/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# ================================
# Stage 3 — Production runtime
# ================================
FROM denoland/deno:2.6.9
WORKDIR /app

# Copy Node.js + pnpm from the remotion-deps stage so the agent can run Remotion Studio
COPY --from=remotion-deps /usr/local/bin/node /usr/local/bin/node
COPY --from=remotion-deps /usr/local/lib/node_modules/corepack /usr/local/lib/node_modules/corepack
RUN ln -sf /usr/local/lib/node_modules/corepack/dist/corepack.js /usr/local/bin/corepack \
    && corepack enable

# Cache Deno deps before copying source for better layer caching
COPY deno.json deno.lock ./
RUN deno install

# Backend source
COPY main.ts ./
COPY api/ ./api/

# Remotion source + config + Node deps
COPY remotion/src/ ./remotion/src/
COPY remotion/public/ ./remotion/public/
COPY remotion/studio.ts remotion/remotion.config.ts remotion/tsconfig.json remotion/package.json ./remotion/
COPY --from=remotion-deps /app/remotion/node_modules ./remotion/node_modules

# Copy built chat UI from stage 1
COPY --from=frontend-build /app/ui/dist ./ui/dist

EXPOSE 8080
CMD ["deno", "run", "--allow-all", "main.ts"]
