-- Cockpit, technische en support-kant: gebruiksmeting (scans, API, AI-tokens),
-- technische gezondheid (fouten, mailbezorging), support-tickets en agents
-- (voorstellen, goedkeuring door een mens, audit).
--
-- Uitgangspunten:
-- * Wat al in een eigen tabel staat (scans, assets) tellen we daar; usage_daily
--   bevat alleen wat nergens anders wordt vastgelegd (API-aanroepen, AI, mail).
-- * Kosten in micro-euro's (1 euro = 1.000.000), zodat ook één AI-aanroep van
--   een fractie van een cent exact optelt.
-- * Agents doen alleen voorstellen. Alles met gevolgen voor een klant of voor
--   geld wordt pas uitgevoerd na goedkeuring door een medewerker. De inhoud van
--   een voorstel kan na aanmaken niet meer veranderen (zie trigger).
-- * Geen verwijzing naar staff_member (cockpit-shell, migratie 0006): wie
--   beslist is een app_user; de cockpit controleert of dat een medewerker is.

-- Gebruiksmeting -----------------------------------------------------------------

CREATE TABLE usage_daily (
  -- NULL = intern gebruik zonder klant (bijv. een agent die het hele platform bewaakt).
  organization_id   uuid REFERENCES organization(id) ON DELETE CASCADE,
  day               date NOT NULL,
  metric            text NOT NULL CHECK (metric IN ('api', 'ai', 'mail')),
  -- Welke functie: bijv. 'samenvatting', 'actielijst', 'support-agent', 'GET /domeinen'.
  feature           text NOT NULL DEFAULT '' CHECK (char_length(feature) <= 80),
  quantity          bigint NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  input_tokens      bigint NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens     bigint NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cache_read_tokens bigint NOT NULL DEFAULT 0 CHECK (cache_read_tokens >= 0),
  cache_write_tokens bigint NOT NULL DEFAULT 0 CHECK (cache_write_tokens >= 0),
  cost_micros       bigint NOT NULL DEFAULT 0 CHECK (cost_micros >= 0),
  CONSTRAINT usage_daily_key UNIQUE NULLS NOT DISTINCT (organization_id, day, metric, feature)
);
CREATE INDEX usage_daily_day_idx ON usage_daily (day, metric);

-- Elke AI-aanroep apart: voor kosten per klant, foutpercentages en uitzoeken.
-- Nooit de prompt of het antwoord zelf (kan klantgegevens bevatten).
CREATE TABLE ai_call (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id   uuid REFERENCES organization(id) ON DELETE CASCADE,
  feature           text NOT NULL CHECK (char_length(feature) <= 80),
  model             text NOT NULL CHECK (char_length(model) <= 80),
  agent_key         text CHECK (char_length(agent_key) <= 60),
  input_tokens      integer NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens     integer NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cache_read_tokens integer NOT NULL DEFAULT 0 CHECK (cache_read_tokens >= 0),
  cache_write_tokens integer NOT NULL DEFAULT 0 CHECK (cache_write_tokens >= 0),
  cost_micros       bigint NOT NULL DEFAULT 0 CHECK (cost_micros >= 0),
  duration_ms       integer CHECK (duration_ms >= 0),
  outcome           text NOT NULL DEFAULT 'ok' CHECK (outcome IN ('ok', 'fout', 'geweigerd', 'begrensd')),
  ref               text CHECK (char_length(ref) <= 200),
  at                timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_call_org_idx ON ai_call (organization_id, at DESC);
CREATE INDEX ai_call_at_idx ON ai_call (at DESC);

-- Afwijkende limiet voor één klant (bijv. maatwerk bij een corporate).
-- Standaardlimieten per pakket staan in config/gebruikslimieten.json.
CREATE TABLE usage_limit_override (
  organization_id   uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  metric            text NOT NULL CHECK (metric IN ('scans_maand', 'api_dag', 'ai_tokens_maand', 'ai_kosten_maand')),
  -- NULL = onbeperkt.
  limit_value       bigint CHECK (limit_value >= 0),
  reason            text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 400),
  set_by            uuid REFERENCES app_user(id) ON DELETE SET NULL,
  set_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, metric)
);

-- Scanjobs: waarom mislukt en hoe vaak geprobeerd ----------------------------------

ALTER TABLE scan
  ADD COLUMN error    text CHECK (char_length(error) <= 2000),
  ADD COLUMN attempts smallint NOT NULL DEFAULT 0 CHECK (attempts >= 0);
CREATE INDEX scan_status_idx ON scan (status, created_at) WHERE status IN ('wachtrij', 'bezig', 'mislukt');

-- Fouten in het platform, gegroepeerd ------------------------------------------------

CREATE TABLE system_error (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Zelfde soort fout op dezelfde plek telt op in plaats van een nieuwe rij.
  fingerprint       text NOT NULL UNIQUE CHECK (char_length(fingerprint) <= 200),
  source            text NOT NULL CHECK (source IN ('scanner', 'worker', 'api', 'web', 'mail', 'ai', 'agent', 'betaling', 'cockpit')),
  message           text NOT NULL CHECK (char_length(message) <= 2000),
  organization_id   uuid REFERENCES organization(id) ON DELETE SET NULL,
  context           jsonb,
  occurrences       integer NOT NULL DEFAULT 1 CHECK (occurrences >= 1),
  first_seen        timestamptz NOT NULL DEFAULT now(),
  last_seen         timestamptz NOT NULL DEFAULT now(),
  resolved_at       timestamptz,
  resolved_by       uuid REFERENCES app_user(id) ON DELETE SET NULL
);
CREATE INDEX system_error_open_idx ON system_error (last_seen DESC) WHERE resolved_at IS NULL;

-- Mailbezorging ------------------------------------------------------------------------

CREATE TABLE mail_event (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient         citext NOT NULL CHECK (char_length(recipient) <= 254),
  subject           text NOT NULL CHECK (char_length(subject) <= 300),
  provider          text NOT NULL CHECK (provider IN ('brevo', 'console', 'geheugen')),
  provider_message_id text CHECK (char_length(provider_message_id) <= 200),
  status            text NOT NULL CHECK (status IN ('verstuurd', 'afgeleverd', 'geopend', 'uitgesteld', 'gebounced', 'geblokkeerd', 'spam', 'mislukt')),
  error             text CHECK (char_length(error) <= 1000),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mail_event_created_idx ON mail_event (created_at DESC);
CREATE INDEX mail_event_recipient_idx ON mail_event (recipient, created_at DESC);
CREATE UNIQUE INDEX mail_event_provider_idx ON mail_event (provider, provider_message_id) WHERE provider_message_id IS NOT NULL;

-- Support ------------------------------------------------------------------------------

CREATE SEQUENCE support_ticket_number_seq;

CREATE TABLE support_ticket (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number            integer NOT NULL UNIQUE DEFAULT nextval('support_ticket_number_seq'),
  organization_id   uuid REFERENCES organization(id) ON DELETE SET NULL,
  requester_email   citext CHECK (char_length(requester_email) <= 254),
  requester_user_id uuid REFERENCES app_user(id) ON DELETE SET NULL,
  subject           text NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 200),
  status            text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'wacht_op_klant', 'opgelost', 'gesloten')),
  priority          text NOT NULL DEFAULT 'normaal' CHECK (priority IN ('laag', 'normaal', 'hoog', 'urgent')),
  -- Waar kwam het vandaan: klant mailde, via de app, of een agent/systeem signaleerde iets.
  channel           text NOT NULL CHECK (channel IN ('mail', 'app', 'agent', 'systeem', 'telefoon')),
  category          text CHECK (category IN ('inloggen', 'scan', 'bevinding', 'factuur', 'abonnement', 'netwerk', 'overig')),
  -- Medewerker (app_user) of agent ('agent:<sleutel>').
  assignee          text CHECK (char_length(assignee) <= 80),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  first_response_at timestamptz,
  resolved_at       timestamptz,
  CHECK (requester_email IS NOT NULL OR requester_user_id IS NOT NULL OR channel IN ('agent', 'systeem'))
);
CREATE INDEX support_ticket_status_idx ON support_ticket (status, updated_at DESC);
CREATE INDEX support_ticket_org_idx ON support_ticket (organization_id, created_at DESC);

CREATE TABLE support_message (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id         uuid NOT NULL REFERENCES support_ticket(id) ON DELETE CASCADE,
  author_kind       text NOT NULL CHECK (author_kind IN ('klant', 'medewerker', 'agent', 'systeem')),
  author_user_id    uuid REFERENCES app_user(id) ON DELETE SET NULL,
  author_agent      text CHECK (char_length(author_agent) <= 60),
  body              text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 20000),
  -- Interne notitie: nooit zichtbaar voor of gemaild naar de klant.
  internal          boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX support_message_ticket_idx ON support_message (ticket_id, created_at);

-- Agents ---------------------------------------------------------------------------------

CREATE TABLE agent (
  key               text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9-]{1,59}$'),
  name              text NOT NULL CHECK (char_length(name) <= 80),
  description       text NOT NULL CHECK (char_length(description) <= 600),
  -- Noodrem: een gepauzeerde agent kan niets voorstellen of uitvoeren.
  enabled           boolean NOT NULL DEFAULT true,
  paused_reason     text CHECK (char_length(paused_reason) <= 400),
  paused_by         uuid REFERENCES app_user(id) ON DELETE SET NULL,
  -- Maximaal aantal openstaande voorstellen, tegen een agent die doorslaat.
  max_open_proposals integer NOT NULL DEFAULT 50 CHECK (max_open_proposals BETWEEN 1 AND 1000),
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE agent_run (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_key         text NOT NULL REFERENCES agent(key),
  status            text NOT NULL DEFAULT 'bezig' CHECK (status IN ('bezig', 'klaar', 'mislukt')),
  summary           text CHECK (char_length(summary) <= 2000),
  stats             jsonb,
  started_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz
);
CREATE INDEX agent_run_idx ON agent_run (agent_key, started_at DESC);

CREATE TABLE agent_proposal (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_key         text NOT NULL REFERENCES agent(key),
  run_id            uuid REFERENCES agent_run(id) ON DELETE SET NULL,
  -- Soort voorstel, bijv. 'scan.opnieuw', 'ticket.antwoord', 'incasso.batch'.
  -- Wat een soort mag en wie hem goedkeurt staat in code (packages/ops/src/agents.ts).
  kind              text NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
  -- Verwijzing naar het onderwerp in een andere tabel (bijv. collection_run.id, support_ticket.id).
  ref_id            text CHECK (char_length(ref_id) <= 100),
  -- SET NULL: het voorstel blijft als bewijs bestaan als een klant wordt verwijderd.
  organization_id   uuid REFERENCES organization(id) ON DELETE SET NULL,
  title             text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  rationale         text NOT NULL CHECK (char_length(rationale) BETWEEN 1 AND 4000),
  payload           jsonb NOT NULL DEFAULT '{}',
  payload_sha256    text NOT NULL,
  impact            text NOT NULL CHECK (impact IN ('geen', 'klant', 'financieel')),
  -- Bedrag waar het om gaat (centen), zodat de wachtrij op geldimpact kan sorteren.
  amount_cents      bigint,
  status            text NOT NULL DEFAULT 'voorgesteld'
                    CHECK (status IN ('voorgesteld', 'goedgekeurd', 'afgewezen', 'bezig', 'uitgevoerd', 'mislukt', 'verlopen', 'ingetrokken')),
  -- Zelfde voorstel niet twee keer open (bijv. 'scan.opnieuw:<scan-id>').
  dedupe_key        text CHECK (char_length(dedupe_key) <= 200),
  expires_at        timestamptz NOT NULL DEFAULT now() + interval '7 days',
  decided_by        uuid REFERENCES app_user(id) ON DELETE SET NULL,
  decided_at        timestamptz,
  decision_note     text CHECK (char_length(decision_note) <= 1000),
  -- 'automatisch' alleen bij impact 'geen' en een soort die dat toestaat.
  decided_via       text CHECK (decided_via IN ('medewerker', 'automatisch')),
  executed_at       timestamptz,
  result            jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (decided_via IS DISTINCT FROM 'automatisch' OR impact = 'geen'),
  CHECK (status NOT IN ('goedgekeurd', 'bezig', 'uitgevoerd') OR decided_via IS NOT NULL),
  CHECK (decided_via IS DISTINCT FROM 'medewerker' OR decided_by IS NOT NULL)
);
CREATE INDEX agent_proposal_open_idx ON agent_proposal (status, created_at) WHERE status = 'voorgesteld';
CREATE INDEX agent_proposal_agent_idx ON agent_proposal (agent_key, created_at DESC);
CREATE INDEX agent_proposal_ref_idx ON agent_proposal (kind, ref_id);
CREATE UNIQUE INDEX agent_proposal_dedupe_idx ON agent_proposal (dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status IN ('voorgesteld', 'goedgekeurd', 'bezig');

-- Wat goedgekeurd wordt, is precies wat werd voorgesteld.
CREATE FUNCTION agent_proposal_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.payload IS DISTINCT FROM OLD.payload
     OR NEW.payload_sha256 IS DISTINCT FROM OLD.payload_sha256
     OR NEW.impact IS DISTINCT FROM OLD.impact
     OR (NEW.organization_id IS DISTINCT FROM OLD.organization_id AND NEW.organization_id IS NOT NULL)
     OR NEW.ref_id IS DISTINCT FROM OLD.ref_id
     OR NEW.amount_cents IS DISTINCT FROM OLD.amount_cents
     OR NEW.agent_key IS DISTINCT FROM OLD.agent_key THEN
    RAISE EXCEPTION 'De inhoud van een agentvoorstel kan niet worden gewijzigd; maak een nieuw voorstel';
  END IF;
  -- Een besluit is definitief.
  IF OLD.decided_at IS NOT NULL AND (NEW.decided_by IS DISTINCT FROM OLD.decided_by OR NEW.decided_at IS DISTINCT FROM OLD.decided_at) THEN
    RAISE EXCEPTION 'Een besluit over een agentvoorstel kan niet worden gewijzigd';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER agent_proposal_no_edit BEFORE UPDATE ON agent_proposal
  FOR EACH ROW EXECUTE FUNCTION agent_proposal_frozen();
CREATE FUNCTION agent_proposal_keep() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Agentvoorstellen worden bewaard; trek een voorstel in in plaats van het te verwijderen';
END $$;
CREATE TRIGGER agent_proposal_no_delete BEFORE DELETE ON agent_proposal
  FOR EACH ROW EXECUTE FUNCTION agent_proposal_keep();

-- Audit-log doorzoekbaar op actor (agent:<sleutel>, medewerker, systeem).
CREATE INDEX audit_log_actor_idx ON audit_log (actor, at DESC);
