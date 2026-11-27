-- Register van bedrijfskritische systemen (ontwerp "systemen en opslag beoordelen", 27-11-2026).
-- Software waar een organisatie op draait, intern of bij een leverancier (ERP, CRM,
-- boekhouding, webshop, ...), met de zakelijke impact bij uitval of datalek.
-- Het aantal per pakket (MKB 5, Business onbeperkt) bewaakt de applicatie.
-- Nummer 0015: 0010 t/m 0014 zijn in gebruik op andere branches.

CREATE TABLE systeem (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  naam               text NOT NULL CHECK (char_length(naam) BETWEEN 1 AND 120),
  leverancier        text CHECK (char_length(leverancier) <= 120),
  soort              text NOT NULL CHECK (soort IN (
    'erp', 'crm', 'boekhouding', 'webshop', 'kassa', 'planning', 'klantportaal', 'hr-salaris', 'maatwerk', 'overig'
  )),
  hosting            text NOT NULL DEFAULT 'onbekend' CHECK (hosting IN ('saas', 'cloud', 'eigen-server', 'onbekend')),
  adres              text CHECK (char_length(adres) <= 300),
  eigenaar           text CHECK (char_length(eigenaar) <= 120),
  impact_uitval      text NOT NULL CHECK (impact_uitval IN ('laag', 'merkbaar', 'stil')),
  gegevens           text[] NOT NULL DEFAULT '{}' CHECK (gegevens <@ ARRAY['medewerkers', 'klanten', 'betaalgegevens', 'bijzonder']::text[]),
  inloggen           text NOT NULL DEFAULT 'onbekend' CHECK (inloggen IN ('sso', 'mfa', 'wachtwoord', 'onbekend')),
  updates            text NOT NULL DEFAULT 'onbekend' CHECK (updates IN ('leverancier', 'wij', 'niemand', 'onbekend')),
  verwerkersovereenkomst text NOT NULL DEFAULT 'onbekend' CHECK (verwerkersovereenkomst IN ('ja', 'nee', 'onbekend')),
  datalocatie        text NOT NULL DEFAULT 'onbekend' CHECK (datalocatie IN ('eu', 'buiten-eu', 'onbekend')),
  terugval           text NOT NULL DEFAULT 'onbekend' CHECK (terugval IN ('getest', 'niet-getest', 'geen', 'onbekend')),
  notities           text CHECK (char_length(notities) <= 1000),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid REFERENCES app_user(id) ON DELETE SET NULL
);
CREATE INDEX systeem_org_idx ON systeem (organization_id, naam);
