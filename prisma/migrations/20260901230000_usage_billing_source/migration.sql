-- Sandbox agent tier (v0.4): usage rows carry who paid.
--   billing_source  "api" (the org's key; cost_estimate is real) or
--                   "subscription" (the operator's plan; cost_estimate is 0
--                   and notional_cost holds the API-rate equivalent).
--   agent_session_id  the agent session a Sandbox call belonged to.
-- Every existing row was API-billed, hence the default.
ALTER TABLE "usage_records" ADD COLUMN "billing_source" TEXT NOT NULL DEFAULT 'api';
ALTER TABLE "usage_records" ADD COLUMN "notional_cost" DECIMAL(10,6);
ALTER TABLE "usage_records" ADD COLUMN "agent_session_id" TEXT;
CREATE INDEX "usage_records_billing_source_created_at_idx" ON "usage_records"("billing_source", "created_at");
