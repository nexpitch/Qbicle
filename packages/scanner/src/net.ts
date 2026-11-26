import { promises as dnsp, lookup as dnsLookup, type LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { isPublicIp } from './ip.ts';

/**
 * Alles wat de scanner met het netwerk doet, loopt via deze interface.
 * Tests gebruiken een nep-implementatie; productie gebruikt `createNodeNet`.
 *
 * Regels voor elke implementatie:
 * - "bestaat niet" (NXDOMAIN, geen records) geeft een lege lijst, geen fout;
 * - echte fouten (time-out, SERVFAIL) gooien, zodat de check "onbekend" wordt
 *   in plaats van stilzwijgend "in orde".
 */
export interface Net {
  /**
   * Bestaat de naam in DNS? NXDOMAIN geeft false; een naam zonder eigen
   * zone (NODATA) bestaat wel. Storingen gooien een fout.
   */
  domainExists(name: string): Promise<boolean>;
  resolveTxt(name: string): Promise<string[]>;
  resolveMx(name: string): Promise<{ exchange: string; priority: number }[]>;
  resolveCaa(name: string): Promise<{ tag: string; value: string; critical: number }[]>;
  /** A- en AAAA-records samen. */
  resolveAddresses(name: string): Promise<string[]>;
  /** DNSSEC-status via een validerende resolver; null als dat niet lukte. */
  dnssec(name: string): Promise<DnssecStatus | null>;
  tlsHandshake(host: string, port?: number): Promise<TlsInfo>;
  /** Eén HTTP(S)-verzoek, zonder redirects te volgen. */
  httpGet(url: string): Promise<HttpResponse>;
}

export interface DnssecStatus {
  /** Er staat een DS-record in de bovenliggende zone. */
  hasDs: boolean;
  /** Een validerende resolver bevestigt de handtekeningen (AD-vlag). */
  validated: boolean;
  /** De resolver gaf SERVFAIL, maar zonder validatie wel een antwoord: DNSSEC is kapot. */
  bogus: boolean;
}

export interface TlsInfo {
  protocol: string | null;
  /** Keten klopt tegen de vertrouwde CA's van Node (Mozilla-lijst). */
  authorized: boolean;
  authorizationError: string | null;
  /** Naam op het certificaat past bij de host. */
  nameMatches: boolean;
  cert: {
    subjectCn: string | null;
    altNames: string[];
    issuer: string | null;
    validFrom: string;
    validTo: string;
    fingerprint256: string;
  } | null;
}

export interface HttpResponse {
  url: string;
  status: number;
  /** Headernamen in kleine letters; meerdere waarden met ", " samengevoegd. */
  headers: Record<string, string>;
  setCookies: string[];
  /** Begin van de body (maximaal MAX_BODY_BYTES). */
  body: string;
}

/** Fout met een vaste code, zodat checks onderscheid kunnen maken. */
export class NetError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export const SCANNER_VERSION = '0.2.0';
export const MAX_BODY_BYTES = 256 * 1024;

export interface NodeNetOptions {
  timeoutMs?: number;
  /** DNS-over-HTTPS JSON-endpoint (validerende resolver) voor de DNSSEC-check. */
  dohUrl?: string;
  /** Link naar de uitlegpagina, komt in de User-Agent. */
  infoUrl?: string;
}

/** Tijdelijke netwerkfouten: één keer opnieuw proberen voordat een check "onbekend" wordt. */
const TRANSIENT = new Set(['ETIMEDOUT', 'ECONNRESET', 'EPIPE', 'EAI_AGAIN']);
const RETRY_DELAY_MS = 1000;

export async function withRetry<T>(fn: () => Promise<T>, delayMs = RETRY_DELAY_MS): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (!TRANSIENT.has((e as { code?: string }).code ?? '')) throw e;
    await new Promise((r) => setTimeout(r, delayMs));
    return fn();
  }
}

const NO_DATA = new Set(['ENOTFOUND', 'ENODATA', 'NXDOMAIN', 'ENONAME']);

async function orEmpty<T>(p: Promise<T[]>): Promise<T[]> {
  try {
    return await p;
  } catch (e) {
    if (NO_DATA.has((e as NodeJS.ErrnoException).code ?? '')) return [];
    throw e;
  }
}

/**
 * DNS-lookup die alleen publieke adressen doorlaat. Wordt gebruikt voor elke
 * verbinding, ook na redirects, zodat DNS-rebinding geen intern adres oplevert.
 */
export function safeLookup(
  hostname: string,
  options: { all?: boolean; family?: number } | number,
  callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
): void {
  const opts = typeof options === 'number' ? { family: options } : options;
  dnsLookup(hostname, { all: true, family: opts.family ?? 0 }, (err, addresses) => {
    if (err) return callback(err, '');
    const list = addresses as LookupAddress[];
    const bad = list.find((a) => !isPublicIp(a.address));
    if (bad || list.length === 0) {
      const e = new NetError(
        'EQBICLE_PRIVATE_ADDRESS',
        `${hostname} wijst naar een intern of gereserveerd adres; daar maakt Qbicle geen verbinding mee.`,
      ) as unknown as NodeJS.ErrnoException;
      return callback(e, '');
    }
    if (opts.all) return callback(null, list);
    callback(null, list[0]!.address, list[0]!.family);
  });
}

export function createNodeNet(opts: NodeNetOptions = {}): Net {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const dohUrl = opts.dohUrl ?? 'https://cloudflare-dns.com/dns-query';
  const userAgent = `QbicleScanner/${SCANNER_VERSION} (+${opts.infoUrl ?? 'https://qbicle.example/scanner'})`;
  const resolver = new dnsp.Resolver({ timeout: timeoutMs, tries: 2 });

  async function doh(name: string, type: string, extra: Record<string, string> = {}) {
    const u = new URL(dohUrl);
    u.searchParams.set('name', name);
    u.searchParams.set('type', type);
    for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v);
    const res = await fetch(u, {
      headers: { accept: 'application/dns-json', 'user-agent': userAgent },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new NetError('EDOH', `DoH-resolver gaf HTTP ${res.status}`);
    return (await res.json()) as { Status: number; AD?: boolean; Answer?: { type: number }[] };
  }

  return {
    async domainExists(name) {
      try {
        await resolver.resolveSoa(name);
        return true;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === 'ENODATA') return true;
        if (code === 'ENOTFOUND' || code === 'NXDOMAIN') {
          // Sommige resolvers (ook die van Docker) melden een DNSSEC-fout (SERVFAIL)
          // als "bestaat niet". Vraag het na zonder validatie: bestaat de naam dan
          // wel, dan is DNSSEC kapot en hoort dat in het rapport.
          try {
            const unchecked = await doh(name, 'SOA', { cd: '1' });
            return unchecked.Status === 0;
          } catch {
            return false;
          }
        }
        throw e;
      }
    },
    async resolveTxt(name) {
      const recs = await orEmpty(resolver.resolveTxt(name));
      return recs.map((chunks) => chunks.join(''));
    },
    resolveMx: (name) => orEmpty(resolver.resolveMx(name)),
    async resolveCaa(name) {
      const recs = await orEmpty(resolver.resolveCaa(name));
      return recs.map((r) => {
        const { critical, ...rest } = r as unknown as Record<string, unknown> & { critical: number };
        const [tag, value] = Object.entries(rest)[0] ?? ['', ''];
        return { tag, value: String(value), critical };
      });
    },
    async resolveAddresses(name) {
      const [a, aaaa] = await Promise.all([
        orEmpty(resolver.resolve4(name)),
        orEmpty(resolver.resolve6(name)),
      ]);
      return [...a, ...aaaa];
    },
    async dnssec(name) {
      try {
        const ds = await doh(name, 'DS');
        const hasDs = ds.Status === 0 && (ds.Answer ?? []).some((a) => a.type === 43);
        const soa = await doh(name, 'SOA', { do: '1' });
        if (soa.Status === 2) {
          const unchecked = await doh(name, 'SOA', { do: '1', cd: '1' });
          return { hasDs, validated: false, bogus: unchecked.Status === 0 };
        }
        return { hasDs, validated: soa.AD === true, bogus: false };
      } catch {
        return null;
      }
    },
    tlsHandshake(host, port = 443) {
      return withRetry(() => new Promise<TlsInfo>((resolve, reject) => {
        const socket = tls.connect({
          host,
          port,
          servername: host,
          rejectUnauthorized: false,
          lookup: safeLookup as never,
          timeout: timeoutMs,
        });
        const fail = (e: Error) => {
          socket.destroy();
          reject(e);
        };
        socket.once('timeout', () => fail(new NetError('ETIMEDOUT', `Geen antwoord van ${host}:${port}`)));
        socket.once('error', fail);
        socket.once('secureConnect', () => {
          const peer = socket.getPeerCertificate(false);
          const hasCert = peer && Object.keys(peer).length > 0;
          const idErr = hasCert ? tls.checkServerIdentity(host, peer) : new Error('geen certificaat');
          const info: TlsInfo = {
            protocol: socket.getProtocol(),
            authorized: socket.authorized,
            authorizationError: socket.authorizationError
              ? String((socket.authorizationError as unknown as { code?: string }).code ?? socket.authorizationError)
              : null,
            nameMatches: !idErr,
            cert: hasCert
              ? {
                  subjectCn: (peer.subject?.CN as string | undefined) ?? null,
                  altNames: (peer.subjectaltname ?? '')
                    .split(/,\s*/)
                    .filter((s) => s.startsWith('DNS:'))
                    .map((s) => s.slice(4)),
                  issuer: (peer.issuer?.O as string | undefined) ?? (peer.issuer?.CN as string | undefined) ?? null,
                  validFrom: new Date(peer.valid_from).toISOString(),
                  validTo: new Date(peer.valid_to).toISOString(),
                  fingerprint256: peer.fingerprint256,
                }
              : null,
          };
          socket.end();
          resolve(info);
        });
      }));
    },
    httpGet(url) {
      return withRetry(() => new Promise<HttpResponse>((resolve, reject) => {
        const u = new URL(url);
        const lib = u.protocol === 'https:' ? https : u.protocol === 'http:' ? http : null;
        if (!lib) return reject(new NetError('EPROTO', `Niet-ondersteund protocol ${u.protocol}`));
        const req = lib.request(
          u,
          {
            method: 'GET',
            headers: { 'user-agent': userAgent, accept: 'text/html,*/*;q=0.8' },
            lookup: safeLookup as never,
            timeout: timeoutMs,
            // Certificaatfouten beoordeelt de TLS-check; hier willen we de headers zien.
            rejectUnauthorized: false,
          },
          (res) => {
            const chunks: Buffer[] = [];
            let size = 0;
            res.on('data', (c: Buffer) => {
              if (size < MAX_BODY_BYTES) chunks.push(c);
              size += c.length;
              if (size >= MAX_BODY_BYTES) res.destroy();
            });
            const done = () => {
              const headers: Record<string, string> = {};
              for (const [k, v] of Object.entries(res.headers)) {
                if (k === 'set-cookie' || v === undefined) continue;
                headers[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
              }
              resolve({
                url,
                status: res.statusCode ?? 0,
                headers,
                setCookies: res.headers['set-cookie'] ?? [],
                body: Buffer.concat(chunks).subarray(0, MAX_BODY_BYTES).toString('utf8'),
              });
            };
            res.once('end', done);
            res.once('close', done);
            res.once('error', reject);
          },
        );
        req.once('timeout', () => req.destroy(new NetError('ETIMEDOUT', `Geen antwoord van ${u.host}`)));
        req.once('error', reject);
        req.end();
      }));
    },
  };
}
