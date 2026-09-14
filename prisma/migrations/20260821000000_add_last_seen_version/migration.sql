-- Release notes the user has seen (What's new panel).
-- Nullable with no default on purpose: NULL means "never seen", so every
-- existing account is shown the panel once after this ships.
ALTER TABLE "users" ADD COLUMN "last_seen_version" TEXT;
