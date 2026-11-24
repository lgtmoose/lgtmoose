---
"lgtmoose": minor
---

Show what each review run decided (NIC-1145). Every succeeded run now records its decision (approve, changes requested or comment) and the open findings it counted, a quiet run included; migration 0027 adds the columns and backfills older runs' decision from the review they posted. The dashboard's Review runs page has a Decision column and filters by pull request, and a pull request's findings page starts with its latest decision. `lgtmoose findings` starts with the same line (its `--format json` output is now `{ "decision", "findings" }`), and the new `lgtmoose runs owner/repo#123` lists a pull request's runs with what each decided.
