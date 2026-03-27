-- ============================================================
-- cm_profile: profilo personale utente
-- Contiene dati anagrafici, clinici e preferenze personali.
-- Un solo record per utente (UNIQUE su user_id).
-- I dati Google (nome, avatar, email) vengono pre-caricati
-- dall'app al primo accesso e possono essere sovrascritti.
-- ============================================================

CREATE TABLE IF NOT EXISTS cm_profile (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Anagrafica
  nome          text,
  cognome       text,
  email         text,
  avatar_url    text,
  data_nascita  date,
  sesso         text        CHECK (sesso IN ('M', 'F', 'Altro')),
  altezza_cm    smallint    CHECK (altezza_cm > 50 AND altezza_cm < 300),

  -- Clinica
  patologie     text,       -- testo libero, una patologia per riga
  farmaci       text,       -- testo libero, un farmaco per riga
  note_mediche  text,

  -- Meta
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  UNIQUE (user_id)
);

-- Aggiorna updated_at automaticamente
CREATE OR REPLACE FUNCTION cm_profile_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER cm_profile_updated_at
  BEFORE UPDATE ON cm_profile
  FOR EACH ROW EXECUTE FUNCTION cm_profile_set_updated_at();

-- RLS: ogni utente vede e modifica solo il proprio profilo
ALTER TABLE cm_profile ENABLE ROW LEVEL SECURITY;

CREATE POLICY "profilo: lettura proprio record"
  ON cm_profile FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "profilo: inserimento proprio record"
  ON cm_profile FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "profilo: aggiornamento proprio record"
  ON cm_profile FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "profilo: eliminazione proprio record"
  ON cm_profile FOR DELETE
  USING (auth.uid() = user_id);
