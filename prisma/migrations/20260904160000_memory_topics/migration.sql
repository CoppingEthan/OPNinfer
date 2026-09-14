-- Memory v2 (0.6 — docs/V06_MEMORY.md): four named notes per person replace
-- the flat list of one-line memories.
--
-- Generated with `prisma migrate diff` from the schema, plus ONE hand-written
-- step that must run BEFORE the old table is dropped: every existing memory
-- is folded into the person's "About you" note as a bullet line, oldest
-- first, so nothing anyone told the assistant is lost. The next idle-chat
-- memory pass sorts those lines into the right notes.

-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "memory_pass_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "memory_paused" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "user_memory_topics" (
    "id" SERIAL NOT NULL,
    "user_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_memory_topics_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_memory_topics_user_id_key_key" ON "user_memory_topics"("user_id", "key");

-- AddForeignKey
ALTER TABLE "user_memory_topics" ADD CONSTRAINT "user_memory_topics_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Fold every existing memory into the person's "About you" note.
INSERT INTO "user_memory_topics" ("user_id", "key", "text", "created_at", "updated_at")
SELECT m."user_id",
       'about',
       string_agg('- ' || btrim(m."content"), E'\n' ORDER BY m."created_at", m."id"),
       min(m."created_at"),
       CURRENT_TIMESTAMP
FROM "user_memories" m
WHERE btrim(m."content") <> ''
GROUP BY m."user_id";

-- DropForeignKey
ALTER TABLE "user_memories" DROP CONSTRAINT "user_memories_user_id_fkey";

-- DropTable
DROP TABLE "user_memories";
