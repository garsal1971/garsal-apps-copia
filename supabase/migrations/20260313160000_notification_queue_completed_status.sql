-- Aggiunge lo stato 'completed' a cm_notification_queue
--
-- 'completed' viene impostato dal webhook Telegram quando l'utente clicca
-- "✅ Fatto" — si distingue da 'cancelled' (annullato senza completamento).
--
-- Richiede di ricreare il CHECK constraint perché PostgreSQL non supporta
-- ALTER CONSTRAINT in-place.

ALTER TABLE cm_notification_queue
  DROP CONSTRAINT IF EXISTS cm_notification_queue_status_check;

ALTER TABLE cm_notification_queue
  ADD CONSTRAINT cm_notification_queue_status_check
    CHECK (status IN ('pending', 'sent', 'failed', 'cancelled', 'completed'));
