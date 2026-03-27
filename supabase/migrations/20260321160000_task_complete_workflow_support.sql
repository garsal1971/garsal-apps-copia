-- ============================================================
-- Migration: aggiunge supporto workflow a task_complete
-- Data: 2026-03-21
--
-- La funzione task_complete era l'unico punto di completamento
-- per tutti i tipi di task, ma per i workflow ritornava errore
-- "workflow non supportato".
--
-- Fix: task_complete ora gestisce anche i workflow:
--   - se non tutti gli step sono done  → {ok:true, action:'step_completed'}
--   - se tutti completati (nessun failed) → termina il task, {ok:true, action:'completed'}
--   - se tutti done ma qualcuno failed  → {ok:true, action:'partial'} (utente decide)
--
-- Il JS (completeWorkflowStep) aggiorna lo step nel JSON workflow_steps
-- e poi chiama task_complete, che legge il DB aggiornato e decide.
-- ============================================================

CREATE OR REPLACE FUNCTION public.task_complete(p_task_id uuid, p_today date)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_task                ts_tasks%ROWTYPE;
  v_from_status         text;
  v_points              integer;
  v_action              text        := 'completed';
  v_next_date           date;
  v_next_ts             timestamptz;
  v_completed_date      timestamptz;

  -- workflow
  v_all_steps_completed boolean;
  v_all_steps_done      boolean;
  v_wf_pts              jsonb;

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

  v_from_status    := v_task.status;
  v_points         := COALESCE(v_task.success_points, 0);
  v_completed_date := COALESCE(
    v_task.next_occurrence_date::timestamptz,
    v_task.start_date::timestamptz,
    now()
  );

  -- -------------------------------------------------------
  -- WORKFLOW: logica basata sullo stato degli step nel JSON
  -- -------------------------------------------------------
  IF v_task.type = 'workflow' THEN
    IF v_task.workflow_steps IS NULL OR jsonb_array_length(v_task.workflow_steps) = 0 THEN
      RETURN jsonb_build_object('ok', false, 'error', 'workflow senza step');
    END IF;

    SELECT
      bool_and((s->>'status') = 'completed'),
      bool_and((s->>'status') IN ('completed', 'failed'))
    INTO v_all_steps_completed, v_all_steps_done
    FROM jsonb_array_elements(v_task.workflow_steps) AS s;

    IF NOT v_all_steps_done THEN
      -- Workflow ancora in corso: nessun completamento del task
      RETURN jsonb_build_object('ok', true, 'action', 'step_completed', 'type', 'workflow');
    END IF;

    IF NOT v_all_steps_completed THEN
      -- Tutti done ma qualcuno failed: l'utente decide manualmente dal popup
      RETURN jsonb_build_object('ok', true, 'action', 'partial', 'type', 'workflow');
    END IF;

    -- Tutti gli step sono 'completed': termina il workflow
    v_wf_pts := COALESCE(v_task.workflow_points, '{}'::jsonb);
    v_points  := COALESCE((v_wf_pts->>'task_success')::integer, 0);

    INSERT INTO ts_history (task_id, from_status, to_status, action, points, timestamp)
    VALUES (p_task_id, v_from_status, 'terminated', 'completed', v_points, now());

    UPDATE ts_tasks
       SET status              = 'terminated',
           last_completed_date = now()
     WHERE id = p_task_id;

    DELETE FROM cm_notification_rules
     WHERE entity_id = p_task_id
       AND app = 'tasks';

    RETURN jsonb_build_object('ok', true, 'action', 'completed', 'points', v_points, 'type', 'workflow');
  END IF;

  -- -------------------------------------------------------
  -- Per task singoli con deadline: controlla se in ritardo
  IF v_task.type = 'single' AND v_task.deadline IS NOT NULL THEN
    IF p_today > v_task.deadline::date THEN
      v_points := COALESCE(v_task.late_points, 0);
      v_action  := 'completed_late';
    END IF;
  END IF;

  -- Record history: completamento
  INSERT INTO ts_history (task_id, from_status, to_status, action, points, timestamp)
  VALUES (p_task_id, v_from_status, 'completed', 'completed', v_points, now());

  -- -------------------------------------------------------
  IF v_task.type = 'single' THEN
    UPDATE ts_tasks
       SET status               = 'terminated',
           last_completed_date  = v_completed_date
     WHERE id = p_task_id;

    INSERT INTO ts_history (task_id, from_status, to_status, action, points, timestamp)
    VALUES (p_task_id, 'completed', 'terminated', 'terminated', 0, now());

    DELETE FROM cm_notification_rules
     WHERE entity_id = p_task_id
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

    UPDATE cm_notification_rules
       SET reminder_presets = reminder_presets || jsonb_build_object('due_at', v_next_ts)
     WHERE entity_id = p_task_id
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
      INSERT INTO ts_history (task_id, from_status, to_status, action, points, timestamp)
      VALUES (p_task_id, 'completed', 'terminated', 'terminated', 0, now());

      DELETE FROM cm_notification_rules
       WHERE entity_id = p_task_id
         AND app = 'tasks';
    ELSE
      UPDATE cm_notification_rules
         SET reminder_presets = reminder_presets || jsonb_build_object('due_at', v_next_ts)
       WHERE entity_id = p_task_id
         AND app = 'tasks';
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
      INSERT INTO ts_history (task_id, from_status, to_status, action, points, timestamp)
      VALUES (p_task_id, 'completed', 'terminated', 'terminated', 0, now());

      DELETE FROM cm_notification_rules
       WHERE entity_id = p_task_id
         AND app = 'tasks';
    ELSE
      UPDATE cm_notification_rules
         SET reminder_presets = reminder_presets || jsonb_build_object('due_at', v_next_str::timestamptz)
       WHERE entity_id = p_task_id
         AND app = 'tasks';
    END IF;

  -- -------------------------------------------------------
  ELSE -- free_repeat
    UPDATE ts_tasks
       SET status              = 'completed',
           last_completed_date = v_completed_date
     WHERE id = p_task_id;
  END IF;

  RETURN jsonb_build_object(
    'ok',     true,
    'action', v_action,
    'points', v_points,
    'type',   v_task.type
  );
END;
$$;

GRANT EXECUTE ON FUNCTION task_complete(uuid, date) TO authenticated;
GRANT EXECUTE ON FUNCTION task_complete(uuid, date) TO service_role;
