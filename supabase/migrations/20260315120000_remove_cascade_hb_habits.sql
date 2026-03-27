-- Rimuove i CASCADE FK da hb_completions e hb_archived_stacks verso hb_habits.
-- Motivazione: permette DELETE su hb_habits senza perdere storico completamenti e archivi.

DO $$
DECLARE
  v_constraint text;
BEGIN
  -- Drop FK hb_completions → hb_habits
  SELECT conname INTO v_constraint
  FROM pg_constraint
  WHERE conrelid  = 'hb_completions'::regclass
    AND confrelid = 'hb_habits'::regclass
    AND contype   = 'f';
  IF v_constraint IS NOT NULL THEN
    EXECUTE format('ALTER TABLE hb_completions DROP CONSTRAINT %I', v_constraint);
  END IF;

  -- Drop FK hb_archived_stacks → hb_habits
  SELECT conname INTO v_constraint
  FROM pg_constraint
  WHERE conrelid  = 'hb_archived_stacks'::regclass
    AND confrelid = 'hb_habits'::regclass
    AND contype   = 'f';
  IF v_constraint IS NOT NULL THEN
    EXECUTE format('ALTER TABLE hb_archived_stacks DROP CONSTRAINT %I', v_constraint);
  END IF;
END;
$$;
