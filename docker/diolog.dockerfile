# Diolog fork image: upstream Uptime Kuma 2.5.12 plus the AI visual check (server/diolog/).
# Built for linux/arm64 by .github/workflows/diolog-image.yml and run by the status cell
# (dAIolog apps/infra/cells/status). The base is upstream's full base image, which carries Chromium
# for real-browser monitors; it is pinned by digest so a rebuild cannot change it silently.
ARG BASE_IMAGE=louislam/uptime-kuma:base2@sha256:e18b7406c58dc3ba83ab71bd221bafc92cf6cfdb5c61114dcc3b93d447463f6d

FROM ${BASE_IMAGE} AS build
WORKDIR /app
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=1
COPY .npmrc package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev --no-audit --no-fund && mkdir -p ./data

FROM ${BASE_IMAGE}
WORKDIR /app
LABEL org.opencontainers.image.source="https://github.com/Diolog26/uptime-kuma"
LABEL org.opencontainers.image.description="Uptime Kuma with an AI visual check, for status.diolog.app"
ENV UPTIME_KUMA_IS_CONTAINER=1
COPY --from=build /app /app
EXPOSE 3001
ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "server/server.js"]
