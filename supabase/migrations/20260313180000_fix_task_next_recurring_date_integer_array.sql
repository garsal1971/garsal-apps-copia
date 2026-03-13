-- ============================================================
-- Migration: fix task_next_recurring_date — integer[] cast error
-- Data: 2026-03-13
-- Problema: recurring_days_of_week e recurring_day_of_month sono
--   colonne integer[] (array nativo PG), ma la funzione le castava
--   a jsonb → errore "cannot cast integer[]".
-- Fix: sostituire jsonb_array_length/jsonb_array_elements_text con
--   array_length/unnest che operano su integer[] nativo.
-- ============================================================

CREATE OR REPLACE FUNCTION task_next_recurring_date(
  p_task    ts_tasks,
  p_base    date
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
    -- recurring_days_of_week è integer[] — usa array_length/unnest
    IF p_task.recurring_days_of_week IS NOT NULL
       AND array_length(p_task.recurring_days_of_week, 1) > 0 THEN
      SELECT array_agg(v ORDER BY v)
        INTO v_dow_arr
        FROM unnest(p_task.recurring_days_of_week) AS v;
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
    -- recurring_day_of_month è integer[] — usa array_length/unnest
    IF p_task.recurring_day_of_month IS NOT NULL
       AND array_length(p_task.recurring_day_of_month, 1) > 0 THEN
      SELECT array_agg(v ORDER BY v)
        INTO v_day_arr
        FROM unnest(p_task.recurring_day_of_month) AS v;
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
    -- recurring_dates è jsonb/text — il cast ::jsonb rimane corretto
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
