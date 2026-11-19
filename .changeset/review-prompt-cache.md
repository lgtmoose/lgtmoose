---
"lgtmoose": patch
---

A review batch sends only the comments on its own files, and identical convention files once. Claude Code sends the shared context as its own turn and resumes with the diff, and batches after the first wait `batchStaggerSeconds` (30 by default) so they can read the first batch's prompt cache.
