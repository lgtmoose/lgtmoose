---
"lgtmoose": minor
---

Waiting for CI notices a commit status as soon as GitHub sends it, and no longer takes a webhook for every check run. A check suite finishing still wakes a pull request that waits on that commit. A status names no pull request, so every open pull request of the repository waiting on the commit is woken. An App from `lgtmoose setup` subscribes to Check suite and Status, not Check run. An existing App can drop Check run and add Status (see docs/upgrading.md).
