# The control task: prepares a review's batches and posts the results. It holds the GitHub App
# credentials (read at runtime through its task role) and never runs a model.
#
# Built by CDK (the Workflow stack) from the repository root, so the workspace packages it uses
# are in the build context. .dockerignore keeps node_modules, build output and git data out.
FROM node:24-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS build

RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile --filter "@lgtmoose/control..." \
  && pnpm --filter "@lgtmoose/control..." run build \
  && pnpm --filter @lgtmoose/control deploy --legacy --prod /out

FROM node:24-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54

# git clones the PR being reviewed.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin lgtmoose
COPY --from=build --chown=root:root /out /app
USER lgtmoose
WORKDIR /work
ENTRYPOINT ["node", "/app/dist/index.js"]
