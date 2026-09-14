-- Repair tied message timestamps left by the Open WebUI import (2026-09-10).
--
-- OWUI stamps a question and its answer with the same SECOND. With ties,
-- `ORDER BY created_at` leaves the order to the database's sort, which on a
-- physically reordered table put the ANSWER first in half of one chat's pairs
-- and picked a different half on every turn — shuffling the history the model
-- was sent (so the prompt cache never matched) and what the user saw.
--
-- Within each tied group: user first, then assistant, then anything else,
-- then id; each later row moves forward by one millisecond. Source clocks
-- were whole seconds, so nobody can see the difference. The app also orders
-- ties itself now (src/lib/thread-order.ts); this makes plain SQL agree.
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY conversation_id, created_at
           ORDER BY CASE role::text WHEN 'user' THEN 0 WHEN 'assistant' THEN 1 WHEN 'system' THEN 2 ELSE 3 END, id
         ) - 1 AS k,
         count(*) OVER (PARTITION BY conversation_id, created_at) AS n
  FROM messages
)
UPDATE messages m
SET created_at = m.created_at + (r.k * interval '1 millisecond')
FROM ranked r
WHERE r.id = m.id AND r.n > 1 AND r.k > 0;
