# Security policy

## Reporting a vulnerability

Report vulnerabilities privately through GitHub's **Report a vulnerability** button on this repository's Security tab. Please don't open a public issue.

We aim to acknowledge reports within 3 working days.

## Scope

LGTMoose reads untrusted content (pull requests, comments, code) and holds credentials. We especially want to hear about:

- prompt injection that changes a review decision, approves a PR, or writes a learning
- any path by which the model sandbox can reach GitHub, read GitHub credentials, or reach hosts outside the model API allowlist
- webhook spoofing or replay
- cross-repository or cross-installation data exposure
- credential leakage in logs, transcripts or comments

A full threat model will be added before v0.1.0 (NIC-844).
