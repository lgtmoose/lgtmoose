# Rule packs

Rule packs are the review criteria LGTMoose gives the reviewer, on top of a repo's own convention files (`CLAUDE.md`, `AGENTS.md` and so on). Each rule has an id, a category, a default severity and a short example. The category is what the reviewer reports as a finding's `rule_category`.

## Turning packs on

A repo chooses its packs in `.lgtmoose.yaml`:

```yaml
rulepacks: [typescript, react, ./rules/billing.md]
```

`generic` and `security` are always on, whether or not the list names them. LGTMoose reads `.lgtmoose.yaml` from the PR's base branch, never from the PR itself, so a PR can't change the rules it's reviewed against.

An entry that can't be used, such as an unknown id, a bad file or a file that's too big, is left out, and the review goes on without it. Each review's summary comment lists what was left out and why, under **Rule packs left out**, so the repo's owners can fix their config. It never names private packs, and problems with the deployment's own packs, such as a private pack that reuses a built-in id, go only to the logs. If `generic` or `security` itself can't be loaded, the review stops rather than run without them.

## Built-in packs

| Id           | Covers                                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------------ |
| `generic`    | Correctness, error handling, basic security, authorisation, secrets, tests and wiring. Always on.      |
| `security`   | SSRF, XSS, open redirects, mass assignment, CSRF, cookies, randomness, tokens, uploads. Always on.     |
| `typescript` | Unsafe casts, `any`, floating promises, falsy zero, exhaustiveness, mutation, dates.                   |
| `react`      | Hook rules and dependencies, effect cleanup, keys, state mutation, unsafe HTML, client-side secrets.   |
| `node-api`   | Input validation, transactions, N+1 and unbounded queries, idempotent payments, money units, timeouts. |
| `ci-cd`      | Working directories, tools, permissions, untrusted triggers, script injection, pinning, signing.       |

They live in `packages/roles/rulepacks/`.

## Pack format

A pack is a markdown file with YAML front matter. The body after the front matter is optional guidance for the whole pack. The description and body are shown to the reviewer as plain paragraphs: headings, lists, quotes and code fences in them are kept as text, so they never change the prompt's structure. Put code in rule examples, which are shown as code.

```markdown
---
id: billing
title: Billing
description: Rules for the billing service.
rules:
  - id: amount-in-cents
    category: money
    severity: blocking
    rule: Amounts are stored and sent in cents, as integers.
    example: |
      await charge({ amount: order.total }); // total is in dollars
---

Optional guidance for the whole pack.
```

- `id`: lowercase letters, digits and hyphens. For built-in and private packs it must match the file name. Repo packs don't need one.
- `title`, and an optional `description`.
- `rules`: 1 to 60 rules. Each has:
  - `id`: unique within the pack.
  - `category`: lowercase `snake_case`, such as `correctness`, `security` or `tenant_scoping`.
  - `severity`: `blocking`, `should_fix` or `nit`.
  - `rule`: one or two sentences.
  - `example`: a short snippet of code that breaks the rule.

Unknown fields are rejected.

## Private packs

Private packs belong to whoever deploys LGTMoose. Put them in `packages/roles/rulepacks/private/`, one `<id>.md` file each, and repos turn them on by id like built-in packs. They ship in the control image, so a fork adds packs without changing code. A private pack can't reuse a built-in pack's id; if one does, the built-in pack is used and the clash is logged.

`examples/rulepacks/tenant-scoping.md` is an example: rules for an API whose data belongs to organisations, their locations and their consumers.

## Repo packs

A repo can add its own packs as files in its `rules/` folder:

```yaml
rulepacks: [./rules/billing.md] # one file
# or
rulepacks: [./rules/*.md] # every .md file directly in rules/
```

These are repository content, so they're treated with the same care as convention files:

- They're read from the base branch, like `.lgtmoose.yaml`.
- Only `./rules/<name>.md` and `./rules/*.md` are accepted. Paths elsewhere, `..`, nested folders and symlinks aren't read.
- Each file can be at most 16 KiB, with at most 10 files and 48 KiB in all. A file over 16 KiB is left out whole and doesn't count towards the total. With `./rules/*.md`, only files named like a pack id (lowercase letters, digits and hyphens) are read. Other `.md` files are reported as left out, except a `README.md`, which is ignored.
- They go into the prompt after the built-in and private packs, inside an untrusted block. The prompt tells the model that repo packs only add rules: they can't remove, relax or override other rules, change the severity definitions, or ask it to skip files or approve.
- A repo rule can't be softer than the built-in and private packs already are in its category. In a protected category (`authz`, `tenant_scoping`, `money`, `secrets`) it must be `blocking`. Elsewhere it can't be less severe than the least severe trusted rule in that category: a `security` rule can't be a `nit`, because the trusted packs never go below `should_fix` there. A repo rule must use a category the trusted packs in use already have, so a rule can't be relabelled out of a protected category. A rule that breaks this is left out, and the rest of its pack is kept.
