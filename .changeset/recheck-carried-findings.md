---
"lgtmoose": patch
---

Close a carried finding that was fixed in another file. On an incremental review, our open blocking and should-fix findings whose file the new commits changed, or whose file is in the same directory as or imports or is imported by a changed one, are checked again against the head: one recheck batch per run on the fast tier, at most 10 findings, blocking first. A finding is closed as fixed only when the recheck says the problem is gone, the run's review didn't raise it again, and (for authz, tenant_scoping, money and secrets) the recheck names the changed file that fixes it. Its thread gets a reply saying where, and is resolved, and the decision is made again without it. Before, such a finding stayed open and kept the review at "changes requested" until someone replied.
