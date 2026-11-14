-- Nullable with no default, so adding it doesn't rewrite the table or block writes.
ALTER TABLE users ADD COLUMN display_name text;
