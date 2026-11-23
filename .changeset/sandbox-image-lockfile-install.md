---
"lgtmoose": patch
---

The sandbox image installs the whole lockfile before it deploys the package. A package already pinned in the lockfile is no longer resolved again and rejected for being less than 3 days old.
