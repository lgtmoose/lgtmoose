---
"lgtmoose": minor
---

Review triggers: a repository can review a PR only when it's ready. `review.trigger` in `.lgtmoose.yaml` is `auto` (the default, as before), `label` (only while the PR carries `review.label`, `lgtmoose:review` by default) or `command` (only on `@lgtmoose review`). `review.on_push: manual` reviews a PR once and then waits for the label or a command, `review.label_once` takes the label off as its review starts, and `review.trusted_bots` lets listed coding agents add the label or comment `@lgtmoose review`, and nothing else. A PR that waits gets a "Waiting for a trigger" check run (`action_required` when the check is required) and no model time: the setting is read at the base before anything is cloned. The reconciler catches a missed `labeled` webhook. The push debounce is now the deployment setting `reviewDebounceSeconds` (60 by default, up to 1800).
