-- Klantdashboard: bronnen per bevinding en snelle opvragingen.
-- Elke bevinding zegt waar ze op steunt (bijvoorbeeld NVD, CISA KEV,
-- endoflife.date), zodat de klant het zelf kan nalezen. De scanner levert die
-- bronnen al; hier krijgen ze een vaste plek.

ALTER TABLE finding
  ADD COLUMN sources jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(sources) = 'array');

CREATE INDEX finding_resolved_idx ON finding (resolved_at) WHERE resolved_at IS NOT NULL;
CREATE INDEX asset_org_idx ON asset (organization_id, status);
