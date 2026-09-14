-- Remove the unused `anthropic-oauth` Provider enum value (subscription OAuth
-- was removed). Postgres can't drop an enum value in place, so recreate the
-- type without it and migrate the one column that uses it. Safe: no rows use
-- the value.
BEGIN;
CREATE TYPE "Provider_new" AS ENUM ('openai', 'anthropic-api', 'google');
ALTER TABLE "provider_credentials"
  ALTER COLUMN "provider" TYPE "Provider_new"
  USING ("provider"::text::"Provider_new");
ALTER TYPE "Provider" RENAME TO "Provider_old";
ALTER TYPE "Provider_new" RENAME TO "Provider";
DROP TYPE "Provider_old";
COMMIT;
