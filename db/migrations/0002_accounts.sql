-- Klant- en gebruikersbeheer: accounts, inloggen, rollen, IT-partners,
-- uitnodigingen, domeinverificatie, misbruiklimieten en een onwijzigbaar audit-log.
--
-- Uitgangspunten:
-- * Tokens (inloglink, sessie, uitnodiging, verificatiemail) worden nooit als
--   platte tekst opgeslagen, alleen als SHA-256-hash.
-- * Een IT-partner krijgt toegang tot een klant via partner_access, niet via
--   een lidmaatschap. De klant kan die toegang altijd intrekken.

-- Gebruikers -----------------------------------------------------------------

ALTER TABLE app_user
  ADD COLUMN display_name  text CHECK (char_length(display_name) <= 120),
  ADD COLUMN last_login_at timestamptz,
  ADD COLUMN disabled_at   timestamptz;

-- Rollen binnen een organisatie: eigenaar, beheerder, lezer.
-- De oude rol 'partner' vervalt: partners lopen via partner_access.
ALTER TABLE membership DROP CONSTRAINT membership_role_check;
UPDATE membership SET role = 'lezer' WHERE role = 'partner';
ALTER TABLE membership
  ADD CONSTRAINT membership_role_check CHECK (role IN ('eigenaar', 'beheerder', 'lezer'));
CREATE INDEX membership_user_idx ON membership (user_id);

ALTER TABLE organization
  ADD COLUMN created_by uuid REFERENCES app_user(id) ON DELETE SET NULL,
  ADD CONSTRAINT organization_name_check CHECK (char_length(name) BETWEEN 1 AND 120);

-- IT-partners en adviseurs met toegang tot klanten ---------------------------

CREATE TABLE partner_access (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_org_id    uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  client_org_id     uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  -- Hoogste rol die medewerkers van de partner bij deze klant krijgen.
  access            text NOT NULL CHECK (access IN ('beheerder', 'lezer')),
  granted_by        uuid REFERENCES app_user(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  revoked_at        timestamptz,
  revoked_by        uuid REFERENCES app_user(id) ON DELETE SET NULL,
  CHECK (partner_org_id <> client_org_id)
);
CREATE UNIQUE INDEX partner_access_active_idx
  ON partner_access (partner_org_id, client_org_id) WHERE revoked_at IS NULL;
CREATE INDEX partner_access_client_idx ON partner_access (client_org_id) WHERE revoked_at IS NULL;

-- Inloggen met een link per e-mail ------------------------------------------

CREATE TABLE login_token (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         citext NOT NULL,
  token_hash    bytea NOT NULL UNIQUE,
  expires_at    timestamptz NOT NULL,
  used_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_token_email_idx ON login_token (email, created_at DESC);

CREATE TABLE user_session (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  token_hash    bytea NOT NULL UNIQUE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  ip            inet,
  user_agent    text CHECK (char_length(user_agent) <= 400)
);
CREATE INDEX user_session_user_idx ON user_session (user_id) WHERE revoked_at IS NULL;

-- Uitnodigingen --------------------------------------------------------------

CREATE TABLE invitation (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  email           citext NOT NULL,
  role            text NOT NULL CHECK (role IN ('eigenaar', 'beheerder', 'lezer')),
  token_hash      bytea NOT NULL UNIQUE,
  invited_by      uuid REFERENCES app_user(id) ON DELETE SET NULL,
  expires_at      timestamptz NOT NULL,
  accepted_at     timestamptz,
  accepted_by     uuid REFERENCES app_user(id) ON DELETE SET NULL,
  revoked_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX invitation_open_idx
  ON invitation (organization_id, email) WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- Domeinverificatie ----------------------------------------------------------

ALTER TABLE domain
  ADD COLUMN added_by                uuid REFERENCES app_user(id) ON DELETE SET NULL,
  ADD COLUMN verified_by             uuid REFERENCES app_user(id) ON DELETE SET NULL,
  -- Laatste keer dat de verificatie opnieuw is gecontroleerd (DNS-record staat er nog).
  ADD COLUMN verification_checked_at timestamptz;
UPDATE domain SET verification_token = encode(gen_random_bytes(16), 'hex') WHERE verification_token IS NULL;
ALTER TABLE domain ALTER COLUMN verification_token SET NOT NULL;
ALTER TABLE domain ADD CONSTRAINT domain_verified_consistent
  CHECK ((verified_at IS NULL) = (verification_method IS NULL));

CREATE TABLE domain_email_challenge (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  domain_id   uuid NOT NULL REFERENCES domain(id) ON DELETE CASCADE,
  address     citext NOT NULL,
  token_hash  bytea NOT NULL UNIQUE,
  created_by  uuid REFERENCES app_user(id) ON DELETE SET NULL,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Wie heeft een scan aangevraagd.
ALTER TABLE scan ADD COLUMN requested_by uuid REFERENCES app_user(id) ON DELETE SET NULL;

-- Misbruiklimieten -----------------------------------------------------------
-- De sleutel is een hash (bijv. van een e-mailadres of IP), geen persoonsgegeven in leesbare vorm.

CREATE TABLE rate_limit_hit (
  bucket  text NOT NULL,
  key     bytea NOT NULL,
  at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rate_limit_hit_idx ON rate_limit_hit (bucket, key, at);

-- Audit-log: alleen toevoegen ----------------------------------------------------
-- Geen foreign key meer naar organization: het log moet blijven bestaan, ook als
-- een organisatie wordt verwijderd, en een FK-actie zou een UPDATE vereisen.

ALTER TABLE audit_log DROP CONSTRAINT audit_log_organization_id_fkey;
ALTER TABLE audit_log
  ADD COLUMN actor_user_id uuid,
  ADD COLUMN ip            inet;

CREATE FUNCTION audit_log_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Opschonen na de bewaartermijn gebeurt bewust, met SET qbicle.audit_onderhoud = 'aan'.
  IF current_setting('qbicle.audit_onderhoud', true) = 'aan' AND TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit_log is alleen-toevoegen';
END;
$$;

CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_append_only();
