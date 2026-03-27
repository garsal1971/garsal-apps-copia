-- ============================================================
-- Migration: task_complete_via_telegram — sync notification rule
-- Data: 2026-03-13
-- Problema: dopo il complete via Telegram, la regola in
--   cm_notification_rules.reminder_presets.due_at rimaneva
--   sulla vecchia data → fill-notification-queue non generava
--   le notifiche per la prossima occorrenza.
-- Fix: aggiunge UPDATE/DELETE della regola dopo ogni tipo di
--   completamento, replicando la logica di syncNotificationRules()
--   in tasks.html.
-- ============================================================

CREATE OR REPLACE FUNCTION task_complete_via_telegram(
  p_task_id  uuid,
  p_today    date
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_task           ts_tasks%ROWTYPE;
  v_from_status    text;
  v_points         integer;
  v_action         text        := 'completed';
  v_next_date      date;
  v_next_ts        timestamptz;
  v_completed_date timestamptz;

  -- multiple
  v_dates    text[];
  v_cur_str  text;
  v_cur_idx  integer := NULL;
  v_next_str text    := NULL;
  j          integer;
BEGIN
  SELECT * INTO v_task FROM ts_tasks WHERE id = p_task_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'task non trovato');
  END IF;

  IF v_task.type = 'workflow' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'workflow non supportato via Telegram');
  END IF;

  v_from_status    := v_task.status;
  v_points         := COALESCE(v_task.success_points, 0);
  v_completed_date := COALESCE(
    v_task.next_occurrence_date::timestamptz,
    v_task.start_date::timestamptz,
    now()
  );

  -- Per task singoli con deadline: controlla se in ritardo
  IF v_task.type = 'single' AND v_task.deadline IS NOT NULL THEN
    IF p_today > v_task.deadline::date THEN
      v_points := COALESCE(v_task.late_points, 0);
      v_action  := 'completed_late';
    END IF;
  END IF;

  -- Inserisci il record history principale (action sempre 'completed', come nel JS)
  INSERT INTO ts_history (task_id, from_status, to_status, action, points, timestamp)
  VALUES (p_task_id, v_from_status, 'completed', 'completed', v_points, now());

  -- -------------------------------------------------------
  IF v_task.type = 'single' THEN
    UPDATE ts_tasks
       SET status               = 'terminated',
           last_completed_date  = v_completed_date
     WHERE id = p_task_id;

    -- Task terminato: elimina la regola di notifica
    DELETE FROM cm_notification_rules
     WHERE entity_id = p_task_id::text
       AND app = 'tasks';

  -- -------------------------------------------------------
  ELSIF v_task.type = 'simple_recurring' THEN
    v_next_ts := COALESCE(v_task.next_occurrence_date::timestamptz, v_task.start_date::timestamptz)
                 + (COALESCE(v_task.repeat_after_days, 7) || ' days')::interval;

    UPDATE ts_tasks
       SET status               = 'completed',
           last_completed_date  = v_completed_date,
           next_occurrence_date = v_next_ts
     WHERE id = p_task_id;

    -- Aggiorna due_at nella regola → fill-queue genererà la notifica sulla nuova data
    UPDATE cm_notification_rules
       SET reminder_presets = reminder_presets || jsonb_build_object('due_at', v_next_ts)
     WHERE entity_id = p_task_id::text
       AND app = 'tasks';

  -- -------------------------------------------------------
  ELSIF v_task.type = 'recurring' THEN
    v_next_date := task_next_recurring_date(
      v_task,
      COALESCE(v_task.next_occurrence_date::text, v_task.start_date::text)::date
    );

    IF v_next_date IS NOT NULL THEN
      v_next_ts := v_next_date::timestamptz;
    END IF;

    UPDATE ts_tasks
       SET status               = CASE WHEN v_next_date IS NULL THEN 'terminated' ELSE 'completed' END,
           last_completed_date  = v_completed_date,
           next_occurrence_date = v_next_ts
     WHERE id = p_task_id;

    IF v_next_date IS NULL THEN
      -- Nessuna prossima occorrenza: elimina la regola
      DELETE FROM cm_notification_rules
       WHERE entity_id = p_task_id::text
         AND app = 'tasks';
    ELSE
      -- Aggiorna due_at con la nuova occorrenza
      UPDATE cm_notification_rules
         SET reminder_presets = reminder_presets || jsonb_build_object('due_at', v_next_ts)
       WHERE entity_id = p_task_id::text
         AND app = 'tasks';
    END IF;

    IF v_next_date IS NULL THEN
      INSERT INTO ts_history (task_id, from_status, to_status, action, points, timestamp)
      VALUES (p_task_id, 'completed', 'terminated', 'terminated', 0, now());
    END IF;

  -- -------------------------------------------------------
  ELSIF v_task.type = 'multiple' THEN
    SELECT array_agg(d ORDER BY d)
      INTO v_dates
      FROM jsonb_array_elements_text(v_task.multiple_dates::jsonb) AS d;

    v_cur_str := split_part(COALESCE(v_task.next_occurrence_date::text, ''), 'T', 1);

    FOR j IN 1..array_length(v_dates, 1) LOOP
      IF v_dates[j] = v_cur_str THEN
        v_cur_idx := j;
        EXIT;
      END IF;
    END LOOP;

    IF v_cur_idx IS NOT NULL AND v_cur_idx < array_length(v_dates, 1) THEN
      v_next_str := v_dates[v_cur_idx + 1] || 'T00:00:00';
    END IF;

    UPDATE ts_tasks
       SET status               = CASE WHEN v_next_str IS NULL THEN 'terminated' ELSE 'completed' END,
           last_completed_date  = v_completed_date,
           next_occurrence_date = v_next_str::timestamptz
     WHERE id = p_task_id;

    IF v_next_str IS NULL THEN
      -- Ultima data: elimina la regola
      DELETE FROM cm_notification_rules
       WHERE entity_id = p_task_id::text
         AND app = 'tasks';

      INSERT INTO ts_history (task_id, from_status, to_status, action, points, timestamp)
      VALUES (p_task_id, 'completed', 'terminated', 'terminated', 0, now());
    ELSE
      -- Aggiorna due_at con la prossima data dell'array
      UPDATE cm_notification_rules
         SET reminder_presets = reminder_presets || jsonb_build_object('due_at', v_next_str::timestamptz)
       WHERE entity_id = p_task_id::text
         AND app = 'tasks';
    END IF;

  -- -------------------------------------------------------
  ELSE -- free_repeat
    UPDATE ts_tasks
       SET status              = 'completed',
           last_completed_date = v_completed_date
     WHERE id = p_task_id;
    -- free_repeat non ha due_at fisso → nessuna modifica alla regola
  END IF;

  RETURN jsonb_build_object(
    'ok',     true,
    'action', v_action,
    'points', v_points,
    'type',   v_task.type
  );
END;
$$;

GRANT EXECUTE ON FUNCTION task_complete_via_telegram(uuid, date) TO authenticated;
