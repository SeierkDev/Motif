# The indexer, keeper, level sweep and API.
#
# node:20-slim rather than an alpine image with build tools, because nothing
# here compiles: SQLite is the WebAssembly build precisely so a clone needs no
# C toolchain.
FROM node:20-slim

WORKDIR /app

# Dependencies first, so a code change does not reinstall the world.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund

COPY tsconfig.json ./
COPY migrations ./migrations
COPY src ./src

# tsx runs the TypeScript directly. There is no build step to get out of sync
# with what is actually deployed.
RUN npm install --no-save tsx

ENV NODE_ENV=production
ENV PORT=8787
ENV DATA_DIR=/data
EXPOSE 8787

# DATA_DIR wants a mounted volume. It holds the recorded level history, which is
# the only thing here that cannot be rebuilt by rescanning the chain.
#
# There is deliberately no `VOLUME` instruction: Railway rejects the build
# outright with "docker VOLUME is not supported, use Railway Volumes", because
# it attaches its own. Mount a volume at /data in the service settings.

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# `node --import tsx` rather than `npx tsx`. Measured: any wrapper that stays
# alive between the platform and node swallows SIGTERM, and npx is one. Through
# npx the container exits 143 with no shutdown; this way it exits 0. See the
# note on the handler in src/main.ts.
CMD ["node", "--import", "tsx", "src/main.ts"]
