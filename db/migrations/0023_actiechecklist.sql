-- Afvinkbare acties: per actie (zoals "Zet DMARC aan") legt de klant of zijn
-- IT-partner vast of hij is opgepakt, door wie en wanneer. De volgende scan
-- controleert of het echt is opgelost. Alles wat verandert komt in een logboek,
-- zodat het later als bewijs (verzekeraar, Cbw) bruikbaar is.
--
-- Een actie hoort bij de organisatie, niet bij één domein: "Zet DMARC aan" kan
-- over meerdere domeinen gaan en is pas klaar als de scans hem nergens meer zien.

CREATE TABLE action_task (
  organization_id  uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  action_key       text NOT NULL CHECK (char_length(action_key) BETWEEN 1 AND 100),
  -- open, bezig (opgepakt), gedaan (afgevinkt, wacht op scan), bevestigd (scan ziet het niet meer),
  -- genegeerd (bewust niet oppakken, met reden).
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'bezig', 'gedaan', 'bevestigd', 'genegeerd')),
  note             text CHECK (char_length(note) <= 2000),
  reason           text CHECK (char_length(reason) <= 2000),
  assigned_to      text CHECK (assigned_to IN ('zelf', 'it-partner', 'webbouwer')),
  assignee_name    text CHECK (char_length(assignee_name) <= 200),
  updated_by       uuid REFERENCES app_user(id) ON DELETE SET NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  done_at          timestamptz,
  done_by          uuid REFERENCES app_user(id) ON DELETE SET NULL,
  -- Afgevinkt, maar een latere scan zag het nog: "Nog niet opgelost".
  still_seen_at    timestamptz,
  still_seen_scan  uuid REFERENCES scan(id) ON DELETE SET NULL,
  confirmed_at     timestamptz,
  confirmed_scan   uuid REFERENCES scan(id) ON DELETE SET NULL,
  PRIMARY KEY (organization_id, action_key),
  CHECK (status <> 'genegeerd' OR reason IS NOT NULL)
);

CREATE TABLE action_task_log (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  action_key       text NOT NULL CHECK (char_length(action_key) BETWEEN 1 AND 100),
  at               timestamptz NOT NULL DEFAULT now(),
  -- NULL = de scan (systeem).
  actor_user_id    uuid REFERENCES app_user(id) ON DELETE SET NULL,
  kind             text NOT NULL CHECK (kind IN ('status', 'notitie', 'toewijzing', 'scan')),
  from_status      text,
  to_status        text,
  text             text CHECK (char_length(text) <= 2000),
  scan_id          uuid REFERENCES scan(id) ON DELETE SET NULL
);
CREATE INDEX action_task_log_org_idx ON action_task_log (organization_id, action_key, at DESC);
