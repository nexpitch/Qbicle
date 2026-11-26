import type { DnssecStatus, HttpResponse, Net, TlsInfo } from '../src/net.ts';
import { NetError } from '../src/net.ts';

/**
 * Nep-netwerk voor tests: alles wat niet is ingesteld bestaat niet (lege lijst),
 * en elke waarde kan ook een fout zijn om storingen na te bootsen.
 */
export interface FakeNetConfig {
  /** Namen die niet bestaan (NXDOMAIN); standaard bestaat alles. */
  nxdomain?: string[];
  txt?: Record<string, string[] | Error>;
  mx?: Record<string, { exchange: string; priority: number }[]>;
  caa?: Record<string, { tag: string; value: string; critical: number }[]>;
  addresses?: Record<string, string[] | Error>;
  dnssec?: Record<string, DnssecStatus | null>;
  tls?: Record<string, TlsInfo | Error>;
  http?: Record<string, Partial<HttpResponse> | Error>;
}

export function fakeNet(cfg: FakeNetConfig): Net & { requests: string[] } {
  const requests: string[] = [];
  const val = <T>(v: T | Error | undefined, fallback: T): Promise<T> =>
    v instanceof Error ? Promise.reject(v) : Promise.resolve(v ?? fallback);
  return {
    requests,
    domainExists: async (n) => !(cfg.nxdomain ?? []).includes(n),
    resolveTxt: (n) => val(cfg.txt?.[n], []),
    resolveMx: (n) => val(cfg.mx?.[n], []),
    resolveCaa: (n) => val(cfg.caa?.[n], []),
    resolveAddresses: (n) => val(cfg.addresses?.[n], []),
    dnssec: async (n) => (cfg.dnssec && n in cfg.dnssec ? cfg.dnssec[n]! : { hasDs: true, validated: true, bogus: false }),
    tlsHandshake: (host) => {
      requests.push(`tls:${host}`);
      const v = cfg.tls?.[host];
      if (!v) return Promise.reject(new NetError('ECONNREFUSED', 'geen tls'));
      return val(v, v as TlsInfo);
    },
    httpGet: (url) => {
      requests.push(`get:${url}`);
      const v = cfg.http?.[url];
      if (!v) return Promise.reject(new NetError('ECONNREFUSED', `geen antwoord ${url}`));
      if (v instanceof Error) return Promise.reject(v);
      return Promise.resolve({ url, status: 200, headers: {}, setCookies: [], body: '', ...v });
    },
  };
}

export const GOOD_HEADERS = {
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'content-security-policy': "default-src 'self'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
};

export function goodTls(host: string, validTo = '2027-06-01T00:00:00.000Z'): TlsInfo {
  return {
    protocol: 'TLSv1.3',
    authorized: true,
    authorizationError: null,
    nameMatches: true,
    cert: {
      subjectCn: host,
      altNames: [host],
      issuer: "Let's Encrypt",
      validFrom: '2026-09-01T00:00:00.000Z',
      validTo,
      fingerprint256: 'AA:BB',
    },
  };
}

/** Een domein waar alles in orde is; tests passen er één ding aan. */
export function healthyConfig(domain = 'voorbeeld.nl'): FakeNetConfig {
  const www = `www.${domain}`;
  return {
    txt: {
      [domain]: ['v=spf1 include:spf.protection.outlook.com -all'],
      'spf.protection.outlook.com': ['v=spf1 ip4:40.92.0.0/15 -all'],
      [`_dmarc.${domain}`]: [`v=DMARC1; p=reject; rua=mailto:dmarc@${domain}`],
      [`selector1._domainkey.${domain}`]: ['v=DKIM1; k=rsa; p=MIIBIjANBgkq'],
    },
    mx: { [domain]: [{ exchange: `${domain.replace('.', '-')}.mail.protection.outlook.com`, priority: 0 }] },
    caa: { [domain]: [{ tag: 'issue', value: 'letsencrypt.org', critical: 0 }] },
    addresses: { [domain]: ['203.0.114.10'], [www]: [] },
    tls: { [domain]: goodTls(domain) },
    http: {
      [`http://${domain}/`]: { status: 301, headers: { location: `https://${domain}/` } },
      [`https://${domain}/`]: { status: 200, headers: GOOD_HEADERS, setCookies: ['sid=1; Secure; HttpOnly; SameSite=Lax'] },
      [`https://${domain}/.well-known/security.txt`]: {
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
        body: `Contact: mailto:security@${domain}\nExpires: 2027-12-31T23:00:00Z\n`,
      },
    },
  };
}
