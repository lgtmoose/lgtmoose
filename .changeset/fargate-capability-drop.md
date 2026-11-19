---
"lgtmoose": patch
---

The review tasks keep only the three default capabilities Fargate allows them to hold, then the entrypoint clears those too. Adding SETUID is rejected on Fargate, so the previous task definition never updated.
