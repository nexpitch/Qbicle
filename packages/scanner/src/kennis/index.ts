import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { VulnDb } from '@qbicle/devices';
import { BASE_KEV, BASE_NVD } from './software.ts';

export * from './software.ts';

/**
 * Kwetsbaarheidskennis voor de scanner: altijd de ingebouwde startset, plus de
 * snapshots uit `dir` als die er zijn (nvd*.json in NVD API 2.0-formaat,
 * kev.json van CISA, epss*.csv van FIRST). Leest alleen bestanden; haalt niets op.
 */
export function loadVulnDb(dir = process.env.QBICLE_VULN_DIR): VulnDb {
  const db = new VulnDb();
  db.addNvd(BASE_NVD);
  db.addKev(BASE_KEV);
  if (dir && existsSync(dir)) {
    for (const f of readdirSync(dir).sort()) {
      const p = join(dir, f);
      if (/^nvd.*\.json$/i.test(f)) db.addNvd(JSON.parse(readFileSync(p, 'utf8')));
      else if (/^kev.*\.json$/i.test(f)) db.addKev(JSON.parse(readFileSync(p, 'utf8')));
      else if (/^epss.*\.csv$/i.test(f)) db.addEpssCsv(readFileSync(p, 'utf8'));
    }
  }
  return db;
}

let shared: VulnDb | undefined;
/** Eén gedeelde database per proces; inlezen kost tijd bij een volledige NVD-snapshot. */
export function sharedVulnDb(): VulnDb {
  shared ??= loadVulnDb();
  return shared;
}
