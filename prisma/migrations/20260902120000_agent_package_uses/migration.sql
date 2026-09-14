-- What the Sandbox agent reaches for at runtime (pip/npm/apt installs,
-- external downloads, clones). Plain columns, no FKs: the tally outlives
-- chats and accounts, like usage_records.
CREATE TABLE "agent_package_uses" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "conversation_id" UUID,
    "user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_package_uses_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "agent_package_uses_kind_name_idx" ON "agent_package_uses"("kind", "name");
CREATE INDEX "agent_package_uses_created_at_idx" ON "agent_package_uses"("created_at");
