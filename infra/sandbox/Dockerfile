# The image sandbox tasks run the model in. It isn't wired into CDK yet: the Fargate task that
# uses it comes in a later ticket. It holds no GitHub token. The control plane hands each task one
# model credential.
#
# Claude Code is pinned to an exact version, because the harness's flags and tool rules were
# checked against it. Change it together with CLAUDE_CODE_VERSION in
# packages/harness/src/version.ts (a test checks they match), and check the flags again.
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
USER lgtmoose
WORKDIR /home/lgtmoose
