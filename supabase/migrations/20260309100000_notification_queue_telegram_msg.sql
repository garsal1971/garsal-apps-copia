-- Aggiunge la colonna telegram_message_id a cm_notification_queue
-- per poter eliminare i messaggi Telegram dalla chat quando l'utente
-- interagisce con un bottone inline (Fatto / Annulla / Snooze).
ALTER TABLE cm_notification_queue
  ADD COLUMN IF NOT EXISTS telegram_message_id bigint DEFAULT NULL;
