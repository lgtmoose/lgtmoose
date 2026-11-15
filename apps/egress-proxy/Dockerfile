# The egress proxy: the only way out of the sandbox subnets. No dependencies and no build step:
# Node runs the TypeScript sources directly (type stripping), so the image holds only src/.
FROM node:24-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54

WORKDIR /app
COPY package.json ./
COPY src/proxy.ts src/main.ts ./src/

# npm, npx, corepack and yarn come with the base image, but the proxy runs only node. Removing
# them takes their bundled packages, and those packages' advisories, out of the image.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-v* \
  /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn \
  /usr/local/bin/yarnpkg \
  && node --version

ENV NODE_ENV=production PORT=3128
EXPOSE 3128
# The image's unprivileged node user. The task runs with a read-only root filesystem.
USER node
CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.ts"]
