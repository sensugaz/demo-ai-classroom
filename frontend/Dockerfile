# syntax=docker/dockerfile:1

##########
# deps stage: install node_modules with a clean, reproducible install.
##########
FROM node:22-alpine AS deps
WORKDIR /app

# libc6-compat is occasionally required by some native deps on alpine.
RUN apk add --no-cache libc6-compat

COPY package.json package-lock.json* ./
# Use npm ci when a lockfile is present, otherwise fall back to npm install.
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

##########
# build stage: compile the Next.js standalone output.
##########
FROM node:22-alpine AS build
WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN npm run build

##########
# runner stage: minimal runtime image serving .next/standalone.
##########
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Run as a non-root user for security.
RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

# Public assets and the self-contained server output.
COPY --from=build /app/public ./public
COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs

EXPOSE 3000

# server.js is emitted by Next.js standalone output.
CMD ["node", "server.js"]
