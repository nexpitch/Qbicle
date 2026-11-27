import type { Actor } from './audit.ts';
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
  /** Domeinen die we bij de assets zien maar nog niet in de lijst staan. */
  suggesties: string[];
}

/** Laatste twee labels, of drie bij bekende tweedelige achtervoegsels (co.uk). */
export function registrableDomain(host: string): string | null {
  const h = host.toLowerCase().replace(/^https?:\/\//, '').split(/[/:?#]/)[0]!.replace(/\.$/, '');
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(h)) return null;
  const labels = h.split('.');
  const twoPart = /^(co|com|org|net|gov|ac)\.[a-z]{2}$/.test(labels.slice(-2).join('.'));
  const n = twoPart ? 3 : 2;
  return labels.length >= n ? labels.slice(-n).join('.') : null;
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
            (SELECT max(s.finished_at) FROM scan s WHERE s.domain_id = d.id AND s.status = 'klaar' AND s.check_keys IS NULL) AS last_scan_at
       FROM domain d WHERE d.organization_id = $1`,
    [organizationId],
  );
  const summaries = new Map(rows.map((r) => [r.domain_id, { domainId: r.domain_id, assets: r.assets, openFindings: r.open_findings, lastScanAt: r.last_scan_at }]));

  // Suggesties: domeinen die in assets voorkomen (websites, mail, certificaten) maar niet als domein bestaan.
  const known = new Set(domains.map((d) => d.name));
  const values = await many<{ value: string }>(
    p.pool,
    `SELECT DISTINCT value FROM asset WHERE organization_id = $1 AND status = 'actief'
        AND type IN ('domein', 'subdomein', 'website', 'certificaat', 'host')`,
    [organizationId],
  );
  const suggesties = new Set<string>();
  for (const { value } of values) {
    const r = registrableDomain(value);
    if (r && !known.has(r) && ![...known].some((k) => r.endsWith(`.${k}`))) suggesties.add(r);
  }
  return { limiet: limits.domeinen, plan: limits.plan, extra: Math.max(0, domains.length - limits.domeinen), extraDomeinCenten: p.catalog.extraDomeinCenten, gebruikt: domains.length, summaries, suggesties: [...suggesties].sort().slice(0, 10) };
}
