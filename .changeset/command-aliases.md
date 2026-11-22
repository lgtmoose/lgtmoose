---
"lgtmoose": patch
---

Commands can use a deployment's aliases as well as the App's own handle. With `commandAliases: ["lgtmoose"]`, `@lgtmoose review` works on an App called `lgtmoose-<org>`, and which handle is used never changes what a command may do.

Without the alias, a comment that mentions `@lgtmoose` followed by a whole command gets one reply per PR naming the handle that works. A whole command is the command with nothing else on the line. Later wrong-handle comments on that PR get a 😕. Shadow mode only logs the reply, and `commandHint: false` turns it off for a repository where another App called `lgtmoose` answers. A wrong-handle comment in one of LGTMoose's findings' threads still goes to the reply judge.

`help`, the summary's footer, the check runs that wait for a trigger or for CI, and `lgtmoose setup` show the real handle, and they never fall back to a guessed `@lgtmoose`.

Adds migration 0023, with three new columns on `pull_request_dispatches`:

- `handle_hint_at`: when the PR's hint was claimed;
- `handle_hint_posted`: whether it was posted;
- `handle_hint_claimant`: which comment or review holds the claim, so that comment's retry can still post the hint.
