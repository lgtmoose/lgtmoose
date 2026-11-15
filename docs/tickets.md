# Ticket coverage

With a ticket provider set up, each review checks the pull request against the tickets it names and adds a **Ticket coverage** table to the summary comment. Only Linear is built so far. Without a provider, reviews work as before and the table is left out.

## Turning it on

1. Create a Linear personal API key (Linear: Settings → Security & access → Personal API keys). LGTMoose only reads tickets, but a key carries its owner's access, so use an account that can read just the teams you need.
2. Store it:

   ```bash
   pnpm lgtmoose auth linear
   ```

   It's read without echo and stored in AWS Secrets Manager as `lgtmoose/tickets/linear`, in the region from `lgtmoose.config.ts`.

3. Add `tickets` to `lgtmoose.config.ts`, then run `pnpm lgtmoose deploy`:

   ```ts
   tickets: { provider: "linear", maxPerPullRequest: 3, teamKeys: ["ENG"] },
   ```

   - `maxPerPullRequest` (1 to 10, default 3): the most tickets checked per PR.
   - `teamKeys` (default none): only these teams' keys count, such as `ENG` for `ENG-123`. Without it, any key Linear knows counts.

   See the [configuration reference](configuration.md) for every key.

## Which tickets

LGTMoose looks for ticket keys such as `ENG-123`, in this order:

1. The head branch's name, in any case (`alice/eng-123-fix-totals`).
2. The PR's title and description.
3. Its commit messages (up to 100).

Outside the branch, keys must be upper case. Prefixes that name standards rather than teams (`UTF-8`, `SHA-256`, `ISO-8601`, `CVE-…` and a few more) are left out, and so is any key Linear doesn't know. The first `maxPerPullRequest` keys found are checked.

## How a ticket is checked

1. **The control task reads the ticket** from Linear: its title, description, state, up to 30 comments, its parent and up to 25 sub-issues, with each text capped. The Linear key is read here, in the control task, the first time a ticket is fetched. No sandbox task gets it, and the sandbox's egress proxy can't reach Linear.
2. **The prompt-injection detector scans the ticket's text**, as it does the PR's description (see [Security](security.md)). A hit holds approval for the run, and the summary names the ticket.
3. **The ticket checker runs in the sandbox**, on the fast tier, with the ticket's text in untrusted blocks and the PR's checkout. It lists the ticket's requirements, marks which are core, and says for each whether the PR's code at head meets it: met, partial, missing or unclear. It can't do anything else: its answer is a checklist, validated against a schema.
4. **The post step decides what follows**, in plain code.

A checklist is kept for the commit it was made at. Later runs at the same commit (a retry, or a run for replies) reuse it until the ticket changes, so each ticket costs one fast-tier run per commit reviewed.

## What it changes

- **The summary** gets a table: each ticket, how much of its core the PR covers (covered, partly covered, not covered, unclear, or not checked), and the core requirements found missing.
- **The decision:** each missing core requirement counts as one should-fix finding, up to 5 per review. Should-fix findings keep the review from approving, but they never request changes or fail the merge. Missing requirements aren't posted as inline comments or stored as findings: they're worked out again each run.
- Partly met, unclear and non-core requirements don't count.

Coverage is a model's reading of the diff against the ticket, and the summary says so. It can be wrong both ways, so treat a missing requirement as a prompt to check, not a verdict.

## When something fails

A ticket Linear won't return (a rejected key, a network error) shows as "not checked" with the reason, and the review carries on without it. So does a checker run that fails. A missing or unreadable key fails only ticket coverage, never the review.

## Known limits

- Only Linear is built. Jira and GitHub Issues (NIC-850) are refused at config time.
- `roles.ticketExtractor` isn't used yet: the checker runs on the reviewer's provider, with the same fallbacks, on its fast tier.
- The checker reads the ticket as it is now, not as it was when the PR was opened.
- There's no way to turn ticket coverage off for one repository; it's on for every repository of the install.
- `auth linear` doesn't check the key against Linear; a wrong key shows up as "not checked" on the next review.
