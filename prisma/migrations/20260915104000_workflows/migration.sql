-- Workflows: a person's own playbook for a recurring job, shareable.
--
-- Same shape as shared chats, on purpose: one copy, plus a members table
-- whose rows ARE the sharing (the owner included once shared). An edit by
-- anyone with access is therefore seen by everyone, which is what makes a
-- shared workflow worth having rather than a copy that quietly drifts.

-- CreateTable
CREATE TABLE "workflows" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "last_used_at" TIMESTAMP(3),
    "noted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "workflows_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "workflow_members" (
    "id" UUID NOT NULL,
    "workflow_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "invited_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "workflow_members_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE INDEX "workflows_user_id_idx" ON "workflows"("user_id");
-- CreateIndex
CREATE UNIQUE INDEX "workflows_user_id_name_key" ON "workflows"("user_id", "name");
-- CreateIndex
CREATE INDEX "workflow_members_user_id_idx" ON "workflow_members"("user_id");
-- CreateIndex
CREATE UNIQUE INDEX "workflow_members_workflow_id_user_id_key" ON "workflow_members"("workflow_id", "user_id");
-- AddForeignKey
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "workflow_members" ADD CONSTRAINT "workflow_members_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "workflows"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "workflow_members" ADD CONSTRAINT "workflow_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
