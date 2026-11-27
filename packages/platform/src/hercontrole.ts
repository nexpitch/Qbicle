import { ACTIONS, WEIGHTS } from '@qbicle/score';
import { audit, type Actor } from './audit.ts';
import type { Platform } from './context.ts';
import { many, one } from './db.ts';
import { DEMO_DOMAIN } from './demo.ts';
import { describeDnsHost, systemHostLookup, type HostLookup } from './dnshost.ts';
import { instructionsFor } from './domains.ts';
import { notFound, PlatformError } from './errors.ts';
import { authorize, isUuid } from './organizations.ts';
import { kanHercontroleren, oplosGids, type OplosContext, type OplosGids } from './oplossen.ts';
import { hit, LIMITS } from './ratelimit.ts';

/**
 * "Ik heb het gedaan, controleer nu": een hercontrole van één bevinding.
 *
 * Dat is een gewone scan in de wachtrij, maar met alleen de check van die
 * bevinding (scan.check_keys). De worker slaat het resultaat op dezelfde manier
 * op, dus een bevinding is pas opgelost als de check echt draaide en hem niet
 * meer zag. Een hercontrole telt niet als volledige scan: geen nieuwe score, geen
 * invloed op de wekelijkse planning of de afkoeltijd van "Scan nu starten".
 */

type UserActor = Actor & { userId: string };

/** Minimaal zoveel seconden tussen twee hercontroles van dezelfde bevinding. */
export const HERCONTROLE_AFKOEL_SECONDEN = 60;
/** Zo lang tonen we de uitkomst van een hercontrole op de assetpagina. */
const TOON_MINUTEN = 120;

export interface HercontroleView {
  scanId: string;
  findingId: string | null;
  status: 'wachtrij' | 'bezig' | 'klaar' | 'mislukt';
  /** Alleen bij status klaar of mislukt. */
  uitkomst: 'opgelost' | 'nog-open' | 'onbekend' | null;
  tekst: string;
  at: Date;
}

/** Domeinchecks hangen af van DNSSEC: is die kapot, dan zijn hun antwoorden niet te vertrouwen. */
function checksVoor(checkKey: string): string[] {
  return checkKey.startsWith('mail.') || checkKey.startsWith('dns.') ? [...new Set([checkKey, 'dns.dnssec'])] : [checkKey];
}

export async function requestRecheck(p: Platform, actor: UserActor, organizationId: string, findingId: string): Promise<HercontroleView> {
  await authorize(p.pool, actor.userId, organizationId, 'scans:starten');
  if (!isUuid(findingId)) throw notFound('Deze bevinding');
  const f = await one<{
    id: string;
    check_key: string;
    title: string;
    resolved_at: Date | null;
    domain_id: string | null;
    domain_name: string | null;
    verified_at: Date | null;
    opted_out: boolean;
  }>(
    p.pool,
    `SELECT f.id, f.check_key, f.title, f.resolved_at, d.id AS domain_id, d.name AS domain_name, d.verified_at,
            EXISTS (SELECT 1 FROM scan_opt_out o WHERE o.name = d.name) AS opted_out
       FROM finding f JOIN asset a ON a.id = f.asset_id LEFT JOIN domain d ON d.id = a.domain_id
      WHERE f.id = $1 AND a.organization_id = $2`,
    [findingId, organizationId],
  );
  if (!f) throw notFound('Deze bevinding');
  if (f.resolved_at) throw new PlatformError('conflict', 'Deze bevinding is al opgelost.');
  if (!f.domain_id || !kanHercontroleren(f.check_key)) {
    throw new PlatformError('ongeldige_invoer', 'Dit kunnen we niet los controleren. Het wordt meegenomen in de volgende scan.');
  }
  if (!f.verified_at) throw new PlatformError('niet_geverifieerd', 'Bevestig eerst dat dit domein van jullie is.');
  if (f.opted_out) throw new PlatformError('conflict', 'Voor dit domein is gevraagd het niet te scannen.');

  // Loopt er al een scan van dit domein, dan neemt die deze bevinding ook mee (of het is dezelfde hercontrole).
  const running = await one<{ id: string; status: HercontroleView['status']; created_at: Date; finding_id: string | null; check_keys: string[] | null }>(
    p.pool,
    "SELECT id, status, created_at, finding_id, check_keys FROM scan WHERE domain_id = $1 AND status IN ('wachtrij', 'bezig') ORDER BY created_at LIMIT 1",
    [f.domain_id],
  );
  if (running && (!running.check_keys || running.check_keys.includes(f.check_key))) {
    return { scanId: running.id, findingId: f.id, status: running.status, uitkomst: null, tekst: tekstVoor(running.status, null), at: running.created_at };
  }
  const recent = await one<{ wacht: number }>(
    p.pool,
    `SELECT ceil(extract(epoch FROM max(created_at) + make_interval(secs => $2) - now()))::int AS wacht
       FROM scan WHERE finding_id = $1 HAVING max(created_at) > now() - make_interval(secs => $2)`,
    [f.id, HERCONTROLE_AFKOEL_SECONDEN],
  );
  if (recent) {
    throw new PlatformError('te_veel_verzoeken', `We hebben dit net gecontroleerd. Over ${Math.max(1, recent.wacht)} seconden kun je het opnieuw laten controleren.`);
  }
  await hit(p.pool, LIMITS.hercontrolePerDomein, f.domain_id);
  const s = await one<{ id: string; status: HercontroleView['status']; created_at: Date }>(
    p.pool,
    `INSERT INTO scan (domain_id, trigger, max_level, requested_by, check_keys, finding_id)
     VALUES ($1, 'handmatig', 1, $2, $3, $4) RETURNING id, status, created_at`,
    [f.domain_id, actor.userId, checksVoor(f.check_key), f.id],
  );
  await audit(p.pool, actor, {
    organizationId,
    action: 'scan.hercontrole',
    subject: s!.id,
    detail: { domein: f.domain_name, bevinding: f.title.slice(0, 200) },
  });
  return { scanId: s!.id, findingId: f.id, status: s!.status, uitkomst: null, tekst: tekstVoor(s!.status, null), at: s!.created_at };
}

function tekstVoor(status: HercontroleView['status'], uitkomst: HercontroleView['uitkomst']): string {
  if (status === 'wachtrij') return 'De controle staat klaar en begint zo.';
  if (status === 'bezig') return 'We controleren het nu. Dit duurt meestal een paar seconden.';
  if (status === 'mislukt') return 'De controle is niet gelukt door een storing. Probeer het over een paar minuten opnieuw.';
  if (uitkomst === 'opgelost') return 'Opgelost. Goed gedaan!';
  if (uitkomst === 'nog-open')
    return 'We zien het nog niet. Een DNS-wijziging kan tot een uur duren voordat hij overal zichtbaar is. Controleer of je hem hebt opgeslagen en probeer het later nog eens.';
  return 'We konden het nu niet controleren. Dat zegt niets over of het goed staat; probeer het later nog eens.';
}

interface ScanRow {
  id: string;
  finding_id: string | null;
  status: HercontroleView['status'];
  created_at: Date;
  resolved: boolean;
  outcome: string | null;
}

function toView(r: ScanRow): HercontroleView {
  const uitkomst: HercontroleView['uitkomst'] =
    r.status === 'klaar' ? (r.resolved ? 'opgelost' : r.outcome === 'ok' || r.outcome === 'finding' ? 'nog-open' : 'onbekend') : r.status === 'mislukt' ? 'onbekend' : null;
  return { scanId: r.id, findingId: r.finding_id, status: r.status, uitkomst, tekst: tekstVoor(r.status, uitkomst), at: r.created_at };
}

const scanViewSql = (distinct = '') => `
  SELECT ${distinct} s.id, s.finding_id, s.status, s.created_at,
         (f.resolved_scan_id = s.id) AS resolved,
         (SELECT c.outcome FROM check_run c WHERE c.scan_id = s.id AND c.asset_id = f.asset_id AND c.check_key = f.check_key LIMIT 1) AS outcome
    FROM scan s JOIN finding f ON f.id = s.finding_id JOIN asset a ON a.id = f.asset_id`;

/** Stand van één hercontrole (de assetpagina vraagt dit elke paar seconden op). */
export async function getRecheck(p: Platform, userId: string, organizationId: string, scanId: string): Promise<HercontroleView> {
  await authorize(p.pool, userId, organizationId, 'bevindingen:lezen');
  if (!isUuid(scanId)) throw notFound('Deze controle');
  const r = await one<ScanRow>(p.pool, `${scanViewSql()} WHERE s.id = $1 AND a.organization_id = $2`, [scanId, organizationId]);
  if (!r) throw notFound('Deze controle');
  return toView(r);
}

// Op de assetpagina ----------------------------------------------------------------------------

export interface FindingOplossing {
  gids: OplosGids | null;
  /** Kan de klant hier "Ik heb het gedaan, controleer nu" gebruiken? */
  kanHercontrole: boolean;
  /** De laatste hercontrole van deze bevinding, als die recent was. */
  hercontrole: HercontroleView | null;
}

export interface AssetOplossingen {
  perBevinding: Map<string, FindingOplossing>;
  /** Bevindingen die net door een hercontrole zijn opgelost (voor de melding bovenaan). */
  netOpgelost: { title: string; at: Date }[];
  dnsBeheer: string | null;
  /** Domein van het asset, voor de link "Waar staat mijn domein?". */
  domainId: string | null;
}

type DnsCtx = Pick<OplosContext, 'zone' | 'dns' | 'mail'>;
const dnsCache = new Map<string, { at: number; ctx: DnsCtx }>();
const CACHE_MS = 10 * 60 * 1000;
let defaultLookup: HostLookup | undefined;

/** Waar staat de DNS en de mail? Kort bewaard, zodat de assetpagina niet bij elke klik opnieuw opzoekt. */
async function dnsContext(p: Platform & { hostLookup?: HostLookup }, domain: string): Promise<DnsCtx> {
  const hit = dnsCache.get(domain);
  if (hit && Date.now() - hit.at < CACHE_MS && !p.hostLookup) return hit.ctx;
  const lookup = p.hostLookup ?? (defaultLookup ??= systemHostLookup());
  let ctx: DnsCtx = { zone: null, dns: null, mail: null };
  try {
    const r = await describeDnsHost(domain, lookup, instructionsFor(domain, ''));
    const dp = r.dnsBeheer.provider;
    ctx = {
      zone: r.zone,
      dns: dp && r.dnsBeheer.zekerheid === 'waarschijnlijk' ? { id: dp.id, naam: dp.naam, inlog: dp.inlog, stappen: dp.stappen } : null,
      mail: r.mail.provider ? { id: r.mail.provider.id, naam: r.mail.provider.naam } : null,
    };
  } catch {
    // Zonder opzoeking geven we de algemene uitleg.
  }
  if (!p.hostLookup) dnsCache.set(domain, { at: Date.now(), ctx });
  return ctx;
}

function assetNaam(type: string, value: string): string {
  if (type === 'website') return value.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return value;
}

export async function getAssetOplossingen(
  p: Platform & { hostLookup?: HostLookup },
  userId: string,
  organizationId: string,
  assetId: string,
): Promise<AssetOplossingen> {
  await authorize(p.pool, userId, organizationId, 'bevindingen:lezen');
  if (!isUuid(assetId)) throw notFound('Dit asset');
  const a = await one<{ type: string; value: string; domain_id: string | null; domain_name: string | null; verified: boolean }>(
    p.pool,
    `SELECT a.type, a.value, d.id AS domain_id, d.name AS domain_name, (d.verified_at IS NOT NULL) AS verified
       FROM asset a LEFT JOIN domain d ON d.id = a.domain_id WHERE a.id = $1 AND a.organization_id = $2`,
    [assetId, organizationId],
  );
  if (!a) throw notFound('Dit asset');
  const findings = await many<{ id: string; finding_key: string; check_key: string; title: string; resolved_at: Date | null; accepted_at: Date | null }>(
    p.pool,
    'SELECT id, finding_key, check_key, title, resolved_at, accepted_at FROM finding WHERE asset_id = $1 ORDER BY first_seen DESC LIMIT 200',
    [assetId],
  );
  const open = findings.filter((f) => !f.resolved_at && !f.accepted_at);
  const dns: DnsCtx = a.domain_name && open.length ? await dnsContext(p, a.domain_name) : { zone: null, dns: null, mail: null };
  const naam = assetNaam(a.type, a.value);

  const scans = findings.length
    ? await many<ScanRow>(
        p.pool,
        `${scanViewSql('DISTINCT ON (s.finding_id)')}
          WHERE s.finding_id = ANY($1::uuid[]) AND s.created_at > now() - make_interval(mins => $2)
          ORDER BY s.finding_id, s.created_at DESC`,
        [findings.map((f) => f.id), TOON_MINUTEN],
      )
    : [];
  const laatste = new Map(scans.map((s) => [s.finding_id!, toView(s)]));

  const perBevinding = new Map<string, FindingOplossing>();
  for (const f of open) {
    const actionKey = WEIGHTS[f.finding_key]?.action;
    const def = actionKey ? ACTIONS[actionKey] : undefined;
    const gids = actionKey && def ? oplosGids(f.finding_key, actionKey, { naam, ...dns, titel: def.title }) : null;
    perBevinding.set(f.id, {
      gids,
      kanHercontrole: Boolean(a.domain_name && a.domain_name !== DEMO_DOMAIN && a.verified && kanHercontroleren(f.check_key)),
      hercontrole: laatste.get(f.id) ?? null,
    });
  }
  const netOpgelost = findings
    .filter((f) => f.resolved_at && laatste.get(f.id)?.uitkomst === 'opgelost')
    .map((f) => ({ title: f.title, at: f.resolved_at! }));
  return { perBevinding, netOpgelost, dnsBeheer: dns.dns?.naam ?? null, domainId: a.domain_id };
}

