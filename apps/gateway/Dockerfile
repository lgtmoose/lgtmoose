# The gateway's Node server, for the docker compose deployment (deploy/compose). On AWS the same
# code runs as a Lambda. Built from the repository root: docker build -f apps/gateway/Dockerfile .
FROM node:24-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS build

RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile --filter "@lgtmoose/gateway..." \
  && pnpm --filter "@lgtmoose/gateway..." run build \
  && pnpm --filter @lgtmoose/gateway deploy --legacy --prod /out

FROM node:24-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54

# npm, npx, corepack and yarn come with the base image, but the gateway runs only node.
# Removing them takes their bundled packages, and those packages' advisories, out of the image.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-v* \
  /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn \
  /usr/local/bin/yarnpkg \
  && node --version

COPY --from=build --chown=root:root /out /app
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
# The image's unprivileged node user. Compose runs it with a read-only root filesystem.
USER node
ENTRYPOINT ["node", "/app/dist/server.js"]
