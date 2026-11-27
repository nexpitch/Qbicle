import { hoofddomein, type VerwantBewijs, type VerwantDomein } from '@qbicle/scanner';
import { audit, type Actor } from './audit.ts';
import { planLimits } from './billing.ts';
import type { Platform } from './context.ts';
import { many } from './db.ts';
import { addDomain, type Domain } from './domains.ts';
import { PlatformError } from './errors.ts';
import { authorize } from './organizations.ts';

/**
 * Meerdere domeinen per klant: in één keer een lijst toevoegen, een teller
 * tegen de pakketlimiet en per domein wat we zien. Boven de limiet blokkeren
 * we niet: elk extra domein is een add-on (prijs in config/abonnementen.json,
 * keuze Erik 27-11). Het factureren van de add-on hoort bij billing.
 */

type UserActor = Actor & { userId: string };

export interface BulkDomainResult {
  invoer: string;
  status: 'toegevoegd' | 'bestaat_al' | 'ongeldig';
  domein?: string;
  bericht?: string;
}

/** Splitst geplakte tekst of een lijst in losse namen (komma's, spaties, regels). */
export function splitDomainList(input: string | string[]): string[] {
  const parts = (Array.isArray(input) ? input : [input]).flatMap((s) => String(s).split(/[\s,;]+/)).map((s) => s.trim()).filter(Boolean);
  return [...new Set(parts)].slice(0, 50);
}

export async function addDomains(p: Platform, actor: UserActor, organizationId: string, input: string | string[]): Promise<BulkDomainResult[]> {
  await authorize(p.pool, actor.userId, organizationId, 'domeinen:beheren');
  const names = splitDomainList(input);
  if (!names.length) throw new PlatformError('ongeldige_invoer', 'Vul minstens één domein in.');
  const out: BulkDomainResult[] = [];
  for (const invoer of names) {
    try {
      const d = await addDomain(p, actor, organizationId, { name: invoer });
      out.push({ invoer, status: 'toegevoegd', domein: d.name });
    } catch (err) {
      if (!(err instanceof PlatformError)) throw err;
      if (err.code === 'conflict') out.push({ invoer, status: 'bestaat_al', bericht: err.message });
      else if (err.code === 'ongeldige_invoer') out.push({ invoer, status: 'ongeldig', bericht: err.message });
      else throw err;
    }
  }
  return out;
}

export interface DomainSummary {
  domainId: string;
  assets: number;
  openFindings: number;
  lastScanAt: Date | null;
}

export interface DomainOverview {
  limiet: number;
  plan: string | null;
  /** Extra domeinen boven de limiet en hun prijs per maand (add-on). */
  extra: number;
  extraDomeinCenten: number;
  gebruikt: number;
  summaries: Map<string, DomainSummary>;
  /** Andere domeinen die aantoonbaar bij de klant horen en nog niet in de lijst staan. */
  suggesties: DomeinSuggestie[];
}

export interface DomeinSuggestie {
  domein: string;
  /** Waarom we denken dat het van de klant is, in gewone taal. */
  redenen: string[];
  /** Wat er draait: "Er draait een website" of "Er is een mailserver ingesteld". */
  dienst: string;
}

const MAX_SUGGESTIES = 10;

export function bewijsTekst(b: VerwantBewijs, domein: string): string {
  switch (b.soort) {
    case 'certificaat':
      return `Staat op hetzelfde beveiligingscertificaat als ${b.via}.`;
    case 'doorverwijzing':
      return `${b.via} verwijst bezoekers door naar ${domein}.`;
    case 'verwijst-terug':
      return `${b.via} verwijst door naar jullie website.`;
  }
}

/**
 * Suggesties uit wat de scanner bij bevestigde domeinen vond (zie
 * @qbicle/scanner verwant.ts voor het bewijs). Hier vallen nog af: alles met
 * hetzelfde hoofddomein als een domein dat al in de lijst staat (ook
 * www.x.nl tegenover x.nl), wat de klant eerder afwees, en dubbelen.
 */
export function kiesSuggesties(
  domains: Pick<Domain, 'name' | 'verified'>[],
  gevonden: { bronDomein: string; verwant: VerwantDomein[] }[],
  afgewezen: Iterable<string>,
): DomeinSuggestie[] {
  const bekend = new Set(domains.map((d) => hoofddomein(d.name) ?? d.name));
  const bevestigd = new Set(domains.filter((d) => d.verified).map((d) => d.name));
  const nee = new Set([...afgewezen].map((d) => d.toLowerCase()));
  const per = new Map<string, { redenen: Set<string>; website: boolean }>();
  for (const g of gevonden) {
    if (!bevestigd.has(g.bronDomein)) continue;
    for (const v of g.verwant) {
      const d = hoofddomein(v.domein);
      if (!d || bekend.has(d) || nee.has(d) || !v.bewijs?.length) continue;
      const s = per.get(d) ?? { redenen: new Set<string>(), website: false };
      for (const b of v.bewijs) s.redenen.add(bewijsTekst(b, d));
      s.website ||= v.dienst === 'website';
      per.set(d, s);
    }
  }
  return [...per.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(0, MAX_SUGGESTIES)
    .map(([domein, s]) => ({
      domein,
      redenen: [...s.redenen],
      dienst: s.website ? 'Er draait een website.' : 'Er is een mailserver ingesteld.',
    }));
}

/** "Niet van ons": niet meer voorstellen. */
export async function wijsSuggestieAf(p: Platform, actor: UserActor, organizationId: string, domein: string): Promise<void> {
  await authorize(p.pool, actor.userId, organizationId, 'domeinen:beheren');
  const d = hoofddomein(domein);
  if (!d) throw new PlatformError('ongeldige_invoer', 'Dit lijkt geen geldige domeinnaam.');
  await p.pool.query(
    `INSERT INTO domein_suggestie_afgewezen (organization_id, domein, afgewezen_door) VALUES ($1, $2, $3)
     ON CONFLICT (organization_id, domein) DO NOTHING`,
    [organizationId, d, actor.userId],
  );
  await audit(p.pool, actor, { organizationId, action: 'domein.suggestie_afgewezen', detail: { domein: d } });
}

/** Het hoofddomein volgens de Public Suffix List (www.x.nl → x.nl, shop.x.co.uk → x.co.uk). */
export function registrableDomain(host: string): string | null {
  return hoofddomein(host);
}

export async function domainOverview(p: Platform, userId: string, organizationId: string, domains: Domain[]): Promise<DomainOverview> {
  await authorize(p.pool, userId, organizationId, 'domeinen:lezen');
  const limits = await planLimits(p, organizationId);
  const rows = await many<{ domain_id: string; assets: number; open_findings: number; last_scan_at: Date | null }>(
    p.pool,
    `SELECT d.id AS domain_id,
            (SELECT count(*)::int FROM asset a WHERE a.domain_id = d.id AND a.status = 'actief') AS assets,
            (SELECT count(*)::int FROM finding f JOIN asset a ON a.id = f.asset_id
              WHERE a.domain_id = d.id AND f.resolved_at IS NULL AND f.accepted_at IS NULL) AS open_findings,
            (SELECT max(s.finished_at) FROM scan s WHERE s.domain_id = d.id AND s.status = 'klaar') AS last_scan_at
       FROM domain d WHERE d.organization_id = $1`,
    [organizationId],
  );
  const summaries = new Map(rows.map((r) => [r.domain_id, { domainId: r.domain_id, assets: r.assets, openFindings: r.open_findings, lastScanAt: r.last_scan_at }]));

  // Suggesties: alleen wat de scanner met bewijs vond bij een bevestigd domein.
  const gevonden = await many<{ bron: string; value: VerwantDomein[] }>(
    p.pool,
    `SELECT d.name AS bron, aa.value FROM asset_attribute aa
       JOIN asset a ON a.id = aa.asset_id AND a.type = 'domein'
       JOIN domain d ON d.id = a.domain_id
      WHERE a.organization_id = $1 AND aa.key = 'domein.verwant'`,
    [organizationId],
  );
  const afgewezen = await many<{ domein: string }>(p.pool, 'SELECT domein FROM domein_suggestie_afgewezen WHERE organization_id = $1', [organizationId]);
  const suggesties = kiesSuggesties(
    domains,
    gevonden.map((g) => ({ bronDomein: g.bron, verwant: Array.isArray(g.value) ? g.value : [] })),
    afgewezen.map((a) => a.domein),
  );
  return { limiet: limits.domeinen, plan: limits.plan, extra: Math.max(0, domains.length - limits.domeinen), extraDomeinCenten: p.catalog.extraDomeinCenten, gebruikt: domains.length, summaries, suggesties };
}
