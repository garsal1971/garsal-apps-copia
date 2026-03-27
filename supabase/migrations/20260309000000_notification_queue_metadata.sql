-- ============================================================
-- Migration: 20260309000000_notification_queue_metadata
--
-- Aggiunge la colonna metadata jsonb alla tabella
-- cm_notification_queue per trasportare dati aggiuntivi
-- dalla regola alla queue entry (es. completion_update per
-- il pulsante "Fatto" nei messaggi Telegram degli habits).
-- ============================================================

ALTER TABLE cm_notification_queue
  ADD COLUMN IF NOT EXISTS metadata jsonb DEFAULT NULL;

-- ============================================================
-- Fine migration
-- ============================================================
