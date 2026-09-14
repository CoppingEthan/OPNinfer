-- Audit 2026-09-05: a password change must end the sessions issued before it.
-- NULL = never changed since this column existed; every existing session
-- stays valid until the next change.
ALTER TABLE "users" ADD COLUMN "password_changed_at" TIMESTAMP(3);
