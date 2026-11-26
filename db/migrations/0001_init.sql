-- Qbicle Light: eerste datamodel (zie technisch ontwerp, hoofdstuk Datamodel).
-- Alles hangt aan een organisatie, zodat dezelfde tabellen later Deal Check
-- (tientallen domeinen per deal) kunnen dragen.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE organization (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('klant', 'it-partner', 'adviseur')),
  plan          text NOT NULL DEFAULT 'gratis',
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app_user (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         citext NOT NULL UNIQUE,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE membership (
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  role            text NOT NULL CHECK (role IN ('eigenaar', 'lezer', 'partner')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id)
);

CREATE TABLE domain (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  name                text NOT NULL CHECK (name = lower(name)),
  verified_at         timestamptz,
  verification_method text CHECK (verification_method IN ('dns-txt', 'email')),
  verification_token  text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);

-- Domeinen die niet gescand willen worden.
CREATE TABLE scan_opt_out (
  name        text PRIMARY KEY CHECK (name = lower(name)),
  reason      text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE asset (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  domain_id       uuid REFERENCES domain(id) ON DELETE SET NULL,
  type            text NOT NULL CHECK (type IN ('domein', 'subdomein', 'host', 'mailserver', 'website', 'certificaat', 'dienst')),
  value           text NOT NULL,
  source          text NOT NULL,
  visibility      text NOT NULL CHECK (visibility IN ('primair', 'subdomein', 'alleen-ct')),
  first_seen      timestamptz NOT NULL DEFAULT now(),
  last_seen       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, type, value)
);

CREATE TABLE asset_link (
  from_asset_id uuid NOT NULL REFERENCES asset(id) ON DELETE CASCADE,
  to_asset_id   uuid NOT NULL REFERENCES asset(id) ON DELETE CASCADE,
  relation      text NOT NULL CHECK (relation IN ('wijst-naar', 'draait-op', 'beveiligt')),
  PRIMARY KEY (from_asset_id, to_asset_id, relation)
);

CREATE TABLE scan (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  domain_id       uuid NOT NULL REFERENCES domain(id) ON DELETE CASCADE,
  trigger         text NOT NULL CHECK (trigger IN ('handmatig', 'bewaking')),
  status          text NOT NULL DEFAULT 'wachtrij' CHECK (status IN ('wachtrij', 'bezig', 'klaar', 'mislukt')),
  max_level       smallint NOT NULL DEFAULT 1 CHECK (max_level IN (0, 1)),
  scanner_version text,
  started_at      timestamptz,
  finished_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE check_run (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_id       uuid NOT NULL REFERENCES scan(id) ON DELETE CASCADE,
  asset_id      uuid NOT NULL REFERENCES asset(id) ON DELETE CASCADE,
  check_key     text NOT NULL,
  level         smallint NOT NULL CHECK (level IN (0, 1)),
  outcome       text NOT NULL CHECK (outcome IN ('ok', 'finding', 'unknown', 'error', 'not_applicable')),
  message       text,
  -- Verwijzing naar ruw bewijs in objectopslag (EU); niet de data zelf.
  evidence_ref  text,
  duration_ms   integer,
  UNIQUE (scan_id, asset_id, check_key)
);

CREATE TABLE action (
  key       text PRIMARY KEY,
  title     text NOT NULL,
  why       text NOT NULL,
  for_who   text NOT NULL CHECK (for_who IN ('zelf', 'it-partner', 'webbouwer'))
);

CREATE TABLE finding (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id        uuid NOT NULL REFERENCES asset(id) ON DELETE CASCADE,
  check_key       text NOT NULL,
  finding_key     text NOT NULL,
  fingerprint     text NOT NULL UNIQUE,
  certainty       text NOT NULL CHECK (certainty IN ('vastgesteld', 'mogelijk', 'onbekend', 'opgegeven')),
  title           text NOT NULL,
  detail          text NOT NULL,
  action_key      text REFERENCES action(key),
  first_seen      timestamptz NOT NULL DEFAULT now(),
  last_seen       timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz,
  accepted_by     uuid REFERENCES app_user(id),
  accepted_at     timestamptz
);
CREATE INDEX finding_open_idx ON finding (asset_id) WHERE resolved_at IS NULL;

CREATE TABLE vuln (
  cve_id      text PRIMARY KEY,
  euvd_id     text,
  cvss        numeric(3, 1),
  cwe_ids     text[] NOT NULL DEFAULT '{}',
  cpes        jsonb NOT NULL DEFAULT '[]',
  in_kev      boolean NOT NULL DEFAULT false,
  epss        numeric(6, 5),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE finding_vuln (
  finding_id  uuid NOT NULL REFERENCES finding(id) ON DELETE CASCADE,
  cve_id      text NOT NULL REFERENCES vuln(cve_id),
  PRIMARY KEY (finding_id, cve_id)
);

CREATE TABLE answer (
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  question_key    text NOT NULL,
  answer          jsonb NOT NULL,
  answered_by     uuid REFERENCES app_user(id),
  answered_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, question_key)
);

CREATE TABLE score_snapshot (
  scan_id        uuid PRIMARY KEY REFERENCES scan(id) ON DELETE CASCADE,
  urgency        smallint NOT NULL CHECK (urgency BETWEEN 0 AND 100),
  band           text NOT NULL CHECK (band IN ('weinig', 'aandacht', 'hoog', 'direct')),
  coverage_pct   smallint NOT NULL CHECK (coverage_pct BETWEEN 0 AND 100),
  model_version  text NOT NULL,
  -- Volledige berekening (bijdragen per bevinding, top-acties), zodat een rapport exact reproduceerbaar is.
  detail         jsonb NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE share_link (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_id     uuid NOT NULL REFERENCES scan(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  recipient   text,
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  created_by  uuid REFERENCES app_user(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id uuid REFERENCES organization(id) ON DELETE SET NULL,
  actor           text NOT NULL,
  action          text NOT NULL,
  subject         text,
  detail          jsonb,
  at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_org_idx ON audit_log (organization_id, at DESC);
