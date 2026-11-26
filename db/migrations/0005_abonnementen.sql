-- Abonnementen, betalingen en facturen.
--
-- Uitgangspunten:
-- * Prijzen staan niet in de database maar in config/abonnementen.json. Een
--   abonnement en een factuur onthouden wel de prijs van het moment van afsluiten.
-- * Bedragen in eurocenten, exclusief btw, tenzij de kolom anders zegt.
-- * Betalen gaat via een betaalprovider-laag: nu 'nep' (testbetaling), later 'mollie'.
-- * Facturen zijn onwijzigbaar zodra ze zijn uitgegeven (wettelijke bewaarplicht).

-- Factuurgegevens van de organisatie ---------------------------------------

ALTER TABLE organization
  ADD COLUMN billing_name     text CHECK (char_length(billing_name) <= 200),
  ADD COLUMN billing_email    citext CHECK (char_length(billing_email) <= 254),
  ADD COLUMN billing_address  text CHECK (char_length(billing_address) <= 400),
  ADD COLUMN billing_postcode text CHECK (char_length(billing_postcode) <= 16),
  ADD COLUMN billing_city     text CHECK (char_length(billing_city) <= 100),
  ADD COLUMN billing_country  text NOT NULL DEFAULT 'NL' CHECK (billing_country ~ '^[A-Z]{2}$'),
  ADD COLUMN kvk_number       text CHECK (kvk_number ~ '^[0-9]{8}$'),
  ADD COLUMN vat_number       text CHECK (char_length(vat_number) <= 20);

-- Aanmelding vóór het eerste inloggen ----------------------------------------
-- Wie zich registreert, krijgt eerst een inloglink. Bij het eerste inloggen met
-- dat adres maakt Qbicle de organisatie en de proefperiode aan.

CREATE TABLE signup (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         citext NOT NULL,
  org_name      text NOT NULL CHECK (char_length(org_name) BETWEEN 1 AND 120),
  plan          text NOT NULL,
  billing_interval text NOT NULL CHECK (billing_interval IN ('maand', 'jaar')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  completed_at  timestamptz,
  organization_id uuid REFERENCES organization(id) ON DELETE SET NULL
);
CREATE INDEX signup_email_idx ON signup (email, created_at DESC) WHERE completed_at IS NULL;

-- Abonnementen ---------------------------------------------------------------

CREATE TABLE subscription (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  plan              text NOT NULL,
  billing_interval  text NOT NULL CHECK (billing_interval IN ('maand', 'jaar')),
  -- Prijs per maand excl. btw op het moment van afsluiten (centen).
  monthly_price_cents integer NOT NULL CHECK (monthly_price_cents >= 0),
  status            text NOT NULL CHECK (status IN ('proef', 'actief', 'achterstallig', 'opgezegd', 'beeindigd')),
  trial_ends_at     timestamptz,
  current_period_start timestamptz,
  current_period_end   timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  canceled_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid REFERENCES app_user(id) ON DELETE SET NULL
);
-- Eén lopend abonnement per organisatie.
CREATE UNIQUE INDEX subscription_current_idx
  ON subscription (organization_id) WHERE status IN ('proef', 'actief', 'achterstallig', 'opgezegd');

-- Eenmalige opdrachten (Qbicle Audit) --------------------------------------------

CREATE TABLE audit_order (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  package           text NOT NULL,
  price_cents       integer NOT NULL CHECK (price_cents >= 0),
  target_name       text NOT NULL CHECK (char_length(target_name) BETWEEN 1 AND 200),
  target_domains    text[] NOT NULL DEFAULT '{}',
  status            text NOT NULL CHECK (status IN ('wacht_op_betaling', 'betaald', 'in_behandeling', 'opgeleverd', 'geannuleerd')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid REFERENCES app_user(id) ON DELETE SET NULL
);
CREATE INDEX audit_order_org_idx ON audit_order (organization_id, created_at DESC);

-- Betalingen -------------------------------------------------------------------

CREATE TABLE payment (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  subscription_id   uuid REFERENCES subscription(id) ON DELETE SET NULL,
  audit_order_id    uuid REFERENCES audit_order(id) ON DELETE SET NULL,
  description       text NOT NULL CHECK (char_length(description) <= 200),
  -- Wat het dekt: bij een abonnement de periode.
  period_start      timestamptz,
  period_end        timestamptz,
  amount_excl_cents integer NOT NULL CHECK (amount_excl_cents >= 0),
  vat_cents         integer NOT NULL CHECK (vat_cents >= 0),
  amount_incl_cents integer NOT NULL CHECK (amount_incl_cents = amount_excl_cents + vat_cents),
  currency          text NOT NULL DEFAULT 'EUR' CHECK (currency = 'EUR'),
  status            text NOT NULL CHECK (status IN ('open', 'betaald', 'mislukt', 'verlopen', 'geannuleerd')),
  provider          text NOT NULL CHECK (provider IN ('nep', 'mollie')),
  provider_payment_id text,
  checkout_url      text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  paid_at           timestamptz,
  created_by        uuid REFERENCES app_user(id) ON DELETE SET NULL,
  CHECK ((subscription_id IS NULL) <> (audit_order_id IS NULL))
);
CREATE UNIQUE INDEX payment_provider_idx ON payment (provider, provider_payment_id) WHERE provider_payment_id IS NOT NULL;
CREATE INDEX payment_org_idx ON payment (organization_id, created_at DESC);

-- Facturen ----------------------------------------------------------------------

CREATE SEQUENCE invoice_number_seq;

CREATE TABLE invoice (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  payment_id        uuid NOT NULL UNIQUE REFERENCES payment(id) ON DELETE RESTRICT,
  number            text NOT NULL UNIQUE,
  issued_at         timestamptz NOT NULL DEFAULT now(),
  -- Momentopname van de factuurgegevens, zodat een latere adreswijziging de factuur niet verandert.
  customer          jsonb NOT NULL,
  lines             jsonb NOT NULL,
  amount_excl_cents integer NOT NULL,
  vat_rate          numeric(4,2) NOT NULL,
  vat_cents         integer NOT NULL,
  amount_incl_cents integer NOT NULL CHECK (amount_incl_cents = amount_excl_cents + vat_cents)
);
CREATE INDEX invoice_org_idx ON invoice (organization_id, issued_at DESC);

CREATE FUNCTION invoice_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Facturen zijn onwijzigbaar; maak een creditfactuur';
END $$;
CREATE TRIGGER invoice_no_update BEFORE UPDATE OR DELETE ON invoice
  FOR EACH ROW EXECUTE FUNCTION invoice_immutable();
