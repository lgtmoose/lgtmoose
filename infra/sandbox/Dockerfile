# The image sandbox tasks run the model in. The Workflow stack (NIC-810) builds it from the
# repository root, so apps/sandbox and the workspace packages it uses are in the build context;
# .dockerignore keeps node_modules, build output and git data out. It holds no GitHub token. The
# control plane hands each task one model credential.
#
# Claude Code is pinned to an exact version, because the harness's flags and tool rules were
# checked against it. Change it together with CLAUDE_CODE_VERSION in
# packages/harness/src/version.ts (a test checks they match), and check the flags again.
#
# The Codex CLI is pinned the same way by its adapter (NIC-821). The Cursor CLI isn't installed
# yet: its adapter (NIC-822) pins it once its install and flags are checked.
FROM node:24-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS build

RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile --filter "@lgtmoose/sandbox..." \
  && pnpm --filter "@lgtmoose/sandbox..." run build \
  && pnpm --filter @lgtmoose/sandbox deploy --legacy --prod /out

FROM node:24-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54

ARG CLAUDE_CODE_VERSION=2.1.311

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# The postinstall step puts the native binary in place. `claude --version` checks that it did.
RUN npm install --global "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
  && npm cache clean --force \
  && claude --version

ENV DISABLE_AUTOUPDATER=1 \
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1

RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin lgtmoose
COPY --from=build --chown=root:root /out /app
USER lgtmoose
# The root filesystem is read-only in the task; /work and /tmp are writable volumes.
WORKDIR /work
ENTRYPOINT ["node", "/app/dist/index.js"]
