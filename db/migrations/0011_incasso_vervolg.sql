-- Vervolgacties bij mislukte incasso's. Bij elke mislukte regel bereidt een agent
-- (nu: vaste regels) een voorstel voor; een medewerker voert het uit of wijst het af.

CREATE TABLE collection_followup (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id           uuid NOT NULL UNIQUE REFERENCES collection_item(id) ON DELETE CASCADE,
  organization_id   uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  suggested_action  text NOT NULL CHECK (suggested_action IN ('herpoging', 'klant_mailen', 'factuur_sturen', 'bellen')),
  suggested_by      text NOT NULL DEFAULT 'agent' CHECK (suggested_by IN ('agent', 'systeem', 'medewerker')),
  suggestion_reason text NOT NULL CHECK (char_length(suggestion_reason) <= 400),
  -- Voorbereide mail aan de klant (aan te passen voor verzenden).
  mail_subject      text CHECK (char_length(mail_subject) <= 200),
  mail_body         text CHECK (char_length(mail_body) <= 4000),
  status            text NOT NULL DEFAULT 'voorgesteld' CHECK (status IN ('voorgesteld', 'uitgevoerd', 'afgewezen')),
  chosen_action     text CHECK (chosen_action IN ('herpoging', 'klant_mailen', 'factuur_sturen', 'bellen')),
  decided_at        timestamptz,
  decided_by        uuid REFERENCES app_user(id) ON DELETE SET NULL,
  decision_note     text CHECK (char_length(decision_note) <= 400),
  -- Nieuwe betaling bij herpoging of betaalverzoek.
  result_payment_id uuid REFERENCES payment(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX collection_followup_open_idx ON collection_followup (created_at DESC) WHERE status = 'voorgesteld';
