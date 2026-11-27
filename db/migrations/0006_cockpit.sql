-- Interne cockpit: medewerkers van Qbicle, hun eigen inloglinks en sessies (met MFA).
--
-- Uitgangspunten:
-- * De cockpit staat los van de klantomgeving: een eigen cookie, eigen sessies
--   en een eigen inloglink. Een klantsessie geeft nooit toegang tot de cockpit.
-- * Een medewerker is een gewone gebruiker (app_user) met een rij in staff_member.
--   Andere tabellen verwijzen naar app_user(id), net als audit_log.actor_user_id.
-- * MFA (TOTP) is verplicht. Het TOTP-geheim staat versleuteld (AES-256-GCM,
--   sleutel buiten de database, zie QBICLE_SECRETS_KEYS).
-- * Elke beheeractie komt in het bestaande, alleen-toevoegen audit_log
--   (acties 'cockpit.*').

CREATE TABLE staff_member (
  user_id           uuid PRIMARY KEY REFERENCES app_user(id) ON DELETE RESTRICT,
  role              text NOT NULL CHECK (role IN ('beheerder', 'financieel', 'support', 'lezer')),
  added_by          uuid REFERENCES app_user(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  revoked_at        timestamptz,
  revoked_by        uuid REFERENCES app_user(id) ON DELETE SET NULL,
  -- MFA: versleuteld geheim; pas geldig na bevestiging met een eerste code.
  totp_secret_sealed text,
  totp_confirmed_at  timestamptz,
  -- Laatst gebruikte tijdstap: dezelfde code werkt maar één keer.
  totp_last_step     bigint,
  CHECK (totp_confirmed_at IS NULL OR totp_secret_sealed IS NOT NULL)
);

CREATE TABLE staff_login_token (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  token_hash    bytea NOT NULL UNIQUE,
  expires_at    timestamptz NOT NULL,
  used_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX staff_login_token_user_idx ON staff_login_token (user_id, created_at DESC);

CREATE TABLE staff_session (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  token_hash    bytea NOT NULL UNIQUE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  -- Pas na een geldige MFA-code is de sessie volwaardig.
  mfa_at        timestamptz,
  revoked_at    timestamptz,
  ip            inet,
  user_agent    text CHECK (char_length(user_agent) <= 400)
);
CREATE INDEX staff_session_user_idx ON staff_session (user_id) WHERE revoked_at IS NULL;

-- Snel filteren op beheeracties in het audit-log.
CREATE INDEX audit_log_action_idx ON audit_log (action text_pattern_ops, id DESC);
