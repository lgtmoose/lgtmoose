---
"lgtmoose": minor
---

A review can wait for the PR's CI (`review.wait_for_checks` in `.lgtmoose.yaml`: `off`, the default; `required`, the base branch's required status checks; or a list of check names). Once the review trigger says a review may start, the prepare step reads the head's check runs and commit statuses before cloning anything. When they've all passed, the review starts. A failed check holds it until it passes; checks still running hold it for at most `review.wait_timeout_minutes` (60 by default), after which it starts and its summary says it didn't wait. A waiting PR gets a "Waiting for CI" check run naming the checks. `@lgtmoose review` from someone with write access starts the review at once. The App subscribes to `check_suite` and asks for `statuses: read`. Adds migration 0021 (the wait, on `pull_request_dispatches`).
