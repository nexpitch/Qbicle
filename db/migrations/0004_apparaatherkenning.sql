-- Apparaatherkenning via routers en netwerkapparatuur (stap 1, zie docs/apparaatherkenning.md).
-- Nieuwe categorieën, gepseudonimiseerde MAC-adressen, de bron "afleiding" en
-- versleutelde inloggegevens per bron.

-- Categorieën die MKB-klanten herkennen: slimme speaker, alarmsysteem, zonnepanelen, laadpaal.
ALTER TABLE asset DROP CONSTRAINT asset_category_check;
ALTER TABLE asset ADD CONSTRAINT asset_category_check CHECK (category IN (
  'laptop', 'desktop', 'telefoon', 'tablet', 'server', 'printer', 'camera', 'nas',
  'router', 'firewall', 'accesspoint', 'switch', 'iot', 'tv-media',
  'slimme-speaker', 'alarmsysteem', 'zonnepanelen', 'laadpaal', 'onbekend'
));

-- AVG: MAC-adressen van gastapparaten bewaren we alleen als HMAC per organisatie.
ALTER TABLE asset_identifier DROP CONSTRAINT asset_identifier_type_check;
ALTER TABLE asset_identifier ADD CONSTRAINT asset_identifier_type_check CHECK (type IN (
  'serial', 'cloud-id', 'mac', 'mac-hash', 'hostname', 'ip', 'fqdn', 'url', 'cert', 'upn'
));

-- Wat Qbicle zelf afleidt (MAC-prefix, hostnaam, diensten) is een eigen bron met de laagste prioriteit.
ALTER TABLE source DROP CONSTRAINT source_kind_check;
ALTER TABLE source ADD CONSTRAINT source_kind_check CHECK (kind IN (
  'scanner', 'mdm', 'rmm', 'identity', 'cloud', 'netwerk', 'connector', 'internetdata', 'opgegeven', 'afleiding'
));

-- Inloggegevens van routers en controllers die vanuit de cloud worden uitgelezen
-- (bijvoorbeeld UniFi). Alleen versleuteld (AES-256-GCM, formaat "v1.<sleutel>.<iv>.<tag>.<data>");
-- de sleutel staat niet in de database (QBICLE_SECRETS_KEYS of kluis). De versleuteling
-- is gebonden aan organisatie en bron, dus een rij kopiëren naar een andere bron werkt niet.
-- Routers die alleen via de lokale connector bereikbaar zijn (FRITZ!Box, MikroTik)
-- houden hun wachtwoord op de connector; dan blijft deze tabel leeg voor die bron.
CREATE TABLE source_secret (
  source_id       uuid PRIMARY KEY REFERENCES source(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  sealed          text NOT NULL CHECK (sealed LIKE 'v1.%'),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX source_secret_org_idx ON source_secret (organization_id);
