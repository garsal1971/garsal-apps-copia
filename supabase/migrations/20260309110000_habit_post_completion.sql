-- ============================================================
-- habit_post_completion(p_habit_id, p_local_date)
--
-- Chiamata dal telegram-webhook dopo l'insert in hb_completions
-- quando l'utente clicca "Fatto" su un promemoria habit.
--
-- Calcola lo streak corrente dell'habit e, se raggiunge il goal,
-- replica la logica di completeStack() dell'app:
--   1. Archivia lo stack in hb_archived_stacks
--   2. Assegna i punti (hb_user_points + hb_points_transactions)
--   3. Marca l'habit corrente come 'completed'
--   4. Crea un nuovo stack attivo dal giorno successivo
--
-- Parametri:
--   p_habit_id   — UUID dell'habit
--   p_local_date — Data locale (Europe/Rome) del completamento (YYYY-MM-DD)
--
-- Ritorna: jsonb { ok, streak, stack_completed, points_earned?, error? }
-- ============================================================

CREATE OR REPLACE FUNCTION habit_post_completion(
  p_habit_id   uuid,
  p_local_date date
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_habit             record;
  v_streak            integer := 0;
  v_check_date        date;
  v_day_count         integer;
  v_times_count       integer;
  v_user_points       record;
  v_total_days        integer;
  v_total_completions integer;
  v_required_days     integer[];
  v_week_start        date;
  v_week_complete     boolean;
  v_day               integer;
  v_target_date       date;
BEGIN
  -- Recupera l'habit attivo
  SELECT * INTO v_habit
  FROM hb_habits
  WHERE id = p_habit_id AND status = 'active';

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'habit non trovato o non attivo');
  END IF;

  -- ── Calcolo streak per tipo di frequenza ─────────────────────────────────

  IF v_habit.frequency = 'daily_multiple' THEN
    -- Conta giorni consecutivi con almeno N completamenti (uno per ogni slot orario)
    v_times_count := jsonb_array_length(v_habit.daily_times::jsonb);
    v_check_date  := p_local_date;

    LOOP
      EXIT WHEN v_check_date < v_habit.started_at::date;

      SELECT COUNT(*) INTO v_day_count
      FROM hb_completions
      WHERE habit_id   = p_habit_id
        AND status     = 'completed'
        AND completed_at::date = v_check_date;

      EXIT WHEN v_day_count < v_times_count;

      v_streak     := v_streak + 1;
      v_check_date := v_check_date - 1;
    END LOOP;

  ELSIF v_habit.frequency = 'weekly' THEN
    -- Conta settimane consecutive complete (tutti i weekdays richiesti presenti)
    -- weekdays in hb_habits: array ISO 1=Lun … 7=Dom
    SELECT array_agg(x::integer ORDER BY x::integer) INTO v_required_days
    FROM jsonb_array_elements_text(v_habit.weekdays::jsonb) x;

    -- Trova il Lunedì della settimana che contiene p_local_date (ISODOW: 1=Lun)
    v_week_start := p_local_date - (EXTRACT(ISODOW FROM p_local_date)::integer - 1);

    LOOP
      EXIT WHEN v_week_start < v_habit.started_at::date;

      v_week_complete := true;

      FOREACH v_day IN ARRAY v_required_days LOOP
        v_target_date := v_week_start + (v_day - 1);

        IF NOT EXISTS (
          SELECT 1 FROM hb_completions
          WHERE habit_id          = p_habit_id
            AND status            = 'completed'
            AND completed_at::date = v_target_date
        ) THEN
          v_week_complete := false;
          EXIT; -- esce dal FOREACH
        END IF;
      END LOOP;

      EXIT WHEN NOT v_week_complete;

      v_streak     := v_streak + 1;
      v_week_start := v_week_start - 7;
    END LOOP;

  ELSE
    -- Giornaliero: conta giorni consecutivi con almeno un completamento
    v_check_date := p_local_date;

    LOOP
      EXIT WHEN v_check_date < v_habit.started_at::date;

      SELECT COUNT(*) INTO v_day_count
      FROM hb_completions
      WHERE habit_id          = p_habit_id
        AND status            = 'completed'
        AND completed_at::date = v_check_date;

      EXIT WHEN v_day_count = 0;

      v_streak     := v_streak + 1;
      v_check_date := v_check_date - 1;
    END LOOP;
  END IF;

  -- ── Verifica completamento stack ──────────────────────────────────────────

  IF v_streak >= v_habit.goal AND v_habit.goal > 0 THEN

    v_total_days := p_local_date - v_habit.started_at::date;

    SELECT COUNT(*) INTO v_total_completions
    FROM hb_completions
    WHERE habit_id   = p_habit_id
      AND status     = 'completed'
      AND completed_at >= v_habit.started_at::timestamp;

    -- 1. Archivia lo stack completato
    INSERT INTO hb_archived_stacks (
      habit_id, habit_name, category_id,
      started_at, ended_at,
      final_streak, total_days, total_completions, total_failures,
      points_earned, reason
    ) VALUES (
      p_habit_id, v_habit.name, v_habit.category_id,
      v_habit.started_at, p_local_date::text,
      v_streak, v_total_days, v_total_completions, 0,
      COALESCE(v_habit.points_reward, 0), 'completato'
    );

    -- 2. Assegna punti (se previsti)
    IF COALESCE(v_habit.points_reward, 0) > 0 THEN
      SELECT * INTO v_user_points FROM hb_user_points LIMIT 1;

      IF FOUND THEN
        UPDATE hb_user_points
        SET total_points = total_points + v_habit.points_reward
        WHERE id = v_user_points.id;
      END IF;

      INSERT INTO hb_points_transactions (habit_id, habit_name, points_change, reason)
      VALUES (p_habit_id, v_habit.name, v_habit.points_reward, 'stack_completed');
    END IF;

    -- 3. Marca l'habit corrente come completato
    UPDATE hb_habits SET status = 'completed' WHERE id = p_habit_id;

    -- 4. Crea nuovo stack attivo dal giorno successivo
    INSERT INTO hb_habits (
      name, description, category_id,
      frequency, weekdays, daily_times,
      goal, max_failures, points_reward, points_penalty,
      started_at, status, current_failures
    ) VALUES (
      v_habit.name, v_habit.description, v_habit.category_id,
      v_habit.frequency, v_habit.weekdays, v_habit.daily_times,
      v_habit.goal, v_habit.max_failures, v_habit.points_reward, v_habit.points_penalty,
      (p_local_date + 1)::text, 'active', 0
    );

    RETURN jsonb_build_object(
      'ok',             true,
      'streak',         v_streak,
      'stack_completed', true,
      'points_earned',  COALESCE(v_habit.points_reward, 0)
    );
  END IF;

  RETURN jsonb_build_object('ok', true, 'streak', v_streak, 'stack_completed', false);
END;
$$;
