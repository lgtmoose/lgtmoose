# The egress proxy: the only way out of the sandbox subnets. No dependencies and no build step:
# Node runs the TypeScript sources directly (type stripping), so the image holds only src/.
FROM node:24-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54

WORKDIR /app
COPY package.json ./
COPY src/proxy.ts src/main.ts ./src/

ENV NODE_ENV=production PORT=3128
EXPOSE 3128
# The image's unprivileged node user. The task runs with a read-only root filesystem.
USER node
CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.ts"]
