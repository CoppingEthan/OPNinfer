-- CreateTable
CREATE TABLE "message_feedback" (
    "id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "conversation_title" TEXT,
    "user_id" UUID,
    "rating" TEXT NOT NULL,
    "model" TEXT,
    "provider" TEXT,
    "user_text" TEXT NOT NULL,
    "assistant_text" TEXT NOT NULL,
    "summary" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "message_feedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "message_feedback_message_id_key" ON "message_feedback"("message_id");

-- CreateIndex
CREATE INDEX "message_feedback_created_at_idx" ON "message_feedback"("created_at");

-- CreateIndex
CREATE INDEX "message_feedback_rating_idx" ON "message_feedback"("rating");

-- AddForeignKey
ALTER TABLE "message_feedback" ADD CONSTRAINT "message_feedback_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
