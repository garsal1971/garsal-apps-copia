-- Aggiorna il check constraint su ts_history.action per includere tutti i valori usati
-- dall'applicazione e dalle RPC functions.
--
-- Valori originali (pre-migrazione):
--   completed, failed, terminated, archived, skipped, reactivated
--
-- Valori aggiunti:
--   completed_late  — completamento in ritardo (task_complete RPC, 20260313220000)
--   rollback        — storno punti (tasks.html rollbackPoints)

ALTER TABLE ts_history
  DROP CONSTRAINT IF EXISTS history_action_check;

ALTER TABLE ts_history
  ADD CONSTRAINT history_action_check
    CHECK (action IN (
      'completed',
      'completed_late',
      'failed',
      'terminated',
      'archived',
      'skipped',
      'reactivated',
      'rollback'
    ));
