-- Infra- en device-inventaris: voorstel (zie ontwerp "Qbicle Infra & Devices", hoofdstuk Assetmodel).
-- Breidt asset en asset_link uit; voegt bronnen, waarnemingen, identifiers,
-- kenmerken met herkomst en componenten toe. Bevat geen scanlogica.

-- Nieuwe soorten assets naast de zeven uit fase 1.
ALTER TABLE asset DROP CONSTRAINT asset_type_check;
ALTER TABLE asset ADD CONSTRAINT asset_type_check CHECK (type IN (
  'domein', 'subdomein', 'host', 'mailserver', 'website', 'certificaat', 'dienst',
  'apparaat', 'netwerkapparaat', 'ip-adres', 'ip-blok', 'account', 'cloudresource'
));

-- Zichtbaarheid geldt voor buitenkant-assets; interne assets hebben die niet.
ALTER TABLE asset ALTER COLUMN visibility DROP NOT NULL;

ALTER TABLE asset
  ADD COLUMN category text NOT NULL DEFAULT 'onbekend' CHECK (category IN (
    'laptop', 'desktop', 'telefoon', 'tablet', 'server', 'printer', 'camera', 'nas',
    'router', 'firewall', 'accesspoint', 'switch', 'iot', 'tv-media', 'onbekend'
  )),
  ADD COLUMN exposure text NOT NULL DEFAULT 'onbekend' CHECK (exposure IN ('internet', 'cloud', 'intern', 'onbekend')),
  ADD COLUMN managed text NOT NULL DEFAULT 'onbekend' CHECK (managed IN ('ja', 'nee', 'onbekend')),
  ADD COLUMN status text NOT NULL DEFAULT 'actief' CHECK (status IN ('actief', 'verdwenen'));

ALTER TABLE asset_link DROP CONSTRAINT asset_link_relation_check;
ALTER TABLE asset_link ADD CONSTRAINT asset_link_relation_check CHECK (relation IN (
  'wijst-naar', 'draait-op', 'beveiligt',
  'verbonden-met', 'beheerd-door', 'gebruikt', 'staat-achter', 'lid-van'
));

-- Een koppeling of connector van een organisatie.
CREATE TABLE source (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN (
    'scanner', 'mdm', 'rmm', 'identity', 'cloud', 'netwerk', 'connector', 'internetdata', 'opgegeven'
  )),
  product         text NOT NULL,
  -- Niveau 3 (kwetsbaarheden uitproberen) bestaat bewust niet.
  level           text NOT NULL CHECK (level IN ('0', '1', '1C', '2P', '2A')),
  network         text,
  status          text NOT NULL DEFAULT 'actief' CHECK (status IN ('actief', 'gepauzeerd', 'ingetrokken', 'fout')),
  -- Wie gaf toestemming en wanneer; verwijzing naar de getekende opdracht bij niveau 2A.
  consent_by      uuid REFERENCES app_user(id),
  consent_at      timestamptz,
  consent_ref     text,
  -- Geheimen (tokens, router-wachtwoorden) staan NIET in deze tabel: alleen een
  -- verwijzing naar de kluis, of ze blijven lokaal op de connector.
  secret_ref      text,
  last_sync_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (level <> '2A' OR consent_ref IS NOT NULL)
);
CREATE INDEX source_org_idx ON source (organization_id);

-- Ruwe waarnemingen: wat één bron op één moment meldde. Bewaartermijn: 90 dagen.
CREATE TABLE observation (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id    uuid NOT NULL REFERENCES source(id) ON DELETE CASCADE,
  asset_id     uuid REFERENCES asset(id) ON DELETE SET NULL,
  observed_at  timestamptz NOT NULL,
  identifiers  jsonb NOT NULL,
  attributes   jsonb NOT NULL DEFAULT '{}',
  certainty    text NOT NULL DEFAULT 'vastgesteld' CHECK (certainty IN ('vastgesteld', 'mogelijk', 'onbekend', 'opgegeven'))
);
CREATE INDEX observation_asset_idx ON observation (asset_id, observed_at DESC);
CREATE INDEX observation_age_idx ON observation (observed_at);

-- Identifiers waarmee we een asset herkennen. Uniek per organisatie: zo vindt
-- een nieuwe waarneming met één opzoeking het bestaande asset.
CREATE TABLE asset_identifier (
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  type            text NOT NULL CHECK (type IN ('serial', 'cloud-id', 'mac', 'hostname', 'ip', 'fqdn', 'url', 'cert', 'upn')),
  value           text NOT NULL,
  -- Zwakke identifiers (hostnaam, privé-IP) gelden alleen binnen één netwerk.
  scope           text NOT NULL DEFAULT '',
  strength        text NOT NULL CHECK (strength IN ('sterk', 'zwak')),
  asset_id        uuid NOT NULL REFERENCES asset(id) ON DELETE CASCADE,
  last_seen       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, type, value, scope)
);
CREATE INDEX asset_identifier_asset_idx ON asset_identifier (asset_id);

-- Kenmerken met herkomst: per kenmerk de winnende waarde en welke bron die leverde.
CREATE TABLE asset_attribute (
  asset_id     uuid NOT NULL REFERENCES asset(id) ON DELETE CASCADE,
  key          text NOT NULL,
  value        jsonb NOT NULL,
  source_id    uuid REFERENCES source(id) ON DELETE SET NULL,
  observed_at  timestamptz NOT NULL,
  certainty    text NOT NULL CHECK (certainty IN ('vastgesteld', 'mogelijk', 'onbekend', 'opgegeven')),
  PRIMARY KEY (asset_id, key)
);

-- Software en firmware op een asset, met CPE-kandidaat voor koppeling aan CVE's.
CREATE TABLE component (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id    uuid NOT NULL REFERENCES asset(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('os', 'firmware', 'software', 'dienst')),
  vendor      text,
  product     text NOT NULL,
  version     text,
  cpe         text,
  cpe_certainty text NOT NULL DEFAULT 'mogelijk' CHECK (cpe_certainty IN ('vastgesteld', 'mogelijk', 'onbekend')),
  eol_date    date,
  source_id   uuid REFERENCES source(id) ON DELETE SET NULL,
  last_seen   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (asset_id, kind, product)
);
CREATE INDEX component_cpe_idx ON component (cpe) WHERE cpe IS NOT NULL;
