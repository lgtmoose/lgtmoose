---
"lgtmoose": patch
---

A review with one batch sends its shared context in the batch's prompt instead of a separate turn, since no other batch would read the cache. A convention file that copies one already read, with only its own title or a few lines of its own, is sent once.
