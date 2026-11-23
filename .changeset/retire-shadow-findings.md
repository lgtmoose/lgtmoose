---
"lgtmoose": patch
---

Going live retires shadow findings. A finding raised in shadow mode was never posted, so it has no comment anyone could see, reply to or resolve. Once `shadow` is `false`, the first run on a PR retires those nobody answered since they were last raised (status `shadow`), so they no longer count towards its decision; the summary says how many, and `@lgtmoose full review` raises any still there. The dashboard stops counting them too. Runs now record whether they were in shadow mode.
