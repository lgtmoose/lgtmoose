# The image sandbox tasks run the model in. The Workflow stack (NIC-810) builds it from the
# repository root, so apps/sandbox and the workspace packages it uses are in the build context;
# .dockerignore keeps node_modules, build output and git data out. It holds no GitHub token. The
# control plane hands each task one model credential.
#
# Claude Code, the Codex CLI and the Cursor CLI are pinned to exact versions, because the
# harness's flags, tool rules and output parsing were checked against them. Change each together
# with CLAUDE_CODE_VERSION, CODEX_VERSION or CURSOR_AGENT_VERSION in
# packages/harness/src/version.ts (a test checks they match), and check the flags again.
FROM node:24-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS build

RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile --filter "@lgtmoose/sandbox..." \
  && pnpm --filter "@lgtmoose/sandbox..." run build \
  && pnpm --filter @lgtmoose/sandbox deploy --legacy --prod /out

# The Cursor CLI isn't on npm. This is the build its installer (https://cursor.com/install)
# downloads, fetched directly so the version is pinned and the final image needs no curl. Set
# CURSOR_AGENT_SHA256 to the tarball's checksum for your platform to have the build verify it.
FROM node:24-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS cursor

ARG CURSOR_AGENT_VERSION=2026.11.10-731fb78
ARG CURSOR_AGENT_SHA256=
ARG TARGETARCH
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN set -eu; \
  case "${TARGETARCH:-amd64}" in \
    amd64) arch=x64 ;; \
    arm64) arch=arm64 ;; \
    *) echo "unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
  esac; \
  curl -fsSL --proto '=https' --tlsv1.2 -o /tmp/agent.tar.gz \
    "https://downloads.cursor.com/lab/${CURSOR_AGENT_VERSION}/linux/${arch}/agent-cli-package.tar.gz"; \
  if [ -n "${CURSOR_AGENT_SHA256}" ]; then \
    echo "${CURSOR_AGENT_SHA256}  /tmp/agent.tar.gz" | sha256sum -c -; \
  fi; \
  mkdir -p /opt/cursor-agent; \
  tar -xzf /tmp/agent.tar.gz -C /opt/cursor-agent --strip-components=1; \
  test -x /opt/cursor-agent/cursor-agent

FROM node:24-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54

ARG CLAUDE_CODE_VERSION=2.1.311
ARG CODEX_VERSION=0.166.0

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# The postinstall step puts the native binary in place. `claude --version` checks that it did.
RUN npm install --global "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
  && npm cache clean --force \
  && claude --version

# The package ships a native binary per platform; `codex --version` checks this one runs.
RUN npm install --global "@openai/codex@${CODEX_VERSION}" \
  && npm cache clean --force \
  && codex --version

# On the read-only root filesystem the CLI can't update itself. `agent --version` checks it runs.
COPY --from=cursor /opt/cursor-agent /opt/cursor-agent
RUN ln -s /opt/cursor-agent/cursor-agent /usr/local/bin/agent \
  && ln -s /opt/cursor-agent/cursor-agent /usr/local/bin/cursor-agent \
  && HOME=/tmp agent --version

ENV DISABLE_AUTOUPDATER=1 \
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1

RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin lgtmoose
COPY --from=build --chown=root:root /out /app
USER lgtmoose
# The root filesystem is read-only in the task; /work and /tmp are writable volumes.
WORKDIR /work
ENTRYPOINT ["node", "/app/dist/index.js"]
