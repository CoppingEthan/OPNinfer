-- CreateEnum
CREATE TYPE "FileStatus" AS ENUM ('pending', 'processing', 'ready', 'unsupported', 'failed');

-- CreateEnum
CREATE TYPE "FileKind" AS ENUM ('upload', 'generated');

-- AlterTable
ALTER TABLE "files" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "claimed_at" TIMESTAMP(3),
ADD COLUMN     "content_path" TEXT,
ADD COLUMN     "detected_mime" TEXT,
ADD COLUMN     "error" TEXT,
ADD COLUMN     "kind" "FileKind" NOT NULL DEFAULT 'upload',
ADD COLUMN     "meta" JSONB,
ADD COLUMN     "processor_group" TEXT,
ADD COLUMN     "status" "FileStatus" NOT NULL DEFAULT 'pending',
ADD COLUMN     "token_estimate" INTEGER;

-- CreateIndex
CREATE INDEX "files_status_idx" ON "files"("status");
