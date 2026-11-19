---
"lgtmoose": patch
---

The control task trusts the RDS global certificate bundle, so it can verify the database. The RDS root is not in the public trust store, and a review's prepare step failed before it could record the run.
