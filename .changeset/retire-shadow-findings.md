---
"lgtmoose": patch
---

Going live retires shadow findings. A finding raised in shadow mode was never posted, so it has no comment anyone could see, reply to or resolve. Once `shadow` is `false`, a run retires those nobody answered since they were last raised (status `shadow`), so they no longer count towards the decision; each summary says how many until a full review runs, and the dashboard stops counting them. The first live run also posts its own review even when a shadow run recorded the same decision. Runs now record whether they were in shadow mode; the migration marks existing runs as shadow runs (see Upgrading if you ran live before).
