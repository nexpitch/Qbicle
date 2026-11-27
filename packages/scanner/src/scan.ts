import type { Asset, Finding } from '@qbicle/score';
import { score, type ScoreResult } from '@qbicle/score';
import { caaCheck, dnssecCheck } from './checks/dns.ts';
import { dkimCheck } from './checks/dkim.ts';
import { dmarcCheck } from './checks/dmarc.ts';
import { spfCheck } from './checks/spf.ts';
import { softwareCheck } from './checks/software.ts';
import { certificateCheck } from './checks/tls.ts';
import {
  cookiesCheck,
  headersCheck,
  httpsRedirectCheck,
  securityTxtCheck,
  versionDisclosureCheck,
} from './checks/web.ts';
import { normalizeDomain, organizationalDomain } from './domain.ts';
import { fingerprint } from './fingerprint.ts';
import { isPublicIp } from './ip.ts';
import { SCANNER_VERSION, type Net } from './net.ts';
import type { Check, CheckContext, CheckOutput, CheckResult, Level } from './types.ts';

/** Alle checks in deze versie, in rapportvolgorde. */
export const CHECKS: Check[] = [
  spfCheck,
  dmarcCheck,
  dkimCheck,
  dnssecCheck,
  caaCheck,
  certificateCheck,
  httpsRedirectCheck,
  headersCheck,
  cookiesCheck,
  versionDisclosureCheck,
  softwareCheck,
  securityTxtCheck,
];

export interface ScanOptions {
  net: Net;
  /** Hoogste niveau dat mag draaien. 2 bestaat niet: actief testen doet deze scanner nooit. */
  maxLevel?: Level;
  now?: Date;
  /** Domeinen die niet gescand willen worden. */
  optOut?: Set<string>;
  checks?: Check[];
  /** Wordt aangeroepen zodra een check klaar is (voor live voortgang). Mag niet gooien. */
  onCheck?: (result: CheckResult) => void;
}

export interface WebsiteNote {
  host: string;
  status: 'gevonden' | 'geen-adres' | 'intern-adres' | 'onbekend';
  addresses: string[];
}

export interface ScanReport {
  scannerVersion: string;
  domain: string;
  startedAt: string;
  finishedAt: string;
  maxLevel: Level;
  assets: Asset[];
  websites: WebsiteNote[];
  checks: CheckResult[];
  findings: Finding[];
  score: ScoreResult;
}

export class OptOutError extends Error {}
/** Het domein bestaat niet, of DNS werkt niet: dan zeggen we niets, in plaats van alles "ontbreekt". */
export class DomainNotFoundError extends Error {}
/** De DNS-opzoeking van Qbicle zelf werkte niet: geen oordeel over het domein, later opnieuw proberen. */
export class DnsUnavailableError extends Error {}

/**
 * Bestaat www alleen via een wildcard-record (*.domein)? Dan is het geen eigen
 * website maar een bijproduct, vooral bij subdomeinen als invoer. We vergelijken
 * met een naam die zeker niet bestaat.
 */
async function wwwIsWildcard(net: Net, domain: string): Promise<boolean> {
  const probe = `qbicle-${Math.random().toString(36).slice(2, 10)}.${domain}`;
  try {
    const [wild, www] = await Promise.all([net.resolveAddresses(probe), net.resolveAddresses(`www.${domain}`)]);
    if (wild.length === 0) return false;
    const w = new Set(wild);
    return www.length > 0 && www.every((a) => w.has(a));
  } catch {
    return false;
  }
}

/** Website-kandidaten: het hoofddomein en www. Subdomeinen via CT-logs volgen in een latere fase. */
async function discoverWebsites(net: Net, domain: string): Promise<WebsiteNote[]> {
  const hosts = [domain];
  if (!domain.startsWith('www.') && !(await wwwIsWildcard(net, domain))) hosts.push(`www.${domain}`);
  return Promise.all(
    hosts.map(async (host): Promise<WebsiteNote> => {
      try {
        const addresses = await net.resolveAddresses(host);
        if (addresses.length === 0) return { host, status: 'geen-adres', addresses };
        if (!addresses.every(isPublicIp)) return { host, status: 'intern-adres', addresses };
        return { host, status: 'gevonden', addresses };
      } catch {
        return { host, status: 'onbekend', addresses: [] };
      }
    }),
  );
}

/**
 * Houdt de belangrijkste regel uit het ontwerp af: een check die faalt of
 * zichzelf tegenspreekt, levert nooit stilzwijgend "in orde" op.
 */
export function normalizeOutput(out: CheckOutput): CheckOutput {
  const findings = out.findings ?? [];
  if (out.outcome === 'ok' && findings.length > 0) return { ...out, outcome: 'finding' };
  if (out.outcome === 'finding' && findings.length === 0) {
    return { ...out, outcome: 'error', message: out.message ?? 'De check meldde een bevinding zonder details.' };
  }
  if (out.outcome !== 'ok' && out.outcome !== 'finding' && findings.length > 0) {
    // Bevindingen bij unknown/error/n.v.t. zijn tegenstrijdig; niet meetellen.
    return { ...out, findings: [] };
  }
  return out;
}

async function runCheck(check: Check, ctx: CheckContext): Promise<CheckResult> {
  const t0 = Date.now();
  let out: CheckOutput;
  try {
    out = normalizeOutput(await check.run(ctx));
  } catch (e) {
    out = {
      outcome: 'error',
      evidence: { error: (e as { code?: string }).code ?? String((e as Error).message ?? e) },
      message: 'Deze controle kon niet worden uitgevoerd. Dat zegt niets over of het in orde is.',
    };
  }
  const findings: Finding[] = (out.findings ?? []).map(({ discriminator, ...f }) => ({
    ...f,
    checkKey: check.key,
    asset: ctx.asset,
    fingerprint: fingerprint(ctx.asset.type, ctx.asset.value, f.key, discriminator),
  }));
  return {
    checkKey: check.key,
    level: check.level,
    group: check.group,
    title: check.title,
    asset: ctx.asset,
    outcome: out.outcome,
    findings,
    evidence: out.evidence ?? {},
    message: out.message,
    durationMs: Date.now() - t0,
  };
}

export async function scanDomain(input: string, opts: ScanOptions): Promise<ScanReport> {
  const domain = normalizeDomain(input);
  if (opts.optOut?.has(domain)) {
    throw new OptOutError(`${domain} heeft gevraagd niet gescand te worden.`);
  }
  let exists: boolean;
  try {
    exists = await opts.net.domainExists(domain);
  } catch (e) {
    throw new DnsUnavailableError(
      `Qbicle kon ${domain} nu niet opzoeken in DNS (${(e as { code?: string }).code ?? 'storing'}). ` +
        'Dit ligt aan onze kant, niet aan je domein. We proberen het automatisch opnieuw; je kunt ook zelf opnieuw proberen.',
    );
  }
  if (!exists) {
    throw new DomainNotFoundError(`${domain} bestaat niet in DNS. Controleer de spelling.`);
  }
  const maxLevel: Level = opts.maxLevel ?? 1;
  const orgDomain = organizationalDomain(domain);
  const now = opts.now ?? new Date();
  const startedAt = new Date().toISOString();
  const checks = (opts.checks ?? CHECKS).filter((c) => c.level <= maxLevel);

  const cache = new Map<string, Promise<unknown>>();
  const memo = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    if (!cache.has(key)) cache.set(key, fn());
    return cache.get(key) as Promise<T>;
  };

  const domainAsset: Asset = { type: 'domein', value: domain, source: 'opgegeven', visibility: 'primair' };
  const needsWeb = checks.some((c) => c.appliesTo === 'website');
  const websites = needsWeb ? await discoverWebsites(opts.net, domain) : [];
  const webAssets: Asset[] = websites
    .filter((w) => w.status === 'gevonden')
    .map((w) => ({ type: 'website', value: `https://${w.host}`, source: 'dns', visibility: 'primair' }));

  // Is DNSSEC kapot, dan geven gewone resolvers geen antwoord en lijkt alles
  // "ontbreekt". Alleen de DNSSEC-check is dan te vertrouwen.
  const dnssecStatus = checks.some((c) => c.key === 'dns.dnssec')
    ? await memo(`dnssec:${orgDomain}`, () => opts.net.dnssec(orgDomain)).catch(() => null)
    : null;
  const bogus = dnssecStatus?.bogus === true;

  const jobs: Promise<CheckResult>[] = [];
  for (const check of checks) {
    if (bogus && check.key !== 'dns.dnssec') {
      jobs.push(Promise.resolve(bogusResult(check, domainAsset)));
    } else if (check.appliesTo === 'domein') {
      jobs.push(runCheck(check, { domain, orgDomain, asset: domainAsset, net: opts.net, now, memo }));
    } else if (webAssets.length > 0) {
      for (const asset of webAssets) jobs.push(runCheck(check, { domain, orgDomain, asset, net: opts.net, now, memo }));
    } else {
      jobs.push(Promise.resolve(noWebsiteResult(check, domainAsset, websites)));
    }
  }
  const results = await Promise.all(
    jobs.map((j) =>
      j.then((r) => {
        try {
          opts.onCheck?.(r);
        } catch {
          // voortgang is bijzaak; de scan gaat door
        }
        return r;
      }),
    ),
  );
  const findings = results.flatMap((r) => r.findings);

  return {
    scannerVersion: SCANNER_VERSION,
    domain,
    startedAt,
    finishedAt: new Date().toISOString(),
    maxLevel,
    assets: [domainAsset, ...webAssets],
    websites,
    checks: results,
    findings,
    score: score({ findings, outcomes: results.map((r) => r.outcome) }),
  };
}

function bogusResult(check: Check, asset: Asset): CheckResult {
  return {
    checkKey: check.key,
    level: check.level,
    group: check.group,
    title: check.title,
    asset,
    outcome: 'unknown',
    findings: [],
    evidence: { reason: 'dnssec-bogus' },
    message: 'Door de DNSSEC-fout geven veel resolvers geen antwoord voor dit domein, dus dit is niet gecontroleerd.',
    durationMs: 0,
  };
}

function noWebsiteResult(check: Check, asset: Asset, websites: WebsiteNote[]): CheckResult {
  const internal = websites.some((w) => w.status === 'intern-adres');
  const unknown = websites.some((w) => w.status === 'onbekend');
  return {
    checkKey: check.key,
    level: check.level,
    group: check.group,
    title: check.title,
    asset,
    // Kon de DNS-opvraging niet, dan weten we het niet; anders is er gewoon geen website.
    outcome: unknown && !internal ? 'unknown' : 'not_applicable',
    findings: [],
    evidence: { websites },
    message: internal
      ? 'De website wijst naar een intern of gereserveerd adres; daar maakt Qbicle geen verbinding mee.'
      : unknown
        ? 'We konden niet vaststellen of er een website op dit domein draait.'
        : 'Op dit domein en op www draait geen website.',
    durationMs: 0,
  };
}
