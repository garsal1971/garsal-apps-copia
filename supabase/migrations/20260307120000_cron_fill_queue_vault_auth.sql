-- ============================================================
-- Fix cron fill-notification-queue: usa Vault per la service role key
-- Migration: 20260307120000_cron_fill_queue_vault_auth
--
-- Il cron precedente usava current_setting('app.supabase_service_role_key')
-- che restituisce NULL se la key è nel Vault → Authorization: Bearer null → 401
-- Ora allineato alla stessa logica di send-notifications.
-- ============================================================

SELECT cron.unschedule('fill-notification-queue');

SELECT cron.schedule(
    'fill-notification-queue',
    '0 */6 * * *',
    $$
    SELECT net.http_post(
        url     := 'https://jajlmmdsjlvzgcxiiypk.supabase.co/functions/v1/fill-notification-queue',
        headers := jsonb_build_object(
            'Content-Type',  'application/json',
            'Authorization', 'Bearer ' || (
                SELECT decrypted_secret
                FROM   vault.decrypted_secrets
                WHERE  name = 'supabase_service_role_key'
                LIMIT  1
            )
        ),
        body    := '{}'::jsonb
    ) AS request_id;
    $$
);


-- ============================================================
-- Verifica
-- SELECT jobname, schedule FROM cron.job WHERE jobname = 'fill-notification-queue';
-- ============================================================
