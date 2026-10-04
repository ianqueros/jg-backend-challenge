FROM oven/bun:1.3.10-alpine AS base
WORKDIR /app
RUN apk add --no-cache curl

FROM base AS dependencies
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile

FROM base AS runner
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json bun.lock tsconfig.json tsconfig.build.json mikro-orm.config.ts ./
COPY src ./src
COPY scripts ./scripts

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -f http://127.0.0.1:${PORT}/health/ready || exit 1
EXPOSE 3000


CMD ["bun", "run", "start"]
