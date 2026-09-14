-- Profile pictures (spec: user settings) — asset name served via /api/avatar/<name>.
ALTER TABLE "users" ADD COLUMN "image" TEXT;

-- Incognito chats — ephemeral, auto-deleted on leave/close (spec: incognito).
ALTER TABLE "conversations" ADD COLUMN "incognito" BOOLEAN NOT NULL DEFAULT false;
