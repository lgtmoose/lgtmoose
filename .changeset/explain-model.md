---
"lgtmoose": minor
---

`@lgtmoose explain` is answered by a model. For the PR's author or someone with write access, the request is recorded and a run is queued; the explainer runs in a sandbox batch on the fast tier (no GitHub token, a leased credential) and its answer is scanned for prompt injection and escaped before it's posted in the finding's thread, or on the PR for `explain path:line`. At most one model answer per finding per commit, reused after that, and at most `maxExplanations` (5 by default) per PR per run. Anyone else, a flagged or failed answer, or `maxExplanations: 0` gets the stored finding's details as before. Adds migration 0016 (`pending_replies.kind`).
