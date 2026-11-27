-- Reviewpunten I10 t/m I13, vóór de gesloten bèta.

-- I12: testbetalingen (NepBetaalprovider) in de database in plaats van in het
-- werkgeheugen, zodat cockpit, web-app en API dezelfde status zien en een
-- herstart niets kwijtraakt. Geen verwijzing naar payment: de rij wordt
-- aangemaakt terwijl de betaling nog in een open transactie zit.
CREATE TABLE test_betaling (
  provider_payment_id text PRIMARY KEY CHECK (provider_payment_id LIKE 'nep\_%'),
  payment_id          uuid NOT NULL,
  status              text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'betaald', 'mislukt', 'verlopen', 'geannuleerd')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  settled_at          timestamptz
);

-- I13: facturen van testbetalingen krijgen een eigen nummerreeks (TEST-),
-- zodat de echte reeks QB- straks aansluit en de boekhouding schoon blijft.
CREATE SEQUENCE test_invoice_number_seq;
ALTER TABLE invoice ADD COLUMN test boolean NOT NULL DEFAULT false;
ALTER TABLE invoice ADD CONSTRAINT invoice_test_nummer CHECK (test = (number LIKE 'TEST-%'));

-- I10: meer dan één vervolgvoorstel per mislukte regel (na een mislukte
-- herpoging of een onbetaald betaalverzoek), en een voorstel kan vervallen
-- als de klant intussen zelf heeft betaald.
ALTER TABLE collection_followup DROP CONSTRAINT collection_followup_item_id_key;
ALTER TABLE collection_followup ADD COLUMN attempt integer NOT NULL DEFAULT 1 CHECK (attempt BETWEEN 1 AND 20);
ALTER TABLE collection_followup ADD COLUMN previous_followup_id uuid REFERENCES collection_followup(id) ON DELETE SET NULL;
ALTER TABLE collection_followup ADD CONSTRAINT collection_followup_item_attempt_key UNIQUE (item_id, attempt);
ALTER TABLE collection_followup DROP CONSTRAINT collection_followup_status_check;
ALTER TABLE collection_followup ADD CONSTRAINT collection_followup_status_check
  CHECK (status IN ('voorgesteld', 'uitgevoerd', 'afgewezen', 'vervallen'));

-- I11: of de mail aan de klant echt is verstuurd, zodat een mislukte mail
-- zichtbaar is en opnieuw verstuurd kan worden.
ALTER TABLE collection_followup ADD COLUMN mail_status text CHECK (mail_status IN ('versturen', 'verstuurd', 'mislukt'));
ALTER TABLE collection_followup ADD COLUMN mail_to text CHECK (char_length(mail_to) <= 320);
ALTER TABLE collection_followup ADD COLUMN mail_error text CHECK (char_length(mail_error) <= 300);
ALTER TABLE collection_followup ADD COLUMN mail_sent_at timestamptz;
ALTER TABLE collection_followup ADD COLUMN mail_attempts integer NOT NULL DEFAULT 0;
