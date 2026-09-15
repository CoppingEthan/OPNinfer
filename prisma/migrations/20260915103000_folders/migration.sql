-- Folders: a person's own grouping for chats.
--
-- The filing is PER PERSON, mirroring `pinned`: the owner's lives on the
-- conversation, a member's on their membership row. Two people in a shared
-- chat can therefore file it differently, or not at all, and tidying never
-- rearranges someone else's sidebar.
--
-- Both foreign keys are ON DELETE SET NULL on purpose: deleting a folder is
-- a tidying action and must never take chats with it. They simply return to
-- the date-grouped list.

-- AlterTable
ALTER TABLE "conversation_members" ADD COLUMN     "folder_id" UUID;
-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "folder_id" UUID;
-- CreateTable
CREATE TABLE "folders" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "folders_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE INDEX "folders_user_id_idx" ON "folders"("user_id");
-- CreateIndex
CREATE UNIQUE INDEX "folders_user_id_name_key" ON "folders"("user_id", "name");
-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_folder_id_fkey" FOREIGN KEY ("folder_id") REFERENCES "folders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "conversation_members" ADD CONSTRAINT "conversation_members_folder_id_fkey" FOREIGN KEY ("folder_id") REFERENCES "folders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "folders" ADD CONSTRAINT "folders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
