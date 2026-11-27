-- Scanresultaten opslaan: de scan-worker schrijft per scan de assets, checks,
-- bevindingen en score weg, zodat het klantdashboard echte cijfers toont.
--
-- Bevindingen hebben "episodes": dezelfde fout op hetzelfde asset is zolang hij
-- open staat één rij. Is hij opgelost en komt hij later terug, dan komt er een
-- nieuwe rij. Zo blijft de geschiedenis (trend over 12 weken, "opgelost sinds
-- vorige keer") kloppen.

-- Bronnen per bevinding (ook in 0013 van het dashboard; IF NOT EXISTS zodat de volgorde niet uitmaakt).
ALTER TABLE finding
  ADD COLUMN IF NOT EXISTS sources jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(sources) = 'array');

ALTER TABLE finding
  -- Vingerafdruk van de scanner (zelfde fout op zelfde asset, over scans heen).
  ADD COLUMN scan_fingerprint text CHECK (char_length(scan_fingerprint) <= 200),
  ADD COLUMN last_scan_id     uuid REFERENCES scan(id) ON DELETE SET NULL,
  ADD COLUMN resolved_scan_id uuid REFERENCES scan(id) ON DELETE SET NULL;

-- Per asset hooguit één open rij per scannervingerafdruk.
CREATE UNIQUE INDEX finding_open_scan_fp_idx ON finding (asset_id, scan_fingerprint)
  WHERE resolved_at IS NULL AND scan_fingerprint IS NOT NULL;

-- Welke worker een scan oppakte. Een worker rondt alleen af wat hij zelf claimde,
-- zodat een scan die de Bewaker opnieuw in de wachtrij zette niet dubbel wordt opgeslagen.
ALTER TABLE scan
  ADD COLUMN claimed_by text CHECK (char_length(claimed_by) <= 100),
  -- Voortgang per stap tijdens het scannen, voor de live weergave bij de klant.
  ADD COLUMN progress jsonb;

CREATE INDEX scan_domain_recent_idx ON scan (domain_id, created_at DESC);

-- Hartslag van de scan-workers, voor de cockpit (draait er nog een worker?).
CREATE TABLE worker_heartbeat (
  worker_id      text PRIMARY KEY CHECK (char_length(worker_id) <= 100),
  started_at     timestamptz NOT NULL DEFAULT now(),
  last_seen      timestamptz NOT NULL DEFAULT now(),
  scans_klaar    integer NOT NULL DEFAULT 0,
  scans_mislukt  integer NOT NULL DEFAULT 0
);
