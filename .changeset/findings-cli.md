---
"lgtmoose": minor
---

Add `lgtmoose findings`: list a pull request's open findings for a coding agent (`--format md`), and answer them with `lgtmoose findings ack <id> fixed` or `declined --reason "…"`, in shadow mode or live. The CLI uses your GitHub token through the dashboard API, which checks with GitHub that you're a member of the org and what you can do on the repository: the token needs `read:org` (or a fine-grained token's Members permission), and answering needs one that can write (`gh auth token`, or a classic token with `repo` and `read:org`). A fine-grained token can list, never answer. "Fixed" moves the finding up the next run's recheck, which alone closes it; "declined" closes it as an accepted decline on its thread would, and the reconciler learns from it. Adds migrations 0024 and 0025.
