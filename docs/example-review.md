# Example: a review's summary comment

**This is an example, not a real review.** It's the summary comment as LGTMoose's renderer (`packages/summary`) writes it for the made-up pull request in its own tests, with the ticket section left out: it only appears when a ticket provider is set up (see [Ticket coverage](tickets.md)). A real review also posts inline comments on the lines its findings cite, a check run and a status label.

> ## LGTMoose review
>
> ### Walkthrough
>
> Fixes the total\.
>
> Moves sum into src\/math and updates the import\.
>
> ### Changes
>
> 5 files changed, +246 −14.
>
> | File                              | Status   | Lines   | Review                       |
> | --------------------------------- | -------- | ------- | ---------------------------- |
> | package\-lock\.json               | modified | +40 −12 | skipped (lockfile)           |
> | src\/app\.ts                      | modified | +3 −1   | imports only                 |
> | src\/sum\.ts → src\/math\/sum\.ts | renamed  | +0 −0   | moved only                   |
> | src\/total\.ts                    | modified | +3 −1   | full review                  |
> | vendor\/lib\/a\.js                | added    | +200 −0 | skipped (vendored, new code) |
>
> ### Review status
>
> - **Commit:** `0123456789ab`
> - **Decision:** Changes requested
> - **Label:** Requires Changes
> - **Open findings:** 3 (1 blocking, 1 should fix, 1 nit)
>   - 2 more findings past the per-batch limit, least severe first, weren't posted
> - **Files reviewed:** 3 (1 full review, 1 imports only, 1 moved only)
> - **Files skipped:** 2 (1 lockfile, 1 vendored)
> - **New code, not reviewed:** 1 file added to vendored, build or generated paths
>   - vendor\/lib\/a\.js
> - **Dependency changes to check:**
>   - package\-lock\.json
>     - 1 package resolves from evil\.example\.com\, not a known registry \(first at line 10\)
> - **Convention files left out** (over the size limit): 1 file
>   - docs\/agents\/extra\.md
> - **Rule pack problems** (check `rulepacks` in `.lgtmoose.yaml` and the files in `rules/`): 1 problem
>   - Unknown rule pack \"typscript\"\. The built\-in packs are\: generic\, security\.
>
> ### Open findings
>
> | Severity   | Where                 | Finding                   |
> | ---------- | --------------------- | ------------------------- |
> | Blocking   | src\/total\.ts:9      | Loop skips the last item  |
> | Should fix | src\/total\.ts:10\-12 | No test for an empty list |
> | Nit        | src\/app\.ts:2        | Unused import             |
