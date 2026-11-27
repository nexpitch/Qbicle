-- Hercontrole van één bevinding ("Ik heb het gedaan, controleer nu"): een scan
-- die alleen de genoemde checks draait. Zo'n scan telt niet als volledige scan
-- (geen nieuwe score, geen invloed op de wekelijkse planning of de afkoeltijd).
ALTER TABLE scan ADD COLUMN IF NOT EXISTS check_keys text[];
ALTER TABLE scan ADD COLUMN IF NOT EXISTS finding_id uuid REFERENCES finding(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS scan_finding_idx ON scan (finding_id) WHERE finding_id IS NOT NULL;
