# The egress proxy: the only way out of the sandbox subnets. No dependencies and no build step:
# Node runs the TypeScript sources directly (type stripping), so the image holds only src/.
FROM node:25-slim@sha256:81db02c4b671288a03915da9534dbd54f96d0e7c24d80ccc54f5b36b2e684370

WORKDIR /app
COPY package.json ./
COPY src/proxy.ts src/main.ts ./src/

ENV NODE_ENV=production PORT=3128
EXPOSE 3128
# The image's unprivileged node user. The task runs with a read-only root filesystem.
USER node
CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.ts"]
