# The control task: prepares a review's batches and posts the results. It holds the GitHub App
# credentials (read at runtime through its task role) and never runs a model.
#
# Built by CDK (the Workflow stack) from the repository root, so the workspace packages it uses
# are in the build context. .dockerignore keeps node_modules, build output and git data out.
FROM node:24-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS build

RUN corepack enable
WORKDIR /repo
COPY . .
# The dashboard's static page too, for the docker compose dashboard service (dist/local/
# dashboard-main.js serves it from /app/site); unused on AWS, where CloudFront serves it.
RUN pnpm install --frozen-lockfile --filter "@lgtmoose/control..." --filter @lgtmoose/dashboard \
  && pnpm --filter "@lgtmoose/control..." run build \
  && pnpm --filter @lgtmoose/dashboard run build \
  && pnpm --filter @lgtmoose/control deploy --legacy --prod /out \
  && cp -r apps/dashboard/dist /out/site

FROM node:24-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54

# git clones the PR being reviewed.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# npm, npx, corepack and yarn come with the base image, but the control task runs only node
# and git (dependencies are installed in the build stage). Removing them takes their bundled
# packages, and those packages' advisories, out of the image.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-v* \
  /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn \
  /usr/local/bin/yarnpkg \
  && node --version

RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin lgtmoose
COPY --from=build --chown=root:root /out /app
USER lgtmoose
WORKDIR /work
ENTRYPOINT ["node", "/app/dist/index.js"]
