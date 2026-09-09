# The site. Multi stage, so the runtime image carries the build output and none
# of the toolchain.
FROM node:20-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund

FROM node:20-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# The NEXT_PUBLIC_ values are inlined at build time, so they have to be present
# here rather than only at run time. This is the usual trap with Next on a PaaS.
ARG NEXT_PUBLIC_SITE_URL
ARG NEXT_PUBLIC_API
ARG NEXT_PUBLIC_ROUTER
ARG NEXT_PUBLIC_REBALANCER
ARG NEXT_PUBLIC_ORDERS
ARG NEXT_PUBLIC_FACTORY
ARG NEXT_PUBLIC_SWAP
ARG NEXT_PUBLIC_SOURCE_URL
ARG NEXT_PUBLIC_META_TIMEOUT_MS
ENV NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL
ENV NEXT_PUBLIC_API=$NEXT_PUBLIC_API
ENV NEXT_PUBLIC_ROUTER=$NEXT_PUBLIC_ROUTER
ENV NEXT_PUBLIC_REBALANCER=$NEXT_PUBLIC_REBALANCER
ENV NEXT_PUBLIC_ORDERS=$NEXT_PUBLIC_ORDERS
ENV NEXT_PUBLIC_FACTORY=$NEXT_PUBLIC_FACTORY
ENV NEXT_PUBLIC_SWAP=$NEXT_PUBLIC_SWAP
ENV NEXT_PUBLIC_SOURCE_URL=$NEXT_PUBLIC_SOURCE_URL
ENV NEXT_PUBLIC_META_TIMEOUT_MS=$NEXT_PUBLIC_META_TIMEOUT_MS
# NEXT_PUBLIC_LOCAL is deliberately absent. It points the site at a fresh
# anvil's deterministic addresses, which on a real deployment is a healthy
# looking site wired to contracts that are not there. It belongs to
# `npm run dev` and must not be settable on a built image.
#
# Everything else the site reads has to be here. A NEXT_PUBLIC_ value the code
# reads and this file does not declare cannot be set at all: Next inlines these
# at build time, so a variable that only exists at run time is already too late
# and reads as unset. It fails silently, which is the problem, so
# scripts/check-env.mjs compares the two lists in CI.
RUN npm run build

FROM node:20-slim AS run
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
# Next's standalone server passes process.env.HOSTNAME straight to listen(),
# and Docker sets HOSTNAME to the container id. Without this it binds to that
# one interface rather than every one, which is not reachable from outside the
# container: the log says "Local: http://d977d471201a:8080" instead of 0.0.0.0,
# the app looks perfectly healthy, and the platform healthcheck gets service
# unavailable until it gives up and fails the deploy five minutes later.
ENV HOSTNAME="0.0.0.0"
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
EXPOSE 3000
CMD ["node", "server.js"]
