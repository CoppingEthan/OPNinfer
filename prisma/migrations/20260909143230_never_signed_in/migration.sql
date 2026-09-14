-- The last time a password actually WORKED on this portal.
--
-- `last_active_at` cannot answer that on a migrated portal: the Open WebUI
-- importer carries the OLD system's value across, so a dormant account that
-- has never once been used here still shows a date from 2025. This column is
-- stamped only by a successful sign-in here, which is what makes it safe to
-- act on: an account whose password has never worked has nothing to lose by
-- being handed a temporary one.
ALTER TABLE "users" ADD COLUMN     "last_sign_in_at" TIMESTAMP(3);

-- BACK-FILL, DELIBERATELY GENEROUS.
--
-- A false "has signed in" costs nothing — that account simply never gets the
-- automatic offer, and an admin can still set a password by hand. A false
-- "never signed in" would let a failed sign-in REPLACE a password somebody
-- was using. So anyone with any evidence of having got in is marked, and
-- only accounts with none at all are left NULL:
--
--   * active in the last 90 days      — they signed in to be active
--   * a password change on record     — self-service, reset, or admin-set
--   * a reset link they actually used — that completes with a new password
--   * an invite they accepted         — they chose the password themselves
--
-- Verified against production before shipping (2026-09-09): this leaves 25
-- accounts NULL across four portals — 23 of them accounts on one portal, imported
-- on 18/07/2025 that have never sent a message — and NOT ONE account that
-- has been active in the last 90 days.
UPDATE "users" u
SET "last_sign_in_at" = COALESCE(u."last_active_at", u."password_changed_at", NOW())
WHERE u."last_active_at" > NOW() - INTERVAL '90 days'
   OR u."password_changed_at" IS NOT NULL
   OR EXISTS (
        SELECT 1 FROM "password_reset_tokens" t
        WHERE t."user_id" = u."id" AND t."used_at" IS NOT NULL
      )
   OR EXISTS (
        SELECT 1 FROM "invites" i
        WHERE lower(i."email") = lower(u."email") AND i."accepted_at" IS NOT NULL
      );
