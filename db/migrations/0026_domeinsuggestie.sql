-- "Hoort dit ook bij jullie?": domeinen die de klant heeft afgewezen ("Niet van ons")
-- stellen we niet opnieuw voor. Per organisatie, op hoofddomein.
CREATE TABLE domein_suggestie_afgewezen (
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  domein          text NOT NULL CHECK (domein = lower(domein) AND domein LIKE '%.%'),
  afgewezen_door  uuid REFERENCES app_user(id) ON DELETE SET NULL,
  afgewezen_op    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, domein)
);
