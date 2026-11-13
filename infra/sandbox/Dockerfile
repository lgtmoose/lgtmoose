# The image sandbox tasks run the model in. It isn't wired into CDK yet: the Fargate task that
# uses it comes in a later ticket. It holds no GitHub token. The control plane hands each task one
# model credential.
#
# Claude Code and the Codex CLI are pinned to exact versions, because the harness's flags, tool
# rules and output parsing were checked against them. Change each together with
# CLAUDE_CODE_VERSION or CODEX_VERSION in packages/harness/src/version.ts (a test checks they
# match), and check the flags again.
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

ENV DISABLE_AUTOUPDATER=1 \
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1

RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin lgtmoose
USER lgtmoose
WORKDIR /home/lgtmoose
