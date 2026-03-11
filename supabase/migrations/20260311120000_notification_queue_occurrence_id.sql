-- Aggiunge occurrence_id a cm_notification_queue
--
-- occurrence_id identifica una specifica occorrenza notifica:
--   habit  → "{rule_id}:{YYYY-MM-DD}:{slot_time}"  (es. "abc:2026-03-11:08:00")
--   task   → "{rule_id}"
--
-- Usato dal webhook Telegram per cancellare solo le notifiche dello stesso
-- slot/giorno, senza toccare i promemoria di altri slot o giorni futuri.

ALTER TABLE cm_notification_queue
  ADD COLUMN IF NOT EXISTS occurrence_id text;

CREATE INDEX IF NOT EXISTS idx_queue_occurrence_id
  ON cm_notification_queue (occurrence_id)
  WHERE status IN ('pending', 'snoozed', 'sending');
