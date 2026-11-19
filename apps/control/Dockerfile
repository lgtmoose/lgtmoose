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

# git clones the PR being reviewed. ca-certificates covers public hosts. The RDS
# root is not in that set. The pinned bundle is only for the Postgres client
# (LGTMOOSE_DATABASE_CA_FILE). It is not added to Node's trust store. A changed
# bundle fails this build until the hash is updated.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates curl \
  && curl -fsSL -o /etc/ssl/rds-global-bundle.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
  && echo "90a6f1a7978a1b1b096dca6c57511ca48d3b8cf052f8e704baf358f34ea2f21b  /etc/ssl/rds-global-bundle.pem" | sha256sum -c - \
  && grep -q "BEGIN CERTIFICATE" /etc/ssl/rds-global-bundle.pem \
  && chmod 644 /etc/ssl/rds-global-bundle.pem \
  && apt-get purge -y curl \
  && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*

# npm, npx, corepack and yarn come with the base image, but the control task runs only node
# and git (dependencies are installed in the build stage). Removing them takes their bundled
# packages, and those packages' advisories, out of the image.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-v* \
  /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn \
  /usr/local/bin/yarnpkg \
  && node --version

RUN groupadd --gid 10001 lgtmoose \
  && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin lgtmoose
COPY --from=build --chown=root:root /out /app
COPY infra/task-entrypoint.sh /usr/local/bin/lgtmoose-entrypoint
RUN chmod 755 /usr/local/bin/lgtmoose-entrypoint
# Local runs keep the image user. Fargate sets user 0 so the entrypoint can open
# the mounted volumes, then it becomes uid 10001.
USER lgtmoose
ENV HOME=/tmp
WORKDIR /work
ENTRYPOINT ["/usr/local/bin/lgtmoose-entrypoint"]
