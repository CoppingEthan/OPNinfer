-- CreateTable
CREATE TABLE "conversation_compactions" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "summary" TEXT NOT NULL,
    "boundary_message_id" UUID NOT NULL,
    "boundary_at" TIMESTAMP(3) NOT NULL,
    "messages_covered" INTEGER NOT NULL,
    "tokens_before" INTEGER NOT NULL,
    "tokens_after" INTEGER NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_compactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "conversation_compactions_conversation_id_created_at_idx" ON "conversation_compactions"("conversation_id", "created_at");

-- AddForeignKey
ALTER TABLE "conversation_compactions" ADD CONSTRAINT "conversation_compactions_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
