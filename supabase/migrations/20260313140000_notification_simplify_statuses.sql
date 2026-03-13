-- Semplificazione stati notifiche — refactoring send-notifications
--
-- Stati attivi dopo il refactoring:
--   'pending'   — in attesa di invio (fire_at nella finestra ±5 min)
--   'sent'      — inviata con successo
--   'failed'    — invio fallito (nessun retry)
--   'cancelled' — annullata da utente o da completamento occorrenza
--
-- Stati dismessi:
--   'sending'   — rimosso: nessun retry, status va direttamente pending → sent/failed
--   'snoozed'   — rimosso: sostituito da INSERT di un nuovo row pending con nuovo fire_at
--
-- Pulizia dei row esistenti con stati dismessi:
--   'sending'/'snoozed' con fire_at recente (< 1 ora fa) → riportati a 'pending'
--   per essere raccolti dalla nuova finestra ±5 min
--   'sending'/'snoozed' con fire_at più vecchio → 'failed'

UPDATE cm_notification_queue
SET status = 'pending'
WHERE status IN ('sending', 'snoozed')
  AND fire_at >= now() - interval '1 hour';

UPDATE cm_notification_queue
SET status = 'failed'
WHERE status IN ('sending', 'snoozed')
  AND fire_at < now() - interval '1 hour';
