-- DropForeignKey
ALTER TABLE "provider_credentials" DROP CONSTRAINT "provider_credentials_user_id_fkey";

-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "meta" JSONB;

-- AlterTable
ALTER TABLE "provider_credentials" ALTER COLUMN "user_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "usage_records" ADD COLUMN     "role" TEXT;

-- CreateTable
CREATE TABLE "app_log" (
    "id" UUID NOT NULL,
    "level" TEXT NOT NULL DEFAULT 'info',
    "category" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "details" JSONB,
    "user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "app_log_created_at_idx" ON "app_log"("created_at");

-- AddForeignKey
ALTER TABLE "provider_credentials" ADD CONSTRAINT "provider_credentials_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
