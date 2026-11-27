import type { LinkedVuln, Source } from '@qbicle/score';
import { buildCpe, compareVersions, type VulnDb } from '@qbicle/devices';
import type { HttpResponse } from './net.ts';
import { CONDITIONAL, PRODUCTS, productByKey, type EolCycleDef, type ProductDef } from './kennis/software.ts';
import { cyclesFor, eolSnapshot, eolSource, newestOverall, type EolCycle } from './kennis/eol.ts';
import { detectStack, type Categorie, type StackHit, type Zekerheid } from './stack.ts';

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
  categorie: Categorie;
  productZekerheid: Zekerheid;
  /** "verborgen" als de website geen versie laat zien (version is dan leeg). */
  versieZekerheid: Zekerheid | 'verborgen';
  /** Bron in gewone taal, voor de klant. */
  bronUitleg: string;
}

const HEADER_UITLEG: Record<string, string> = {
  'header:server': 'Server-header',
  'header:x-powered-by': 'X-Powered-By-header',
  'header:x-aspnet-version': 'X-AspNet-Version-header',
  'header:x-generator': 'X-Generator-header',
  'html:meta-generator': 'generator-tag in de pagina',
};

const CATEGORIE_VAN: Record<string, Categorie> = {
  php: 'taal',
  aspnet: 'taal',
  openssl: 'tls-bibliotheek',
  wordpress: 'cms',
  drupal: 'cms',
  joomla: 'cms',
  typo3: 'cms',
};

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
  const product = PRODUCTS.find((p) => p.match.test(rawProduct)) ?? null;
  return {
    rawProduct,
    rawVersion,
    version: normalizeVersion(rawVersion),
    source,
    backportDistro: distro,
    product,
    categorie: (product && CATEGORIE_VAN[product.key]) ?? 'webserver',
    productZekerheid: 'zeker',
    versieZekerheid: 'zeker',
    bronUitleg: HEADER_UITLEG[source] ?? source,
  };
}

function fromStack(hit: StackHit): DetectedSoftware {
  return {
    rawProduct: hit.naam,
    rawVersion: hit.versie,
    version: hit.versie,
    source: `stack:${hit.key}`,
    backportDistro: null,
    product: productByKey(hit.key) ?? null,
    categorie: hit.categorie,
    productZekerheid: hit.productZekerheid,
    versieZekerheid: hit.versieZekerheid,
    bronUitleg: hit.bron,
  };
}

/**
 * Alles wat we van de software zien: versies uit headers en generator-tag (detectSoftware)
 * plus CMS, plug-ins, bibliotheken en besturingssysteem uit de pagina (detectStack).
 * Per product blijft de beste waarneming over: met versie boven zonder, zeker boven waarschijnlijk.
 */
export function detectAll(res: HttpResponse): DetectedSoftware[] {
  const header = detectSoftware(res);
  const stack = detectStack(res).map(fromStack);
  const rank = (s: DetectedSoftware) =>
    (s.version ? 4 : 0) + (s.versieZekerheid === 'zeker' ? 2 : 0) + (s.productZekerheid === 'zeker' ? 1 : 0);
  const best = new Map<string, DetectedSoftware>();
  for (const s of [...header, ...stack]) {
    const k = s.product?.key ? `${s.categorie === 'besturingssysteem' ? 'os:' : ''}${s.product.key}` : `${s.categorie}:${s.rawProduct.toLowerCase()}`;
    const cur = best.get(k);
    if (!cur || rank(s) > rank(cur)) best.set(k, s);
  }
  // Red Hat-achtige distributies (RHEL, CentOS, Rocky, Alma) zetten geen distributietekst in het
  // PHP-versienummer ("PHP/7.2.24"), Ubuntu en Debian wel ("7.4.3-4ubuntu2.18"). Meldt de server
  // Red Hat, dan geldt dat dus ook voor PHP en OpenSSL zonder eigen tekst. Bij Ubuntu/Debian
  // betekent een kaal versienummer juist dat het geen distributiepakket is.
  const redHat = header.some((h) => h.backportDistro === 'Red Hat-achtige Linux');
  return [...best.values()].map((s) =>
    redHat && !s.backportDistro && s.version && s.product?.wie === 'hosting' && s.source.startsWith('header:')
      ? { ...s, backportDistro: 'Red Hat-achtige Linux' }
      : s,
  );
}

/** Reeksen voor een product: snapshot van endoflife.date als die er is, anders de handmatige startset. */
export function productCycles(p: ProductDef): { cycles: EolCycle[] | EolCycleDef[]; fromSnapshot: boolean } | null {
  const snap = p.eolSlug ? eolSnapshot()?.producten[p.eolSlug] : undefined;
  if (snap?.length) return { cycles: snap, fromSnapshot: true };
  return p.cycles ? { cycles: p.cycles, fromSnapshot: false } : null;
}

export function eolSourcesFor(p: ProductDef) {
  const own = p.eolSources ?? [];
  if (!p.eolSlug || own.some((s) => s.name === 'endoflife.date')) return own.length ? own : p.eolSlug ? [eolSource(p.eolSlug)] : [];
  return [...own, eolSource(p.eolSlug)];
}

export interface EolAssessment {
  status: 'einde' | 'binnenkort' | 'ondersteund';
  cycle: string;
  date?: string;
}

const SOON_DAYS = 90;

function statusOf(eol: string | boolean, now: Date): { status: EolAssessment['status']; date?: string } {
  if (eol === true) return { status: 'einde' };
  if (eol === false) return { status: 'ondersteund' };
  const t = Date.parse(eol);
  if (Number.isNaN(t)) return { status: 'ondersteund' };
  if (t < now.getTime()) return { status: 'einde', date: eol };
  if (t - now.getTime() < SOON_DAYS * 86400_000) return { status: 'binnenkort', date: eol };
  return { status: 'ondersteund', date: eol };
}

export function assessEol(sw: DetectedSoftware, now: Date): EolAssessment | null {
  const p = sw.product;
  if (!p || !sw.version) return null;
  const src = productCycles(p);
  if (!src) return null;
  if (!src.fromSnapshot && p.cycleOf) {
    for (const c of p.cycleOf(sw.version)) {
      const hit = src.cycles.find((x) => compareVersions(x.cycle, c) === 0 && x.cycle.split('.').length === c.split('.').length);
      if (hit) return { cycle: hit.cycle, ...statusOf(hit.eol, now) };
    }
    return null;
  }
  const hits = cyclesFor(src.cycles as EolCycle[], sw.version);
  if (hits.length === 0) return null;
  if (hits.length === 1) return { cycle: hits[0]!.cycle, ...statusOf(hits[0]!.eol, now) };
  // Alleen de hoofdversie bekend (Joomla 3, Drupal 7): einde als alle reeksen voorbij zijn.
  const st = hits.map((h) => statusOf(h.eol, now));
  const cycle = sw.version.split('.')[0]!;
  const last = st.map((x) => x.date).filter((d): d is string => !!d).sort().pop();
  if (st.every((x) => x.status === 'einde')) return { status: 'einde', cycle, ...(last ? { date: last } : {}) };
  // De laatste reeks van deze hoofdversie bepaalt wanneer de hele hoofdversie stopt (Drupal 10 -> 10.6).
  if (st.some((x) => x.status === 'ondersteund' && !x.date)) return { status: 'ondersteund', cycle };
  return { cycle, ...statusOf(last ?? false, now) };
}

export type UpdateStatus = 'einde' | 'binnenkort' | 'achter' | 'nieuwere-reeks' | 'actueel' | 'onbekend' | 'beheerd';

export interface Beoordeling {
  status: UpdateStatus;
  eol: EolAssessment | null;
  /** Nieuwste versie in dezelfde reeks (de beveiligingsupdates die er al zijn). */
  laatsteInReeks?: string;
  /** Nieuwste versie van het product. */
  nieuwste?: string;
}

/** Einde ondersteuning plus: mist deze versie updates die er al zijn? */
export function beoordeel(sw: DetectedSoftware, now: Date): Beoordeling {
  const p = sw.product;
  if (p?.wie === 'leverancier') return { status: 'beheerd', eol: null };
  if (!p || !sw.version) return { status: 'onbekend', eol: null };
  const eol = assessEol(sw, now);
  const src = productCycles(p);
  const snapCycles = src?.fromSnapshot ? (src.cycles as EolCycle[]) : [];
  const inCycle = eol ? snapCycles.find((c) => c.cycle === eol.cycle) : undefined;
  const nieuwste = newestOverall(snapCycles);
  const exact = sw.version.split('.').length >= 3 || /[a-z]$/i.test(sw.version);
  const laatsteInReeks = inCycle?.latest && /^\d/.test(inCycle.latest) ? inCycle.latest : undefined;
  const base = { eol, ...(laatsteInReeks ? { laatsteInReeks } : {}), ...(nieuwste ? { nieuwste } : {}) };
  if (eol?.status === 'einde') return { status: 'einde', ...base };
  if (eol?.status === 'binnenkort') return { status: 'binnenkort', ...base };
  if (!eol) return { status: 'onbekend', ...base };
  // Alleen met een volledig versienummer kunnen we zeggen dat er updates ontbreken.
  if (exact && laatsteInReeks && compareVersions(sw.version, laatsteInReeks) < 0) return { status: 'achter', ...base };
  if (nieuwste && compareVersions(sw.version, nieuwste) < 0 && compareVersions(eol.cycle, nieuwste) < 0 && !nieuwste.startsWith(`${eol.cycle}.`)) {
    return { status: 'nieuwere-reeks', ...base };
  }
  return { status: 'actueel', ...base };
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
  if (!cpe || !sw.version) return [];
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
