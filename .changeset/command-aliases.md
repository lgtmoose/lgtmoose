---
"lgtmoose": patch
---

Commands can use a deployment's aliases as well as the App's own handle. With `commandAliases: ["lgtmoose"]`, `@lgtmoose review` works on an App called `lgtmoose-<org>`. Which handle is used never changes what a command may do. Without the alias, a comment that starts with `@lgtmoose` and a command word gets one reply per PR naming the handle that works. Shadow mode only logs that reply. `help`, the summary's footer and `lgtmoose setup` show the real handle. Adds migration 0023 (`pull_request_dispatches.handle_hint_at`).
