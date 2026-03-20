-- ============================================================
-- Aggiunge 'quick' ai CHECK constraint di cm_notification_rules
-- Migration: 20260320143000_notification_rules_add_quick_app
--
-- Permette di salvare notifiche rapide ("Notifica al Volo")
-- con app='quick' ed entity_type='quick'.
-- ============================================================

-- 1. Allarga il CHECK su app
ALTER TABLE cm_notification_rules
    DROP CONSTRAINT IF EXISTS cm_notification_rules_app_check;

ALTER TABLE cm_notification_rules
    ADD CONSTRAINT cm_notification_rules_app_check
        CHECK (app IN ('tasks', 'habits', 'events', 'weight', 'quick'));

-- 2. Allarga il CHECK su entity_type
ALTER TABLE cm_notification_rules
    DROP CONSTRAINT IF EXISTS chk_entity_type;

ALTER TABLE cm_notification_rules
    ADD CONSTRAINT chk_entity_type
        CHECK (entity_type IN ('task', 'habit', 'event', 'objective', 'quick'));
