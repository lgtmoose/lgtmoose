# @lgtmoose/db

The Postgres schema (`src/schema.ts`), its migrations (`migrations/`) and the database client.

## How to add a migration

1. Change `src/schema.ts`.
2. Write the migration:

   ```bash
   pnpm --filter @lgtmoose/db generate --name <what-it-does>
   ```

   This writes `migrations/NNNN_<what-it-does>.sql`, its snapshot `migrations/meta/NNNN_snapshot.json`, and a journal entry. `NNNN` is one more than the highest file. Anything after `generate` goes to `drizzle-kit generate`, so `--custom` works too. If drizzle-kit asks whether a column was renamed, answer it there.

3. Read the SQL. Check that it does what you meant, and that it's safe on a table that already has rows.
4. Run `pnpm --filter @lgtmoose/db check-migrations`. CI runs it as part of `pnpm run check`.
5. Commit the three files with the schema change.

### Don't run `drizzle-kit generate` directly

drizzle-kit names a migration after its journal index. Our file numbers are one above the index from 0004 on, because 0003 was never used (see below). Run directly, drizzle-kit would reuse the latest number and overwrite that migration's snapshot. `generate` runs drizzle-kit on a scratch copy of `migrations/`, then copies the result in under the right number.

### The gap at 0003

0003 was renumbered to 0005 before release, when two branches each added one, and was never applied anywhere. The gap is allowed because `SKIPPED_NUMBERS` in `scripts/migration-chain.ts` lists it. Add a number there only for the same reason: it was never applied to any database.

### What `check-migrations` checks

- Files are named `NNNN_name.sql`, and the numbers go up by one, apart from `SKIPPED_NUMBERS`.
- No two files share a number.
- The journal has one entry per file, in order, and each entry's tag is its file's name.
- Journal `when` values go up. The migrator skips an entry dated no later than the last one it applied.
- Each migration has a snapshot, and each snapshot's `prevId` is the previous snapshot's `id`.
- `src/schema.ts` has no changes that a migration doesn't cover.

### Two branches that each add a migration

Both take the same number, so after one merges the other fails `check-migrations`. On the second branch:

1. Merge `main`.
2. Delete your migration's SQL file and snapshot, and take `main`'s journal.
3. Run `generate` again.

Never edit, renumber or delete a migration that is on `main`. It may already be applied, and the migrator matches applied migrations by their hash and `when`.
