-- Btw verleggen naar zakelijke klanten in een ander EU-land (Erik, 27-11-2026).
--
-- * vat_check: elke VIES-controle met uitslag, tijdstip en consultatienummer.
--   Dit is het bewijs voor de Belastingdienst en wordt nooit gewijzigd.
-- * payment, collection_item en invoice krijgen de btw-code en het tarief
--   waarmee gerekend is, los opgeslagen (voor Mollie en de boekhouding later).
--   Een factuur kopieert altijd de btw van de betaling; er wordt niets herberekend.
-- * organization.vat_alert*: melding in de cockpit als verleggen stopt.

CREATE TABLE vat_check (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  -- Land van het factuuradres (ISO, dus GR voor Griekenland) en het volledige nummer (met EL).
  country              text NOT NULL CHECK (country ~ '^[A-Z]{2}$'),
  vat_number           text NOT NULL CHECK (char_length(vat_number) <= 20),
  status               text NOT NULL CHECK (status IN ('geldig', 'ongeldig', 'storing')),
  checked_at           timestamptz NOT NULL DEFAULT now(),
  -- Zoals VIES ze teruggeeft. Het consultatienummer komt alleen als Qbicle zijn eigen btw-nummer meestuurt.
  request_identifier   text CHECK (char_length(request_identifier) <= 100),
  request_date         text CHECK (char_length(request_date) <= 40),
  requester_vat_number text CHECK (char_length(requester_vat_number) <= 20),
  trader_name          text CHECK (char_length(trader_name) <= 400),
  trader_address       text CHECK (char_length(trader_address) <= 400),
  error                text CHECK (char_length(error) <= 200),
  source               text NOT NULL CHECK (source IN ('klant', 'registratie', 'betaling', 'verlenging', 'cockpit')),
  checked_by           uuid REFERENCES app_user(id) ON DELETE SET NULL
);
CREATE INDEX vat_check_org_idx ON vat_check (organization_id, vat_number, checked_at DESC);

CREATE FUNCTION vat_check_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Alleen checked_by mag leeg worden (gebruiker verwijderd); de uitslag zelf nooit.
  IF NEW.checked_by IS NULL AND OLD.checked_by IS NOT NULL
     AND (NEW.status, NEW.checked_at, NEW.vat_number, NEW.request_identifier) IS NOT DISTINCT FROM (OLD.status, OLD.checked_at, OLD.vat_number, OLD.request_identifier) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Een VIES-controle is bewijs en wordt niet gewijzigd';
END $$;
CREATE TRIGGER vat_check_no_update BEFORE UPDATE ON vat_check
  FOR EACH ROW EXECUTE FUNCTION vat_check_immutable();

ALTER TABLE organization
  ADD COLUMN vat_alert_at timestamptz,
  ADD COLUMN vat_alert    text CHECK (char_length(vat_alert) <= 400);

ALTER TABLE signup
  ADD COLUMN country    text CHECK (country ~ '^[A-Z]{2}$'),
  ADD COLUMN vat_number text CHECK (char_length(vat_number) <= 20);

ALTER TABLE payment
  ADD COLUMN vat_code     text NOT NULL DEFAULT 'nl_standaard' CHECK (vat_code IN ('nl_standaard', 'eu_verlegd')),
  ADD COLUMN vat_rate     numeric(4,2),
  ADD COLUMN vat_check_id uuid REFERENCES vat_check(id) ON DELETE SET NULL;

ALTER TABLE collection_item
  ADD COLUMN vat_code     text NOT NULL DEFAULT 'nl_standaard' CHECK (vat_code IN ('nl_standaard', 'eu_verlegd')),
  ADD COLUMN vat_rate     numeric(4,2),
  ADD COLUMN vat_check_id uuid REFERENCES vat_check(id) ON DELETE SET NULL;

ALTER TABLE invoice
  ADD COLUMN vat_code            text NOT NULL DEFAULT 'nl_standaard' CHECK (vat_code IN ('nl_standaard', 'eu_verlegd')),
  ADD COLUMN reverse_charge      boolean NOT NULL DEFAULT false,
  ADD COLUMN customer_vat_number text,
  ADD COLUMN supplier_vat_number text,
  ADD COLUMN vat_check_id        uuid REFERENCES vat_check(id) ON DELETE RESTRICT,
  ADD CHECK (NOT reverse_charge OR (vat_code = 'eu_verlegd' AND vat_cents = 0 AND customer_vat_number IS NOT NULL));
