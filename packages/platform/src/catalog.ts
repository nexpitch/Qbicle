import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Prijzen en pakketten. De bron is config/abonnementen.json, zodat een prijs
 * wijzigen (bijv. de open keuze €49 of €39 voor MKB) één regel in één bestand is.
 * Bedragen in het bestand zijn euro's per maand excl. btw; hier rekenen we in centen.
 */

export const BILLING_INTERVALS = ['maand', 'jaar'] as const;
export type BillingInterval = (typeof BILLING_INTERVALS)[number];

export type Product = 'mkb' | 'corporate' | 'audit';

export interface Limits {
  domeinen: number;
  gebruikers: number;
  itPartners: number;
}

export interface Plan {
  id: string;
  product: Exclude<Product, 'audit'>;
  naam: string;
  kort: string;
  voorWie: string;
  /** Prijs per maand excl. btw in centen, per betaalinterval. */
  maandprijsCenten: Record<BillingInterval, number>;
  limieten: Limits;
  functies: string[];
  aanbevolen: boolean;
}

export interface AuditPackage {
  id: string;
  product: 'audit';
  naam: string;
  kort: string;
  voorWie: string;
  prijsCenten: number;
  vanafPrijs: boolean;
  maxDomeinen: number;
  functies: string[];
  bestelbaar: boolean;
}

export interface Catalog {
  btwPercentage: number;
  proefDagen: number;
  plans: Plan[];
  auditPackages: AuditPackage[];
}

const DEFAULT_FILE = join(dirname(fileURLToPath(import.meta.url)), '../../../config/abonnementen.json');

function fail(msg: string): never {
  throw new Error(`config/abonnementen.json: ${msg}`);
}
function str(v: unknown, path: string): string {
  if (typeof v !== 'string' || !v.trim()) fail(`${path} moet tekst zijn`);
  return v;
}
function euros(v: unknown, path: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1_000_000) fail(`${path} moet een bedrag in euro's zijn`);
  return Math.round(v * 100);
}
function int(v: unknown, path: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) fail(`${path} moet een heel getal zijn`);
  return v;
}
function strings(v: unknown, path: string): string[] {
  if (!Array.isArray(v)) fail(`${path} moet een lijst zijn`);
  return v.map((x, i) => str(x, `${path}[${i}]`));
}

/** Leest en controleert de catalogus. Een fout in het bestand stopt het opstarten met een duidelijke melding. */
export function parseCatalog(raw: unknown): Catalog {
  const r = raw as Record<string, unknown>;
  if (!r || typeof r !== 'object') fail('geen geldig JSON-object');
  const btw = r.btwPercentage;
  if (typeof btw !== 'number' || btw < 0 || btw > 50) fail('btwPercentage ontbreekt of is ongeldig');
  const ids = new Set<string>();
  const uniq = (id: string) => {
    if (!/^[a-z0-9-]{2,40}$/.test(id)) fail(`id "${id}" mag alleen kleine letters, cijfers en - bevatten`);
    if (ids.has(id)) fail(`id "${id}" komt twee keer voor`);
    ids.add(id);
    return id;
  };
  const plans = (Array.isArray(r.abonnementen) ? r.abonnementen : fail('abonnementen ontbreekt')).map((x: any, i: number): Plan => {
    const p = `abonnementen[${i}]`;
    if (x.product !== 'mkb' && x.product !== 'corporate') fail(`${p}.product moet mkb of corporate zijn`);
    const l = x.limieten ?? fail(`${p}.limieten ontbreekt`);
    return {
      id: uniq(str(x.id, `${p}.id`)),
      product: x.product,
      naam: str(x.naam, `${p}.naam`),
      kort: str(x.kort, `${p}.kort`),
      voorWie: str(x.voorWie, `${p}.voorWie`),
      maandprijsCenten: { jaar: euros(x.perMaandBijJaar, `${p}.perMaandBijJaar`), maand: euros(x.perMaandBijMaand, `${p}.perMaandBijMaand`) },
      limieten: { domeinen: int(l.domeinen, `${p}.limieten.domeinen`), gebruikers: int(l.gebruikers, `${p}.limieten.gebruikers`), itPartners: int(l.itPartners, `${p}.limieten.itPartners`) },
      functies: strings(x.functies, `${p}.functies`),
      aanbevolen: x.aanbevolen === true,
    };
  });
  const auditPackages = (Array.isArray(r.auditPakketten) ? r.auditPakketten : []).map((x: any, i: number): AuditPackage => {
    const p = `auditPakketten[${i}]`;
    return {
      id: uniq(str(x.id, `${p}.id`)),
      product: 'audit',
      naam: str(x.naam, `${p}.naam`),
      kort: str(x.kort, `${p}.kort`),
      voorWie: str(x.voorWie, `${p}.voorWie`),
      prijsCenten: euros(x.prijs, `${p}.prijs`),
      vanafPrijs: x.vanafPrijs === true,
      maxDomeinen: int(x.maxDomeinen, `${p}.maxDomeinen`),
      functies: strings(x.functies, `${p}.functies`),
      bestelbaar: x.bestelbaar === true,
    };
  });
  if (plans.length === 0) fail('geen abonnementen');
  return { btwPercentage: btw, proefDagen: int(r.proefDagen ?? 14, 'proefDagen'), plans, auditPackages };
}

export function loadCatalog(file = process.env.QBICLE_ABONNEMENTEN_BESTAND || DEFAULT_FILE): Catalog {
  return parseCatalog(JSON.parse(readFileSync(file, 'utf8')));
}

export function findPlan(c: Catalog, id: string): Plan | undefined {
  return c.plans.find((p) => p.id === id);
}

export function findAuditPackage(c: Catalog, id: string): AuditPackage | undefined {
  return c.auditPackages.find((p) => p.id === id);
}

/** Bedrag per betaling (excl. btw): bij jaarbetaling 12 maanden vooruit. */
export function periodAmountCents(monthlyCents: number, interval: BillingInterval): number {
  return interval === 'jaar' ? monthlyCents * 12 : monthlyCents;
}

export function vatCents(c: Catalog, exclCents: number): number {
  return Math.round((exclCents * c.btwPercentage) / 100);
}

/** Voor de prijspagina: alles wat een bezoeker mag zien. */
export function publicCatalog(c: Catalog) {
  return {
    btwPercentage: c.btwPercentage,
    proefDagen: c.proefDagen,
    abonnementen: c.plans,
    auditPakketten: c.auditPackages,
  };
}
