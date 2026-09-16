# Heimcloud ops — optional multi-stage Node image for non-Nix local dev (Neo uses package.nix).
FROM node:22-alpine AS deps
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY app/package.json app/package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV TZ=Europe/Zurich
ENV OPS_DB_PATH=/data/ops.sqlite
RUN addgroup -S ops && adduser -S ops -G ops \
  && mkdir -p /data && chown -R ops:ops /data
COPY --from=deps /app/node_modules ./node_modules
COPY app/ ./
USER ops
VOLUME ["/data"]
EXPOSE 3000
CMD ["node", "server.js"]
