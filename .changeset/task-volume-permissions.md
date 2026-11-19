---
"lgtmoose": patch
---

The review tasks can write their mounted /tmp and /work, then run as uid 10001 with no capabilities. Fargate mounts those volumes owned by root, so prepare failed before it could check out a pull request.
