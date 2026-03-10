-- ============================================================
-- Migration: task_complete_via_telegram
-- Data: 2026-03-10
-- Scopo: Funzione RPC chiamata dal webhook Telegram quando l'utente
--        clicca "✅ Fatto" su una notifica task.
--        Replica la logica di completeTask() in tasks.html.
-- ============================================================

-- ---------------------------------------------------------------------------
-- Helper: task_next_recurring_date(task_row, base_date)
-- Calcola la prossima occorrenza di un task recurring dopo base_date.
-- Equivalente JavaScript di getNextRecurringDate() in tasks.html.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION task_next_recurring_date(
  p_task    ts_tasks,
  p_base    date        -- data corrente (next_occurrence_date o start_date)
)
RETURNS date LANGUAGE plpgsql AS $$
DECLARE
  v_interval  integer := COALESCE(p_task.recurring_interval, 1);
  v_freq      text    := p_task.recurring_frequency;

  -- weekly
  v_dow_arr   integer[];
  v_start_dow integer;
  v_cur_dow   integer;
  v_test_date date;
  i           integer;
  v_days_to_sun integer;
  v_target_sun  date;

  -- monthly
  v_day_arr   integer[];
  v_start_day integer;
  v_cur_day   integer;
  v_cur_month integer;
  v_cur_year  integer;
  v_next_month date;

  -- yearly
  v_dates_arr   text[];
  v_date_str    text;
  v_parts       text[];
  v_d           integer;
  v_m           integer;
  v_next_year   integer;
BEGIN

  IF v_freq = 'daily' THEN
    RETURN p_base + (v_interval || ' days')::interval;
  END IF;

  IF v_freq = 'weekly' THEN
    -- Determina i giorni validi (0=Dom, come JS getDay())
    IF p_task.recurring_days_of_week IS NOT NULL
       AND jsonb_array_length(p_task.recurring_days_of_week::jsonb) > 0 THEN
      SELECT array_agg(v::integer ORDER BY v::integer)
        INTO v_dow_arr
        FROM jsonb_array_elements_text(p_task.recurring_days_of_week::jsonb) AS v;
    ELSE
      -- Fallback: giorno della start_date
      v_start_dow := EXTRACT(DOW FROM p_task.start_date::date)::integer;
      v_dow_arr   := ARRAY[v_start_dow];
    END IF;

    v_cur_dow := EXTRACT(DOW FROM p_base)::integer;

    -- PASSO 1: cerca nella settimana corrente (da domani fino a sabato)
    FOR i IN 1..(7 - v_cur_dow) LOOP
      v_test_date := p_base + i;
      IF EXTRACT(DOW FROM v_test_date)::integer = ANY(v_dow_arr) THEN
        RETURN v_test_date;
      END IF;
    END LOOP;

    -- PASSO 2: salta 'interval' settimane dalla prossima domenica
    v_days_to_sun := CASE WHEN v_cur_dow = 0 THEN 7
                          ELSE (7 - v_cur_dow) END;
    v_target_sun  := p_base + v_days_to_sun + ((v_interval - 1) * 7);

    FOR i IN 0..6 LOOP
      v_test_date := v_target_sun + i;
      IF EXTRACT(DOW FROM v_test_date)::integer = ANY(v_dow_arr) THEN
        RETURN v_test_date;
      END IF;
    END LOOP;

    RETURN NULL;
  END IF;

  IF v_freq = 'monthly' THEN
    IF p_task.recurring_day_of_month IS NOT NULL
       AND jsonb_array_length(p_task.recurring_day_of_month::jsonb) > 0 THEN
      SELECT array_agg(v::integer ORDER BY v::integer)
        INTO v_day_arr
        FROM jsonb_array_elements_text(p_task.recurring_day_of_month::jsonb) AS v;
    ELSE
      v_start_day := EXTRACT(DAY FROM p_task.start_date::date)::integer;
      v_day_arr   := ARRAY[v_start_day];
    END IF;

    v_cur_day   := EXTRACT(DAY  FROM p_base)::integer;
    v_cur_month := EXTRACT(MONTH FROM p_base)::integer;
    v_cur_year  := EXTRACT(YEAR  FROM p_base)::integer;

    -- CASO 1: cerca nel mese corrente (giorni > oggi)
    FOREACH i IN ARRAY v_day_arr LOOP
      IF i > v_cur_day THEN
        RETURN make_date(v_cur_year, v_cur_month, i);
      END IF;
    END LOOP;

    -- CASO 2: vai a (interval) mesi avanti, primo giorno valido
    v_next_month := (make_date(v_cur_year, v_cur_month, 1) + (v_interval || ' months')::interval)::date;
    RETURN make_date(EXTRACT(YEAR FROM v_next_month)::integer,
                     EXTRACT(MONTH FROM v_next_month)::integer,
                     v_day_arr[1]);
  END IF;

  IF v_freq = 'yearly' THEN
    -- Recupera le date (formato "DD-MM")
    IF p_task.recurring_dates IS NOT NULL
       AND jsonb_array_length(p_task.recurring_dates::jsonb) > 0 THEN
      SELECT array_agg(v ORDER BY v)
        INTO v_dates_arr
        FROM jsonb_array_elements_text(p_task.recurring_dates::jsonb) AS v;
    ELSIF p_task.recurring_day_of_year IS NOT NULL AND p_task.recurring_month IS NOT NULL THEN
      -- Vecchio formato
      v_dates_arr := ARRAY[lpad(p_task.recurring_day_of_year::text, 2, '0')
                           || '-' || lpad(p_task.recurring_month::text, 2, '0')];
    ELSE
      RETURN NULL;
    END IF;

    -- CASO 1: cerca nell'anno corrente (date dopo oggi)
    v_cur_year := EXTRACT(YEAR FROM p_base)::integer;
    FOREACH v_date_str IN ARRAY v_dates_arr LOOP
      v_parts := string_to_array(v_date_str, '-');
      v_d := v_parts[1]::integer;
      v_m := v_parts[2]::integer;
      v_test_date := make_date(v_cur_year, v_m, v_d);
      IF v_test_date > p_base THEN
        RETURN v_test_date;
      END IF;
    END LOOP;

    -- CASO 2: prossimo anno valido
    v_next_year := v_cur_year + v_interval;
    v_parts     := string_to_array(v_dates_arr[1], '-');
    v_d         := v_parts[1]::integer;
    v_m         := v_parts[2]::integer;
    RETURN make_date(v_next_year, v_m, v_d);
  END IF;

  RETURN NULL;
END;
$$;


-- ---------------------------------------------------------------------------
-- Principale: task_complete_via_telegram(p_task_id, p_today)
-- Replica completeTask() in tasks.html, invocata dal webhook Telegram.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION task_complete_via_telegram(
  p_task_id  uuid,
  p_today    date
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_task           ts_tasks%ROWTYPE;
  v_from_status    text;
  v_points         integer;
  v_action         text    := 'completed';
  v_next_date      date;
  v_next_ts        text;
  v_completed_date text;
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
    v_task.next_occurrence_date,
    v_task.start_date,
    now()::text
  );

  -- Per task singoli con deadline: controlla se in ritardo
  IF v_task.type = 'single' AND v_task.deadline IS NOT NULL THEN
    IF p_today > v_task.deadline::date THEN
      v_points := COALESCE(v_task.late_points, 0);
      v_action  := 'completed_late';
    END IF;
  END IF;

  -- Inserisci il record history principale (completamento)
  INSERT INTO ts_history (task_id, from_status, to_status, action, points, timestamp)
  VALUES (p_task_id, v_from_status, 'completed', v_action, v_points, now()::text);

  -- -------------------------------------------------------
  IF v_task.type = 'single' THEN
    UPDATE ts_tasks
       SET status               = 'terminated',
           last_completed_date  = v_completed_date
     WHERE id = p_task_id;

    INSERT INTO ts_history (task_id, from_status, to_status, action, points, timestamp)
    VALUES (p_task_id, 'completed', 'terminated', 'terminated', 0, now()::text);

    -- Elimina la regola di notifica (task singolo terminato)
    DELETE FROM cm_notification_rules
     WHERE entity_id = p_task_id::text
       AND app = 'tasks';

  -- -------------------------------------------------------
  ELSIF v_task.type = 'simple_recurring' THEN
    v_next_ts := (
      (COALESCE(v_task.next_occurrence_date, v_task.start_date)::timestamp
       + (COALESCE(v_task.repeat_after_days, 7) || ' days')::interval)
    )::text;

    UPDATE ts_tasks
       SET status               = 'completed',
           last_completed_date  = v_completed_date,
           next_occurrence_date = v_next_ts
     WHERE id = p_task_id;

  -- -------------------------------------------------------
  ELSIF v_task.type = 'recurring' THEN
    v_next_date := task_next_recurring_date(
      v_task,
      COALESCE(v_task.next_occurrence_date, v_task.start_date)::date
    );

    IF v_next_date IS NOT NULL THEN
      v_next_ts := v_next_date::text || 'T00:00:00';
    END IF;

    UPDATE ts_tasks
       SET status               = CASE WHEN v_next_date IS NULL THEN 'terminated' ELSE 'completed' END,
           last_completed_date  = v_completed_date,
           next_occurrence_date = v_next_ts
     WHERE id = p_task_id;

    IF v_next_date IS NULL THEN
      INSERT INTO ts_history (task_id, from_status, to_status, action, points, timestamp)
      VALUES (p_task_id, 'completed', 'terminated', 'terminated', 0, now()::text);
    END IF;

  -- -------------------------------------------------------
  ELSIF v_task.type = 'multiple' THEN
    DECLARE
      v_dates    text[];
      v_cur_str  text;
      v_cur_idx  integer := NULL;
      v_next_str text    := NULL;
      j          integer;
    BEGIN
      -- Estrai e ordina le date dall'array JSONB
      SELECT array_agg(d ORDER BY d)
        INTO v_dates
        FROM jsonb_array_elements_text(v_task.multiple_dates::jsonb) AS d;

      v_cur_str := split_part(COALESCE(v_task.next_occurrence_date, ''), 'T', 1);

      -- Trova indice della data corrente
      FOR j IN 1..array_length(v_dates, 1) LOOP
        IF v_dates[j] = v_cur_str THEN
          v_cur_idx := j;
          EXIT;
        END IF;
      END LOOP;

      -- Prendi la data successiva se esiste
      IF v_cur_idx IS NOT NULL AND v_cur_idx < array_length(v_dates, 1) THEN
        v_next_str := v_dates[v_cur_idx + 1] || 'T00:00:00';
      END IF;

      UPDATE ts_tasks
         SET status               = CASE WHEN v_next_str IS NULL THEN 'terminated' ELSE 'completed' END,
             last_completed_date  = v_completed_date,
             next_occurrence_date = v_next_str
       WHERE id = p_task_id;

      IF v_next_str IS NULL THEN
        INSERT INTO ts_history (task_id, from_status, to_status, action, points, timestamp)
        VALUES (p_task_id, 'completed', 'terminated', 'terminated', 0, now()::text);
      END IF;
    END;

  -- -------------------------------------------------------
  ELSE -- free_repeat (e qualsiasi altro tipo non gestito sopra)
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

-- Permetti all'utente autenticato di chiamare la funzione
-- (SECURITY DEFINER opera come il ruolo del proprietario)
GRANT EXECUTE ON FUNCTION task_complete_via_telegram(uuid, date) TO authenticated;
