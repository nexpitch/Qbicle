import { Resolver } from 'node:dns/promises';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Platform } from './context.ts';
import { one } from './db.ts';
import { notFound } from './errors.ts';
import { authorize, isUuid } from './organizations.ts';
import { instructionsFor, type VerificationInstructions } from './domains.ts';

/**
 * "Waar staat mijn domein?" Kleine bedrijven weten vaak niet waar hun DNS wordt
 * beheerd. We zoeken het uit met alleen passieve, openbare opzoekingen:
 * - naamservers (NS): wie de DNS beheert, de sterkste aanwijzing;
 * - RDAP (opvolger van WHOIS): via welke registrar de domeinnaam loopt;
 * - mailservers (MX): waar de mail loopt.
 * De partijen staan in config/dns-providers.json en zijn uit te breiden.
 */

export interface DnsProvider {
  id: string;
  naam: string;
  ns: string[];
  registrar: string[];
  mx?: string[];
  inlog: string;
  stappen: string[];
}

export interface HostLookup {
  resolveNs(name: string): Promise<string[]>;
  resolveMx(name: string): Promise<string[]>;
  /** Naam van de registrar via RDAP, of null als die niet te vinden is. */
  registrar(domain: string): Promise<string | null>;
}

export type Zekerheid = 'waarschijnlijk' | 'mogelijk' | 'onbekend';

export interface DnsHostResult {
  domain: string;
  /** Domein waarop de naamservers gevonden zijn (bij een subdomein het bovenliggende). */
  zone: string | null;
  nameservers: string[];
  dnsBeheer: { provider: DnsProvider | null; naam: string | null; zekerheid: Zekerheid; reden: string };
  registrar: { naam: string | null; provider: DnsProvider | null };
  mail: { provider: DnsProvider | null; servers: string[] };
  instructions: VerificationInstructions;
}

const here = dirname(fileURLToPath(import.meta.url));

export function loadDnsProviders(path = process.env.QBICLE_DNS_PROVIDERS_BESTAND ?? join(here, '../../../config/dns-providers.json')): DnsProvider[] {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as { providers?: unknown };
  if (!Array.isArray(raw.providers)) throw new Error('dns-providers.json: "providers" ontbreekt');
  return raw.providers.map((p: Record<string, unknown>, i) => {
    const list = (k: string) => (Array.isArray(p[k]) ? (p[k] as unknown[]).map((x) => String(x).toLowerCase()) : []);
    if (typeof p.id !== 'string' || typeof p.naam !== 'string' || typeof p.inlog !== 'string' || !/^https:\/\//.test(p.inlog)) {
      throw new Error(`dns-providers.json: partij ${i + 1} mist id, naam of een https-inloglink`);
    }
    return { id: p.id, naam: p.naam, ns: list('ns'), registrar: list('registrar'), mx: list('mx'), inlog: p.inlog, stappen: Array.isArray(p.stappen) ? p.stappen.map(String) : [] };
  });
}

let cached: DnsProvider[] | undefined;
function providers(): DnsProvider[] {
  return (cached ??= loadDnsProviders());
}

/** host eindigt op het achtervoegsel; een achtervoegsel dat op "-" eindigt mag ook midden in de naam staan (awsdns-12.com). */
function hostMatches(host: string, suffix: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (suffix.endsWith('-')) return h.includes(`.${suffix}`) || h.startsWith(suffix);
  return h === suffix || h.endsWith(`.${suffix}`);
}

export function providerForHosts(hosts: string[], kind: 'ns' | 'mx', list = providers()): DnsProvider | null {
  // De partij die de meeste servers dekt wint; bij gelijkspel de eerste in de lijst.
  let best: DnsProvider | null = null;
  let bestCount = 0;
  for (const p of list) {
    const patterns = kind === 'ns' ? p.ns : (p.mx ?? []);
    const count = hosts.filter((h) => patterns.some((s) => hostMatches(h, s))).length;
    if (count > bestCount) [best, bestCount] = [p, count];
  }
  return best;
}

export function providerForRegistrar(name: string | null, list = providers()): DnsProvider | null {
  if (!name) return null;
  const n = name.toLowerCase();
  return list.find((p) => p.registrar.some((r) => n.includes(r))) ?? null;
}

/** Echte opzoekingen, met korte time-outs. Fouten geven een leeg antwoord, nooit een crash. */
export function systemHostLookup(): HostLookup {
  const r = new Resolver({ timeout: 4000, tries: 2 });
  const quiet = async <T>(f: () => Promise<T>, empty: T): Promise<T> => {
    try {
      return await f();
    } catch {
      return empty;
    }
  };
  return {
    resolveNs: (name) => quiet(() => r.resolveNs(name), []),
    resolveMx: (name) => quiet(async () => (await r.resolveMx(name)).sort((a, b) => a.priority - b.priority).map((m) => m.exchange), []),
    registrar: (domain) =>
      quiet(async () => {
        const res = await fetch(`https://rdap.org/domain/${encodeURIComponent(domain)}`, {
          headers: { accept: 'application/rdap+json' },
          redirect: 'follow',
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) return null;
        return registrarFromRdap(await res.json());
      }, null),
  };
}

/** Haalt de naam van de registrar uit een RDAP-antwoord (entity met rol "registrar", vCard "fn"). */
export function registrarFromRdap(json: unknown): string | null {
  const entities = (json as { entities?: unknown[] })?.entities;
  if (!Array.isArray(entities)) return null;
  for (const e of entities as { roles?: string[]; vcardArray?: unknown[] }[]) {
    if (!e.roles?.includes('registrar')) continue;
    const props = Array.isArray(e.vcardArray?.[1]) ? (e.vcardArray![1] as unknown[][]) : [];
    const fn = props.find((p) => p[0] === 'fn');
    if (fn && typeof fn[3] === 'string' && fn[3].trim()) return fn[3].trim().slice(0, 200);
  }
  return null;
}

let defaultLookup: HostLookup | undefined;

export async function findDnsHost(p: Platform & { hostLookup?: HostLookup }, userId: string, organizationId: string, domainId: string): Promise<DnsHostResult> {
  await authorize(p.pool, userId, organizationId, 'domeinen:lezen');
  if (!isUuid(domainId)) throw notFound('Dit domein');
  const row = await one<{ name: string; verification_token: string }>(
    p.pool,
    'SELECT name, verification_token FROM domain WHERE id = $1 AND organization_id = $2',
    [domainId, organizationId],
  );
  if (!row) throw notFound('Dit domein');
  const lookup = p.hostLookup ?? (defaultLookup ??= systemHostLookup());
  return describeDnsHost(row.name, lookup, instructionsFor(row.name, row.verification_token));
}

export async function describeDnsHost(domain: string, lookup: HostLookup, instructions: VerificationInstructions, list = providers()): Promise<DnsHostResult> {
  // Naamservers staan op de zone; bij een subdomein lopen we omhoog.
  let zone: string | null = null;
  let nameservers: string[] = [];
  const labels = domain.split('.');
  for (let i = 0; i < labels.length - 1 && !nameservers.length; i++) {
    const candidate = labels.slice(i).join('.');
    nameservers = (await lookup.resolveNs(candidate)).map((h) => h.toLowerCase().replace(/\.$/, '')).sort();
    if (nameservers.length) zone = candidate;
  }
  const [mx, registrarName] = await Promise.all([lookup.resolveMx(domain), lookup.registrar(zone ?? domain)]);
  const mailServers = mx.map((h) => h.toLowerCase().replace(/\.$/, ''));

  const nsProvider = providerForHosts(nameservers, 'ns', list);
  const regProvider = providerForRegistrar(registrarName, list);
  let dnsBeheer: DnsHostResult['dnsBeheer'];
  if (nsProvider) {
    dnsBeheer = {
      provider: nsProvider,
      naam: nsProvider.naam,
      zekerheid: 'waarschijnlijk',
      reden: `De naamservers van ${zone ?? domain} zijn van ${nsProvider.naam}. Daar pas je de DNS aan.`,
    };
  } else if (nameservers.length && regProvider) {
    dnsBeheer = {
      provider: regProvider,
      naam: regProvider.naam,
      zekerheid: 'mogelijk',
      reden: `We herkennen de naamservers niet, maar de domeinnaam loopt via ${regProvider.naam}. Begin daar; staat de DNS ergens anders, dan zie je dat in hun beheerscherm.`,
    };
  } else if (nameservers.length) {
    dnsBeheer = {
      provider: null,
      naam: null,
      zekerheid: 'onbekend',
      reden: `De DNS staat bij een partij die we niet herkennen (${nameservers[0]}). Vaak is dat je webbouwer of IT-partner.`,
    };
  } else {
    dnsBeheer = { provider: null, naam: null, zekerheid: 'onbekend', reden: 'We konden de naamservers niet opvragen. Bestaat het domein, en is de naam goed gespeld?' };
  }
  return {
    domain,
    zone,
    nameservers,
    dnsBeheer,
    registrar: { naam: registrarName, provider: regProvider },
    mail: { provider: providerForHosts(mailServers, 'mx', list), servers: mailServers.slice(0, 3) },
    instructions,
  };
}
