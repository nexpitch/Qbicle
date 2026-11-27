-- Klantaccount: contactpersonen en een eigen referentie op de factuur.
--
-- * Contactpersonen zijn geen gebruikers: het zijn de mensen die Qbicle (en de
--   cockpit) kan bereiken, ook als ze niet inloggen. Eén per soort, zodat altijd
--   duidelijk is wie je belt bij een urgent lek of een factuurvraag.
-- * billing_reference is een kenmerk of inkoopordernummer dat de klant op elke
--   factuur wil zien (vaak verplicht bij grotere bedrijven).

ALTER TABLE organization
  ADD COLUMN billing_reference text CHECK (char_length(billing_reference) <= 100);

CREATE TABLE org_contact (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('algemeen', 'financieel', 'technisch', 'security')),
  name            text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  email           citext CHECK (char_length(email) <= 254),
  phone           text CHECK (char_length(phone) <= 32),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid REFERENCES app_user(id) ON DELETE SET NULL,
  UNIQUE (organization_id, kind),
  CHECK (email IS NOT NULL OR phone IS NOT NULL)
);
