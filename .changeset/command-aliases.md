---
"lgtmoose": patch
---

Commands can use a deployment's aliases as well as the App's own handle. With `commandAliases: ["lgtmoose"]`, `@lgtmoose review` works on an App called `lgtmoose-<org>`, and which handle is used never changes what a command may do.

Without the alias, a comment that mentions `@lgtmoose` followed by a command word gets one reply per PR naming the handle that works. That comment isn't sent to the reply judge. Shadow mode only logs the reply. `commandHint: false` turns it off for a repository where another App called `lgtmoose` answers.

`help`, the summary's footer, the check runs that wait for a trigger or for CI, and `lgtmoose setup` show the real handle, and they never fall back to a guessed `@lgtmoose`.

Adds migration 0023 (`pull_request_dispatches.handle_hint_at`).
