-- Indexes for queries that were running as sequential scans.
--
-- All four are small to build at current volumes (~2k conversations, tens of
-- thousands of messages) and get more expensive to add the longer they wait.
-- Written without CONCURRENTLY because `migrate deploy` runs inside a
-- transaction and the app is not yet serving when it runs.

-- Every read of a thread is "this conversation, in time order".
CREATE INDEX IF NOT EXISTS "messages_conversation_id_created_at_idx"
  ON "messages" ("conversation_id", "created_at");

-- The image-time estimate reads the most recent assistant replies; without
-- this it scanned the whole table, inline in the turn.
CREATE INDEX IF NOT EXISTS "messages_role_created_at_idx"
  ON "messages" ("role", "created_at");

-- The sidebar: a user's chats, newest first.
CREATE INDEX IF NOT EXISTS "conversations_user_id_updated_at_idx"
  ON "conversations" ("user_id", "updated_at");

-- Admin → Logs, "Chats" view: one category, newest first.
CREATE INDEX IF NOT EXISTS "app_log_category_created_at_idx"
  ON "app_log" ("category", "created_at");
