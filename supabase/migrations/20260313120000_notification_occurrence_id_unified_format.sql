-- Refactoring occurrenze notifiche: formato occurrence_id unificato
--
-- PRIMA (task): occurrence_id = "{rule_id}"
--   → tutte le notifiche di un task condividevano un ID senza data/ora
--
-- DOPO (task e habit): occurrence_id = "{rule_id}:{YYYY-MM-DD}:{HH:MM}"
--   → ogni occorrenza (entity + data + ora) ha un ID univoco
--   → più notifiche della stessa occorrenza (preset diversi) condividono l'ID
--   → si distinguono solo per fire_at
--
-- Formato body unificato per task e habit:
--   "{entity_title} — {preset_label} prima — DD/MM/YYYY[ ore HH:MM]"
--   (l'ora è omessa se è 00:00, ossia task con solo data senza orario)
--
-- La funzione fill-notification-queue gestisce già il cleanup automatico
-- (delete pending → upsert) ad ogni esecuzione. Questa migrazione pulisce
-- le entry pending dei task con il vecchio formato per evitare orfane.

DELETE FROM cm_notification_queue
WHERE status IN ('pending', 'snoozed')
  AND app = 'tasks'
  AND occurrence_id IS NOT NULL
  AND occurrence_id NOT LIKE '%:%';
-- vecchio formato: solo UUID (es. "abc123-...") senza separatori ':'
-- nuovo formato: "abc123-...:2026-03-15:00:00"
