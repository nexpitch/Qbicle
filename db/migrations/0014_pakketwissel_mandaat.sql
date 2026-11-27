-- Pakket wijzigen, opzeggen met reden en het incassomandaat van de klant.
--
-- * Upgrade tijdens een betaalde periode: meteen, na een bijbetaling naar rato.
--   De bijbetaling onthoudt naar welk pakket hij gaat (payment.plan_change);
--   pas als hij betaald is, verandert het abonnement.
-- * Downgrade of andere betaaltermijn tijdens een betaalde periode: gaat in bij
--   de volgende periode (subscription.pending_plan / pending_interval). Wie een
--   verlenging klaarzet (klant of incassobatch), past dit eerst toe met
--   applyScheduledChange() uit packages/platform.
-- * Mandaat: toestemming voor automatische incasso. Ontstaat bij de eerste
--   geslaagde betaling (bij Mollie: 'first payment'). De klant kan het intrekken.

ALTER TABLE subscription
  ADD COLUMN pending_plan     text,
  ADD COLUMN pending_interval text CHECK (pending_interval IN ('maand', 'jaar')),
  ADD COLUMN cancel_reason    text CHECK (cancel_reason IN ('te_duur', 'niet_gebruikt', 'mist_functie', 'ander_product', 'tijdelijk', 'anders')),
  ADD COLUMN cancel_feedback  text CHECK (char_length(cancel_feedback) <= 1000),
  ADD CONSTRAINT subscription_pending_both CHECK ((pending_plan IS NULL) = (pending_interval IS NULL));

ALTER TABLE payment
  ADD COLUMN plan_change jsonb;

CREATE TABLE payment_mandate (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  provider        text NOT NULL CHECK (provider IN ('nep', 'mollie')),
  provider_mandate_id text,
  method          text NOT NULL DEFAULT 'sepa' CHECK (method IN ('sepa', 'creditcard')),
  account_holder  text CHECK (char_length(account_holder) <= 200),
  -- Alleen de laatste vier tekens; nooit het volledige rekeningnummer.
  account_last4   text CHECK (account_last4 ~ '^[0-9A-Z]{4}$'),
  status          text NOT NULL DEFAULT 'geldig' CHECK (status IN ('geldig', 'ingetrokken')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  source_payment_id uuid REFERENCES payment(id) ON DELETE SET NULL,
  revoked_at      timestamptz,
  revoked_by      uuid REFERENCES app_user(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX payment_mandate_valid_idx ON payment_mandate (organization_id) WHERE status = 'geldig';
