import type { LinkedVuln, Source } from '@qbicle/score';
import { buildCpe, compareVersions, type VulnDb } from '@qbicle/devices';
import type { HttpResponse } from './net.ts';
import { CONDITIONAL, PRODUCTS, type ProductDef } from './kennis/software.ts';

/**
 * Herkenning van websitesoftware uit wat de website zelf meestuurt (Server,
 * X-Powered-By, generator-tag), en koppeling aan einde-ondersteuning en bekende lekken.
 *
 * Twee regels om valse meldingen te voorkomen:
 * - Linux-distributies (Debian, Ubuntu, Red Hat ...) zetten beveiligingsfixes terug
 *   zonder het versienummer te verhogen. Zien we zo'n distributie, dan is een lek of
 *   einde-ondersteuning hooguit "mogelijk".
 * - Een lek waarvoor een voorwaarde geldt die we niet kunnen zien, is ook "mogelijk".
 */
export interface DetectedSoftware {
  /** Zoals de website het noemt, bijvoorbeeld "Apache". */
  rawProduct: string;
  /** Ruwe versie, bijvoorbeeld "7.4.3-4ubuntu2.18". */
  rawVersion: string;
  /** Genormaliseerde versie, bijvoorbeeld "7.4.3". */
  version: string;
  source: string;
  /** Distributie die fixes terugzet, als we die herkennen. */
  backportDistro: string | null;
  product: ProductDef | null;
}

const DISTRO = /(ubuntu|debian|deb\d+u|red ?hat|rhel|centos|rocky|almalinux|fedora|suse|amazon linux|\.el\d|el\d+_?\d*|-fips)/i;

function distroName(text: string): string | null {
  const m = text.match(DISTRO);
  if (!m) return null;
  const s = m[1]!.toLowerCase();
  if (s.includes('ubuntu')) return 'Ubuntu';
  if (s.includes('deb')) return 'Debian';
  if (s.includes('suse')) return 'SUSE';
  if (s.includes('fedora')) return 'Fedora';
  if (s.includes('amazon')) return 'Amazon Linux';
  // -fips en .elN komen van Red Hat-achtige distributies (RHEL, CentOS, Rocky, Alma).
  return 'Red Hat-achtige Linux';
}

export function normalizeVersion(raw: string): string {
  // "1.0.2k-fips" -> "1.0.2k", "7.4.3-4ubuntu2.18" -> "7.4.3", "8.1.2-1ubuntu2.14" -> "8.1.2"
  return raw.match(/^\d+(?:\.\d+)+[a-z]?/i)?.[0] ?? raw;
}

/** Product/versie-paren uit headers en de generator-tag, met de opmerking tussen haakjes erbij. */
export function detectSoftware(res: HttpResponse): DetectedSoftware[] {
  const out: DetectedSoftware[] = [];
  const re = /([A-Za-z][A-Za-z0-9._-]*)\/(\d+(?:\.\d+)+[A-Za-z0-9.+~_-]*)(\s*\([^)]*\))?/g;
  for (const header of ['server', 'x-powered-by', 'x-aspnet-version', 'x-generator']) {
    const v = res.headers[header];
    if (!v) continue;
    if (header === 'x-aspnet-version' && /^\d+(\.\d+)+/.test(v)) {
      out.push(make('ASP.NET', v.trim(), `header:${header}`, null));
      continue;
    }
    // Een distributie tussen haakjes geldt voor alle software in dezelfde header,
    // bijvoorbeeld "Apache/2.4.41 (Ubuntu) PHP/7.4.3".
    const headerDistro = distroName(v.match(/\(([^)]*)\)/g)?.join(' ') ?? '');
    for (const m of v.matchAll(re)) {
      const distro = distroName(m[2]!) ?? distroName(m[3] ?? '') ?? headerDistro;
      out.push(make(m[1]!, m[2]!, `header:${header}`, distro));
    }
  }
  const gen =
    res.body.match(/<meta[^>]+name=["']generator["'][^>]*content=["']([^"']+)["']/i) ??
    res.body.match(/<meta[^>]+content=["']([^"']+)["'][^>]*name=["']generator["']/i);
  if (gen) {
    const m = gen[1]!.match(/^(.*?)\s+v?(\d+(?:\.\d+)+)/);
    if (m) out.push(make(m[1]!.trim(), m[2]!, 'html:meta-generator', null));
  }
  const seen = new Set<string>();
  return out.filter((s) => {
    const k = `${s.rawProduct.toLowerCase()}/${s.version}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function make(rawProduct: string, rawVersion: string, source: string, distro: string | null): DetectedSoftware {
  return {
    rawProduct,
    rawVersion,
    version: normalizeVersion(rawVersion),
    source,
    backportDistro: distro,
    product: PRODUCTS.find((p) => p.match.test(rawProduct)) ?? null,
  };
}

export interface EolAssessment {
  status: 'einde' | 'binnenkort' | 'ondersteund';
  cycle: string;
  date?: string;
}

const SOON_DAYS = 90;

export function assessEol(sw: DetectedSoftware, now: Date): EolAssessment | null {
  const p = sw.product;
  if (!p?.cycles) return null;
  const candidates = p.cycleOf
    ? p.cycleOf(sw.version)
    : (() => {
        const parts = sw.version.split('.');
        return [parts.slice(0, 2).join('.')];
      })();
  for (const c of candidates) {
    const hit = p.cycles.find((x) => compareVersions(x.cycle, c) === 0 && x.cycle.split('.').length === c.split('.').length);
    if (!hit) continue;
    if (hit.eol === true) return { status: 'einde', cycle: hit.cycle };
    if (hit.eol === false) return { status: 'ondersteund', cycle: hit.cycle };
    const t = Date.parse(hit.eol);
    if (t < now.getTime()) return { status: 'einde', cycle: hit.cycle, date: hit.eol };
    if (t - now.getTime() < SOON_DAYS * 86400_000) return { status: 'binnenkort', cycle: hit.cycle, date: hit.eol };
    return { status: 'ondersteund', cycle: hit.cycle, date: hit.eol };
  }
  return null;
}

export interface VulnHit {
  cveId: string;
  cvss?: number;
  inKev: boolean;
  description?: string;
  condition?: string;
  linked: LinkedVuln;
}

export function vulnsFor(sw: DetectedSoftware, db: VulnDb): VulnHit[] {
  const cpe = sw.product?.cpe;
  if (!cpe) return [];
  const hits = db.match([
    {
      assetKey: 'website',
      kind: 'software',
      vendor: cpe.vendor,
      product: sw.product!.name,
      version: sw.version,
      rawVersion: sw.rawVersion,
      cpe: buildCpe('a', cpe.vendor, cpe.product, sw.version),
      cpeCertainty: 'vastgesteld',
      sourceId: sw.source,
    },
  ]);
  return hits
    .filter((h) => h.certainty === 'vastgesteld')
    .map((h) => ({
      cveId: h.cve.id,
      cvss: h.cve.cvss,
      inKev: Boolean(h.kev),
      description: h.cve.description,
      condition: CONDITIONAL[h.cve.id],
      linked: h.linked,
    }));
}

export function vulnSources(hits: VulnHit[]): Source[] {
  const out: Source[] = hits.map((h) => ({ name: `NVD ${h.cveId}`, url: `https://nvd.nist.gov/vuln/detail/${h.cveId}` }));
  if (hits.some((h) => h.inKev)) out.push({ name: 'CISA KEV', url: 'https://www.cisa.gov/known-exploited-vulnerabilities-catalog' });
  return out;
}
