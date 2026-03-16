-- ============================================================
-- Migration: task_complete — GRANT a service_role
-- Data: 2026-03-16
--
-- Problema: il webhook Telegram usa il client Supabase con
--   SERVICE_ROLE_KEY → il ruolo Postgres è 'service_role'.
--   La funzione task_complete aveva GRANT solo a 'authenticated',
--   quindi in ambienti dove Supabase ha revocato PUBLIC EXECUTE,
--   service_role non riusciva a invocarla → il bottone "✅ Fatto"
--   nei messaggi Telegram per i task falliva silenziosamente.
--
-- Fix: aggiunge GRANT EXECUTE a service_role per task_complete
--   e, per coerenza, anche a habit_post_completion (chiamata
--   anch'essa dal webhook con service_role).
-- ============================================================

GRANT EXECUTE ON FUNCTION task_complete(uuid, date) TO service_role;
GRANT EXECUTE ON FUNCTION habit_post_completion(uuid, date) TO service_role;
