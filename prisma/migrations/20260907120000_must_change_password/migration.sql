-- An admin-set password is TEMPORARY: the person can sign in with it and then
-- must choose their own before they can do anything else.
--
-- Added 2026-09-07 because emailed reset links are being delivered to the
-- recipient's mail system and blocked there, so the operator hands the
-- password over by another route — and a password someone else knows must
-- not remain live.
--
-- Defaults to false, so every existing account is unaffected.
ALTER TABLE "users" ADD COLUMN "must_change_password" BOOLEAN NOT NULL DEFAULT false;
