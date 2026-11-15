---
"lgtmoose": minor
---

Add the `@lgtmoose approve <id>` command for pending learnings, and limit how many pending learnings one author without write access can have in an org (`learnings.maxPendingPerAuthor`, 5 by default).

Fix: `approve` and `forget` now check the commenter's access on the learning's own repository, not the repository of the PR the command was posted on. Before, write access on one repository could forget a learning of another repository in the same org.
