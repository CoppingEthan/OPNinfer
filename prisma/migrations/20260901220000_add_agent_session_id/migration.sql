-- Sandbox (agent tier): the Agent SDK session a chat's agent runs resume.
-- Nullable: NULL = no agent run yet in this conversation.
ALTER TABLE "conversations" ADD COLUMN "agent_session_id" TEXT;
