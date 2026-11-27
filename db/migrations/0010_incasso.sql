-- Incassobatches: verlengingen van abonnementen die automatisch worden klaargezet,
-- door een medewerker worden gecontroleerd en gevalideerd, en daarna met één
-- knop bij de betaalprovider worden ingediend.
--
-- Levenscyclus van een batch:
--   concept      klaargezet (door agent/taak of medewerker); regels uitsluiten of aanpassen kan
--   gevalideerd  gecontroleerd door een medewerker met recht 'incasso.indienen'; niets meer te wijzigen
--   ingediend    betalingen aangemaakt bij de provider; uitkomsten komen per regel binnen
--   afgerond     alle regels hebben een uitkomst
--   geannuleerd  niet ingediend
-- Klanten met betaalwijze 'factuur' komen nooit in een incassobatch.

CREATE TABLE collection_run (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_date date NOT NULL,
  status          text NOT NULL DEFAULT 'concept' CHECK (status IN ('concept', 'gevalideerd', 'ingediend', 'afgerond', 'geannuleerd')),
  source          text NOT NULL DEFAULT 'medewerker' CHECK (source IN ('medewerker', 'agent', 'systeem')),
  provider        text NOT NULL CHECK (provider IN ('nep', 'mollie')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES app_user(id) ON DELETE SET NULL,
  validated_at    timestamptz,
  validated_by    uuid REFERENCES app_user(id) ON DELETE SET NULL,
  submitted_at    timestamptz,
  submitted_by    uuid REFERENCES app_user(id) ON DELETE SET NULL,
  canceled_at     timestamptz,
  canceled_by     uuid REFERENCES app_user(id) ON DELETE SET NULL,
  note            text CHECK (char_length(note) <= 1000)
);
CREATE INDEX collection_run_created_idx ON collection_run (created_at DESC);

CREATE TABLE collection_item (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id            uuid NOT NULL REFERENCES collection_run(id) ON DELETE CASCADE,
  organization_id   uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  subscription_id   uuid NOT NULL REFERENCES subscription(id) ON DELETE CASCADE,
  description       text NOT NULL CHECK (char_length(description) <= 200),
  period_start      timestamptz NOT NULL,
  period_end        timestamptz NOT NULL CHECK (period_end > period_start),
  amount_excl_cents integer NOT NULL CHECK (amount_excl_cents >= 0),
  vat_cents         integer NOT NULL CHECK (vat_cents >= 0),
  amount_incl_cents integer NOT NULL CHECK (amount_incl_cents = amount_excl_cents + vat_cents),
  -- Oorspronkelijk bedrag als een medewerker het aanpaste (met reden).
  original_excl_cents integer,
  adjust_reason     text CHECK (char_length(adjust_reason) <= 400),
  status            text NOT NULL DEFAULT 'klaar' CHECK (status IN ('klaar', 'uitgesloten', 'ingediend', 'betaald', 'mislukt')),
  exclude_reason    text CHECK (char_length(exclude_reason) <= 400),
  payment_id        uuid UNIQUE REFERENCES payment(id) ON DELETE SET NULL,
  -- Reden van mislukken zoals de bank of provider die meldt.
  failure_reason    text CHECK (failure_reason IN ('storno', 'geen_dekking', 'mandaat_ingetrokken', 'rekening_opgeheven', 'onbekend')),
  result_at         timestamptz
);
CREATE INDEX collection_item_run_idx ON collection_item (run_id);
-- Nooit twee keer dezelfde periode van hetzelfde abonnement incasseren.
CREATE UNIQUE INDEX collection_item_once_idx ON collection_item (subscription_id, period_start) WHERE status <> 'uitgesloten';
