---
id: ci-cd
title: CI and CD
description: Rules for CI workflows, build scripts and deployment config.
rules:
  - id: working-directory
    category: correctness
    severity: blocking
    rule: A step that runs in the wrong working directory, so it builds, tests or deploys the wrong package, or nothing.
    example: |
      - run: pnpm test        # the package is in apps/web; no working-directory set
  - id: missing-tool
    category: correctness
    severity: should_fix
    rule: A step that uses a tool or runtime version the job never installs or pins.
    example: |
      - run: pnpm install     # no pnpm/action-setup or corepack enable
  - id: broad-permissions
    category: security
    severity: blocking
    rule: Workflow or job permissions wider than the job needs, such as write-all, contents write for a test job, or id-token write with no OIDC use.
    example: |
      permissions: write-all
  - id: untrusted-trigger
    category: security
    severity: blocking
    rule: pull_request_target or workflow_run that checks out or runs code from the pull request with secrets or write tokens available.
    example: |
      on: pull_request_target
      steps:
        - uses: actions/checkout@v4
          with: { ref: "${{ github.event.pull_request.head.sha }}" }
  - id: script-injection
    category: security
    severity: blocking
    rule: Event fields a user controls (titles, branch names, comment bodies) expanded straight into a run script.
    example: |
      - run: echo "${{ github.event.pull_request.title }}"
  - id: unpinned-action
    category: security
    severity: should_fix
    rule: A third-party action referenced by a branch or mutable tag instead of a full commit SHA, in a job that has secrets or write access.
    example: |
      - uses: some-org/deploy-action@main
  - id: persisted-credentials
    category: secrets
    severity: should_fix
    rule: actions/checkout leaving its token in the git config in a job that later runs untrusted code or uploads the workspace.
    example: |
      - uses: actions/checkout@v4   # no persist-credentials: false; next step runs PR scripts
  - id: unsigned-release
    category: security
    severity: should_fix
    rule: A release or image publish step that drops existing signing, provenance or attestation, or pushes without them where the repo signs other artifacts.
    example: |
      - run: docker push ghcr.io/org/app:latest   # the other images use cosign sign
  - id: secret-in-logs
    category: secrets
    severity: blocking
    rule: A secret echoed, printed with set -x, or passed on a command line that is logged.
    example: |
      - run: set -x; curl -H "Authorization: Bearer $TOKEN" …
  - id: skipped-checks
    category: correctness
    severity: should_fix
    rule: Tests, lint or type checks removed from CI or made optional (continue-on-error, || true) without a reason.
    example: |
      - run: pnpm test || true
---
