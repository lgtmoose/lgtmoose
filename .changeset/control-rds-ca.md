---
"lgtmoose": patch
---

The control task's database client trusts a pinned RDS certificate bundle, so it can verify the database. The bundle is not added to Node's trust store. A review's prepare step failed before it could record the run because the RDS root is not in the public trust store.
