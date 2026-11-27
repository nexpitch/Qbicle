-- Cockpit: notities bij klanten (alleen zichtbaar voor Qbicle-medewerkers).
-- Notities zijn niet te wijzigen of te verwijderen; een correctie is een nieuwe notitie.

CREATE TABLE org_note (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  author_id       uuid REFERENCES app_user(id) ON DELETE SET NULL,
  body            text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
  -- Waar de notitie vandaan komt: een medewerker of een agent.
  source          text NOT NULL DEFAULT 'medewerker' CHECK (source IN ('medewerker', 'agent', 'systeem')),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX org_note_org_idx ON org_note (organization_id, created_at DESC);

-- Waarom een gebruiker geblokkeerd is (app_user.disabled_at bestaat al).
ALTER TABLE app_user ADD COLUMN disabled_reason text CHECK (char_length(disabled_reason) <= 400);
