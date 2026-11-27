import { createHash } from 'node:crypto';
import type pg from 'pg';
import { many, one } from '@qbicle/platform';
import type { ScanReport } from '@qbicle/scanner';
import type { Finding } from '@qbicle/score';

/**
 * Schrijft het rapport van één scan weg: assets, checks, bevindingen en score.
 *
 * Regels:
 * - Een bevinding die terugkomt, werkt de open rij bij (laatst gezien).
 * - Een bevinding verdwijnt alleen als "opgelost" als dezelfde check op hetzelfde
 *   asset deze keer echt is uitgevoerd (ok of finding). Kon de check niet
 *   (unknown, error), dan weten we het niet en blijft de bevinding open.
 * - Komt een opgeloste bevinding later terug, dan is dat een nieuwe rij, zodat
 *   de trend over de afgelopen weken klopt.
 * - Een hercontrole (job.checkKeys) draait alleen een paar checks: geen score,
 *   geen websites als verdwenen markeren, geen mail na de eerste scan.
 * - Alles in één transactie, samen met het afronden van de scan. Is de scan
 *   intussen door iemand anders opgepakt, dan slaan we niets op.
 */

export interface ScanJob {
  id: string;
  domainId: string;
  domainName: string;
  organizationId: string;
  maxLevel: 0 | 1;
  attempts: number;
  claimedBy: string;
  /** Hercontrole: alleen deze checks (null = volledige scan). */
  checkKeys?: string[] | null;
}

export interface StoreResult {
  assets: number;
  checks: number;
  nieuw: number;
  bijgewerkt: number;
  opgelost: number;
  urgency: number;
  /** De eerste geslaagde scan van dit domein (dan mailen we de klant). */
  eerste: boolean;
  /** Aantal acties uit het scoremodel. */
  acties: number;
}

export class StaleScanError extends Error {
  constructor(scanId: string) {
    super(`Scan ${scanId} is niet meer van deze worker; resultaat niet opgeslagen.`);
  }
}

const assetKey = (type: string, value: string) => `${type}|${value}`;

/** Unieke vingerafdruk per episode: zelfde fout die na oplossen terugkomt, krijgt een nieuwe rij. */
export function episodeFingerprint(assetId: string, scanFingerprint: string, firstSeen: Date): string {
  return createHash('sha256').update(`${assetId}|${scanFingerprint}|${firstSeen.toISOString()}`).digest('hex').slice(0, 40);
}

export async function storeScanReport(client: pg.PoolClient, job: ScanJob, report: ScanReport): Promise<StoreResult> {
  const now = new Date(report.finishedAt);

  const mine = await one<{ id: string }>(
    client,
    "SELECT id FROM scan WHERE id = $1 AND status = 'bezig' AND claimed_by = $2 FOR UPDATE",
    [job.id, job.claimedBy],
  );
  if (!mine) throw new StaleScanError(job.id);

  // 1. Assets ----------------------------------------------------------------------
  const assetIds = new Map<string, string>();
  for (const a of report.assets) {
    const r = await one<{ id: string }>(
      client,
      `INSERT INTO asset AS x (organization_id, domain_id, type, value, source, visibility, exposure, status, first_seen, last_seen)
       VALUES ($1, $2, $3, $4, 'scanner', $5, 'internet', 'actief', $6, $6)
       ON CONFLICT (organization_id, type, value) DO UPDATE SET
         last_seen = EXCLUDED.last_seen, status = 'actief',
         domain_id = coalesce(x.domain_id, EXCLUDED.domain_id),
         visibility = coalesce(x.visibility, EXCLUDED.visibility),
         exposure = CASE WHEN x.exposure = 'onbekend' THEN 'internet' ELSE x.exposure END
       RETURNING id`,
      [job.organizationId, job.domainId, a.type, a.value, a.visibility, now],
    );
    assetIds.set(assetKey(a.type, a.value), r!.id);
  }

  // Websites die de scanner eerder vond en nu met zekerheid niet meer: verdwenen.
  // Alleen als het opzoeken van alle websites lukte; anders weten we het niet.
  const partial = Boolean(job.checkKeys?.length);
  const discoveryComplete = !partial && report.maxLevel >= 1 && report.websites.every((w) => w.status !== 'onbekend');
  if (discoveryComplete) {
    await client.query(
      `UPDATE asset SET status = 'verdwenen'
        WHERE organization_id = $1 AND domain_id = $2 AND source = 'scanner' AND type = 'website'
          AND status = 'actief' AND NOT (id = ANY($3::uuid[]))`,
      [job.organizationId, job.domainId, [...assetIds.values()]],
    );
  }

  // 2. Checks ----------------------------------------------------------------------
  await client.query('DELETE FROM check_run WHERE scan_id = $1', [job.id]);
  const completed = new Set<string>();
  for (const c of report.checks) {
    const assetId = assetIds.get(assetKey(c.asset.type, c.asset.value));
    if (!assetId) continue;
    await client.query(
      `INSERT INTO check_run (scan_id, asset_id, check_key, level, outcome, message, duration_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (scan_id, asset_id, check_key) DO NOTHING`,
      [job.id, assetId, c.checkKey, c.level, c.outcome, c.message?.slice(0, 2000) ?? null, c.durationMs],
    );
    if (c.outcome === 'ok' || c.outcome === 'finding') completed.add(`${assetId}|${c.checkKey}`);
  }

  // 3. Bevindingen -----------------------------------------------------------------
  let nieuw = 0;
  let bijgewerkt = 0;
  const seen = new Set<string>();
  for (const f of report.findings) {
    const assetId = assetIds.get(assetKey(f.asset.type, f.asset.value));
    if (!assetId) continue;
    seen.add(`${assetId}|${f.fingerprint}`);
    const sources = JSON.stringify((f.sources ?? []).filter((s) => typeof s?.url === 'string' && s.url.startsWith('https://')));
    const open = await one<{ id: string }>(
      client,
      'SELECT id FROM finding WHERE asset_id = $1 AND scan_fingerprint = $2 AND resolved_at IS NULL',
      [assetId, f.fingerprint],
    );
    let findingId: string;
    if (open) {
      await client.query(
        `UPDATE finding SET last_seen = $2, certainty = $3, title = $4, detail = $5, sources = $6,
                finding_key = $7, check_key = $8, last_scan_id = $9 WHERE id = $1`,
        [open.id, now, f.certainty, f.title, f.detail, sources, f.key, f.checkKey, job.id],
      );
      findingId = open.id;
      bijgewerkt++;
    } else {
      const r = await one<{ id: string }>(
        client,
        `INSERT INTO finding (asset_id, check_key, finding_key, fingerprint, scan_fingerprint, certainty, title, detail,
                              sources, first_seen, last_seen, last_scan_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10, $11) RETURNING id`,
        [assetId, f.checkKey, f.key, episodeFingerprint(assetId, f.fingerprint, now), f.fingerprint, f.certainty,
          f.title, f.detail, sources, now, job.id],
      );
      findingId = r!.id;
      nieuw++;
    }
    await storeVulns(client, findingId, f);
  }

  // Opgelost: open bevindingen van de scanner op deze assets, waarvan de check nu
  // wel draaide maar de bevinding niet meer zag.
  const candidates = await many<{ id: string; asset_id: string; check_key: string; scan_fingerprint: string }>(
    client,
    `SELECT id, asset_id, check_key, scan_fingerprint FROM finding
      WHERE asset_id = ANY($1::uuid[]) AND resolved_at IS NULL AND scan_fingerprint IS NOT NULL`,
    [[...assetIds.values()]],
  );
  const toResolve = candidates
    .filter((c) => completed.has(`${c.asset_id}|${c.check_key}`) && !seen.has(`${c.asset_id}|${c.scan_fingerprint}`))
    .map((c) => c.id);
  if (toResolve.length) {
    await client.query('UPDATE finding SET resolved_at = $2, resolved_scan_id = $3 WHERE id = ANY($1::uuid[])', [toResolve, now, job.id]);
  }

  // 4. Score en afronden -----------------------------------------------------------
  const eerdere = await one<{ n: number }>(
    client,
    "SELECT count(*)::int AS n FROM scan WHERE domain_id = $1 AND status = 'klaar' AND id <> $2",
    [job.domainId, job.id],
  );
  const s = report.score;
  // Een hercontrole draait maar een paar checks; die score zegt niets over het geheel.
  if (!partial) await client.query(
    `INSERT INTO score_snapshot (scan_id, urgency, band, coverage_pct, model_version, detail)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (scan_id) DO UPDATE SET urgency = EXCLUDED.urgency, band = EXCLUDED.band,
       coverage_pct = EXCLUDED.coverage_pct, model_version = EXCLUDED.model_version, detail = EXCLUDED.detail, created_at = now()`,
    [job.id, s.urgency, s.band.key, s.coverage.pct, s.modelVersion, JSON.stringify(s)],
  );
  await client.query(
    `UPDATE scan SET status = 'klaar', finished_at = $2, scanner_version = $3, error = NULL,
            max_level = $4 WHERE id = $1`,
    [job.id, now, report.scannerVersion, report.maxLevel],
  );

  return { assets: assetIds.size, checks: report.checks.length, nieuw, bijgewerkt, opgelost: toResolve.length, urgency: s.urgency,
    eerste: !partial && (eerdere?.n ?? 0) === 0, acties: s.actionCount };
}

async function storeVulns(client: pg.PoolClient, findingId: string, f: Finding): Promise<void> {
  await client.query('DELETE FROM finding_vuln WHERE finding_id = $1', [findingId]);
  for (const v of f.vulns ?? []) {
    if (!/^CVE-\d{4}-\d{4,}$/.test(v.cveId)) continue;
    await client.query(
      `INSERT INTO vuln AS x (cve_id, cvss, in_kev, epss) VALUES ($1, $2, $3, $4)
       ON CONFLICT (cve_id) DO UPDATE SET cvss = coalesce(EXCLUDED.cvss, x.cvss), in_kev = x.in_kev OR EXCLUDED.in_kev,
         epss = coalesce(EXCLUDED.epss, x.epss), updated_at = now()`,
      [v.cveId, v.cvss ?? null, v.inKev ?? false, v.epss ?? null],
    );
    await client.query('INSERT INTO finding_vuln (finding_id, cve_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [findingId, v.cveId]);
  }
}
