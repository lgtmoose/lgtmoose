---
"lgtmoose": minor
---

Read `@lgtmoose` commands in the body of a submitted review, with the same rules as in comments. LGTMoose answers with a comment on the PR, because GitHub reviews take no reactions. A review is handled once by its ID, even when GitHub redelivers it. Review bodies without a command are left alone and never go to the reply judge.
