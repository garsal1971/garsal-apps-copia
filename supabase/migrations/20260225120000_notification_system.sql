-- ============================================================
-- Sistema notifiche trasversale — garsal-apps
-- Migration: 20260225120000_notification_system
--
-- Tabelle create:
--   1. cm_user_notification_settings  — config per utente (Telegram, Push)
--   2. cm_notification_rules          — regole scritte/cancellate dalle app
--   3. cm_notification_queue          — coda pre-calcolata da Job 1, letta da Job 2
--
-- Flusso:
--   [APP] → cm_notification_rules
--   [Job 1 / ogni 6h] → legge regole + popola cm_notification_queue
--   [Job 2 / ogni 1m] → legge queue + manda Telegram
-- ============================================================


-- ============================================================
-- 1. cm_user_notification_settings
-- ============================================================
CREATE TABLE IF NOT EXISTS cm_user_notification_settings (
    id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             uuid        NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
    telegram_chat_id    text,
    telegram_enabled    boolean     NOT NULL DEFAULT false,
    push_enabled        boolean     NOT NULL DEFAULT false,
    push_token          text,                          -- Web Push token (futuro)
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);

-- Aggiorna updated_at automaticamente
CREATE OR REPLACE FUNCTION cm_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_cm_user_notification_settings_updated_at
    BEFORE UPDATE ON cm_user_notification_settings
    FOR EACH ROW EXECUTE FUNCTION cm_set_updated_at();

-- RLS
ALTER TABLE cm_user_notification_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Utente vede solo le proprie impostazioni"
    ON cm_user_notification_settings
    FOR ALL
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);


-- ============================================================
-- 2. cm_notification_rules
-- ============================================================
-- Scritte/cancellate dalle app al salvataggio di task, habit, ecc.
-- NON contengono fire_at — quello viene calcolato da Job 1.
-- ============================================================
CREATE TABLE IF NOT EXISTS cm_notification_rules (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    app             text        NOT NULL CHECK (app IN ('tasks', 'habits', 'events', 'weight')),
    entity_id       text        NOT NULL,              -- uuid del task / habit / ecc.
    entity_type     text        NOT NULL,              -- 'task' | 'habit' | 'objective'
    offset_minutes  integer     NOT NULL CHECK (offset_minutes > 0),
    offset_label    text        NOT NULL,              -- '1 giorno' — per display nelle app
    channel         text        NOT NULL DEFAULT 'telegram'
                                CHECK (channel IN ('telegram', 'browser', 'push')),
    enabled         boolean     NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now(),

    -- Evita regole duplicate per la stessa entità/offset/canale
    UNIQUE (user_id, app, entity_id, offset_minutes, channel)
);

CREATE INDEX idx_rules_user_app ON cm_notification_rules (user_id, app);
CREATE INDEX idx_rules_entity   ON cm_notification_rules (app, entity_id);

-- RLS
ALTER TABLE cm_notification_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Utente gestisce solo le proprie regole"
    ON cm_notification_rules
    FOR ALL
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);


-- ============================================================
-- 3. cm_notification_queue
-- ============================================================
-- Riempita da Job 1 (Edge Function fill-notification-queue).
-- Letta e svuotata da Job 2 (Edge Function send-notifications).
-- Le app non scrivono mai qui direttamente.
-- ============================================================
CREATE TABLE IF NOT EXISTS cm_notification_queue (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    rule_id     uuid        NOT NULL REFERENCES cm_notification_rules(id) ON DELETE CASCADE,
    user_id     uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    app         text        NOT NULL,
    entity_id   text        NOT NULL,
    title       text        NOT NULL,                  -- es. '🔔 Promemoria: Chiamare medico'
    body        text        NOT NULL,                  -- es. '1 giorno prima — scad. 26/02/2026'
    channel     text        NOT NULL,
    fire_at     timestamptz NOT NULL,
    status      text        NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending', 'sent', 'failed', 'cancelled')),
    created_at  timestamptz NOT NULL DEFAULT now(),

    -- Evita duplicati se Job 1 gira più volte prima che Job 2 consumi la riga
    UNIQUE (rule_id, fire_at)
);

CREATE INDEX idx_queue_fire_at_status ON cm_notification_queue (fire_at, status)
    WHERE status = 'pending';

-- RLS (solo service_role / cron job può scrivere; utente può solo leggere le proprie)
ALTER TABLE cm_notification_queue ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Utente legge la propria queue"
    ON cm_notification_queue
    FOR SELECT
    USING (auth.uid() = user_id);

-- Job 1 e Job 2 usano service_role → bypassano RLS, nessuna policy da aggiungere.


-- ============================================================
-- Fine migration
-- ============================================================
