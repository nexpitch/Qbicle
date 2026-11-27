-- Cockpit: betaalwijze per klant en terugbetalingen.
--
-- * Standaard betaalt een klant met automatische incasso. Bij corporates of
--   klantspecifieke afspraken kan Qbicle per klant 'factuur' instellen: de klant
--   krijgt dan een factuur met een betaaltermijn in plaats van een incasso.
-- * Terugbetalingen worden bij de betaling vastgelegd; de factuur zelf blijft
--   onwijzigbaar (een creditfactuur volgt bij de echte Mollie-koppeling).

ALTER TABLE organization
  ADD COLUMN payment_method      text NOT NULL DEFAULT 'incasso' CHECK (payment_method IN ('incasso', 'factuur')),
  ADD COLUMN payment_terms_days  integer NOT NULL DEFAULT 14 CHECK (payment_terms_days BETWEEN 0 AND 90),
  ADD COLUMN payment_method_note text CHECK (char_length(payment_method_note) <= 400);

ALTER TABLE payment
  ADD COLUMN refunded_cents integer NOT NULL DEFAULT 0 CHECK (refunded_cents >= 0 AND refunded_cents <= amount_incl_cents),
  ADD COLUMN refunded_at    timestamptz;
