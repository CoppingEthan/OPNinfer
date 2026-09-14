-- Shared chats (v0.5 — docs/V05_SHARED_CHATS.md).
--
-- Generated with `prisma migrate diff` from the schema, plus ONE hand-written
-- statement: the back-fill of `messages.user_id`. Every existing user turn was
-- written by its chat's owner (there was no one else who could), so stamping
-- the owner on them makes NULL mean exactly one thing from now on — "the
-- author's account has since been deleted" — rather than "old row, guess".

-- DropIndex
DROP INDEX "message_feedback_message_id_key";

-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "user_id" UUID;

-- CreateTable
CREATE TABLE "conversation_members" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "invited_by_id" UUID,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "last_read_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_members_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "conversation_members_user_id_idx" ON "conversation_members"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_members_conversation_id_user_id_key" ON "conversation_members"("conversation_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "message_feedback_message_id_user_id_key" ON "message_feedback"("message_id", "user_id");

-- CreateIndex
CREATE INDEX "messages_user_id_idx" ON "messages"("user_id");

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_members" ADD CONSTRAINT "conversation_members_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_members" ADD CONSTRAINT "conversation_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Back-fill: every existing user turn was written by the chat's owner.
UPDATE "messages" m
SET "user_id" = c."user_id"
FROM "conversations" c
WHERE m."conversation_id" = c."id"
  AND m."role" = 'user'
  AND m."user_id" IS NULL;
