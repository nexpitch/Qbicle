import { describe, expect, it } from 'vitest';
import { caaCheck, dnssecCheck } from '../src/checks/dns.ts';
import { certificateCheck } from '../src/checks/tls.ts';
import {
  cookiesCheck,
  detectVersions,
  headersCheck,
  httpsRedirectCheck,
  securityTxtCheck,
  versionDisclosureCheck,
} from '../src/checks/web.ts';
import { NetError } from '../src/net.ts';
import { fakeNet, GOOD_HEADERS, goodTls, healthyConfig, type FakeNetConfig } from './fake-net.ts';
import { ctxFor, keysOf, website } from './helpers.ts';

const D = 'voorbeeld.nl';
const W = website(D);

function net(patch: (c: FakeNetConfig) => void = () => {}) {
  const c = healthyConfig(D);
  patch(c);
  return fakeNet(c);
}
const webCtx = (n = net()) => ctxFor(n, D, W);

describe('certificaat', () => {
  it('geldig certificaat is in orde', async () => {
    expect((await keysOf(certificateCheck, webCtx())).outcome).toBe('ok');
  });
  it.each([
    ['2026-12-05T00:00:00Z', ['cert.expires_14d']],
    ['2026-12-20T00:00:00Z', ['cert.expires_30d']],
    ['2026-11-01T00:00:00Z', ['cert.expired']],
  ])('verloopt %s → %j', async (validTo, keys) => {
    // Certificaat met een looptijd van een jaar.
    const n = net((c) => {
      const t = goodTls(D, validTo);
      t.cert!.validFrom = '2026-01-01T00:00:00.000Z';
      c.tls![D] = t;
    });
    expect((await keysOf(certificateCheck, webCtx(n))).keys).toEqual(keys);
  });
  it.each([
    ['2026-12-20T00:00:00Z', []],
    ['2026-12-05T00:00:00Z', []],
    ['2026-11-30T00:00:00Z', ['cert.expires_14d']],
  ])('kort certificaat (90 dagen) verloopt %s → %j', async (validTo, keys) => {
    const n = net((c) => {
      const t = goodTls(D, validTo);
      t.cert!.validFrom = new Date(new Date(validTo).getTime() - 90 * 86400000).toISOString();
      c.tls![D] = t;
    });
    expect((await keysOf(certificateCheck, webCtx(n))).keys).toEqual(keys);
  });
  it.each([
    ['CERT_HAS_EXPIRED', 'cert.expired'],
    ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'cert.chain_incomplete'],
    ['SELF_SIGNED_CERT_IN_CHAIN', 'cert.untrusted_ca'],
    ['DEPTH_ZERO_SELF_SIGNED_CERT', 'cert.self_signed'],
    ['CERT_REVOKED', 'cert.invalid'],
  ])('fout %s → %s', async (err, key) => {
    const n = net((c) => (c.tls![D] = { ...goodTls(D), authorized: false, authorizationError: err }));
    expect((await keysOf(certificateCheck, webCtx(n))).keys).toEqual([key]);
  });
  it('verkeerde naam', async () => {
    const n = net((c) => (c.tls![D] = { ...goodTls('ander.nl'), nameMatches: false }));
    expect((await keysOf(certificateCheck, webCtx(n))).keys).toEqual(['cert.name_mismatch']);
  });
  it('geen verbinding is Onbekend', async () => {
    const n = net((c) => (c.tls![D] = new NetError('ETIMEDOUT', 'x')));
    expect((await keysOf(certificateCheck, webCtx(n))).outcome).toBe('unknown');
  });
});

describe('https-doorverwijzing', () => {
  it('301 naar https is in orde', async () => {
    expect((await keysOf(httpsRedirectCheck, webCtx())).outcome).toBe('ok');
  });
  it('http geeft gewoon een pagina', async () => {
    const n = net((c) => (c.http![`http://${D}/`] = { status: 200 }));
    expect((await keysOf(httpsRedirectCheck, webCtx(n))).keys).toEqual(['web.no_https_redirect']);
  });
  it('poort 80 dicht is in orde', async () => {
    const n = net((c) => (c.http![`http://${D}/`] = new NetError('ECONNREFUSED', 'dicht')));
    expect((await keysOf(httpsRedirectCheck, webCtx(n))).outcome).toBe('ok');
  });
  it('time-out is Onbekend', async () => {
    const n = net((c) => (c.http![`http://${D}/`] = new NetError('ETIMEDOUT', 'traag')));
    expect((await keysOf(httpsRedirectCheck, webCtx(n))).outcome).toBe('unknown');
  });
});

describe('security headers', () => {
  it('alle headers goed', async () => {
    expect((await keysOf(headersCheck, webCtx())).outcome).toBe('ok');
  });
  it('kale website mist alles', async () => {
    const n = net((c) => (c.http![`https://${D}/`] = { status: 200, headers: {} }));
    expect((await keysOf(headersCheck, webCtx(n))).keys).toEqual([
      'web.csp_missing',
      'web.framing_unprotected',
      'web.hsts_missing',
      'web.referrer_missing',
      'web.xcto_missing',
    ]);
  });
  it('foutpagina (403 botbescherming) wordt niet beoordeeld', async () => {
    const n = net((c) => (c.http![`https://${D}/`] = { status: 403, headers: {} }));
    const r = await keysOf(headersCheck, webCtx(n));
    expect(r.outcome).toBe('unknown');
    expect(r.keys).toEqual([]);
  });
  it('X-Frame-Options volstaat zonder frame-ancestors; korte HSTS', async () => {
    const n = net(
      (c) =>
        (c.http![`https://${D}/`] = {
          headers: {
            ...GOOD_HEADERS,
            'content-security-policy': "default-src 'self'",
            'x-frame-options': 'SAMEORIGIN',
            'strict-transport-security': 'max-age=300',
          },
        }),
    );
    expect((await keysOf(headersCheck, webCtx(n))).keys).toEqual(['web.hsts_short']);
  });
  it('volgt redirect binnen het domein naar www', async () => {
    const n = net((c) => {
      c.http![`https://${D}/`] = {
        status: 301,
        headers: { location: `https://www.${D}/`, 'strict-transport-security': 'max-age=31536000' },
      };
      c.http![`https://www.${D}/`] = { headers: GOOD_HEADERS };
    });
    expect((await keysOf(headersCheck, webCtx(n))).outcome).toBe('ok');
    expect(n.requests).toContain(`get:https://www.${D}/`);
  });
  it('volgt geen redirect naar een ander domein', async () => {
    const n = net((c) => {
      c.http![`https://${D}/`] = { status: 302, headers: { location: 'https://www.facebook.com/voorbeeld' } };
    });
    const r = await keysOf(headersCheck, webCtx(n));
    expect(r.outcome).toBe('not_applicable');
    expect(n.requests.some((u) => u.includes('facebook'))).toBe(false);
  });
  it('niet bereikbaar is Onbekend', async () => {
    const n = net((c) => (c.http![`https://${D}/`] = new NetError('ETIMEDOUT', 'x')));
    expect((await keysOf(headersCheck, webCtx(n))).outcome).toBe('unknown');
  });
});

describe('cookies', () => {
  it('veilige cookies zijn in orde', async () => {
    expect((await keysOf(cookiesCheck, webCtx())).outcome).toBe('ok');
  });
  it('cookie zonder Secure en HttpOnly', async () => {
    const n = net((c) => (c.http![`https://${D}/`] = { headers: GOOD_HEADERS, setCookies: ['PHPSESSID=abc; path=/'] }));
    const r = await keysOf(cookiesCheck, webCtx(n));
    expect(r.keys).toEqual(['web.cookie_insecure', 'web.cookie_no_httponly']);
    expect(r.out.findings!.find((f) => f.key === 'web.cookie_no_httponly')!.certainty).toBe('mogelijk');
  });
});

describe('softwareversies', () => {
  it('herkent Server, X-Powered-By en meta generator', () => {
    const v = detectVersions({
      url: 'https://x/',
      status: 200,
      headers: { server: 'Apache/2.4.41 (Ubuntu)', 'x-powered-by': 'PHP/7.4.3' },
      setCookies: [],
      body: '<meta name="generator" content="WordPress 6.2.1" />',
    });
    expect(v.map((s) => `${s.product} ${s.version}`)).toEqual(['Apache 2.4.41', 'PHP 7.4.3', 'WordPress 6.2.1']);
  });
  it('alleen een productnaam is geen bevinding', async () => {
    const n = net((c) => (c.http![`https://${D}/`] = { headers: { ...GOOD_HEADERS, server: 'nginx' } }));
    expect((await keysOf(versionDisclosureCheck, webCtx(n))).outcome).toBe('ok');
  });
  it('versie zichtbaar', async () => {
    const n = net((c) => (c.http![`https://${D}/`] = { headers: { ...GOOD_HEADERS, server: 'nginx/1.18.0' } }));
    expect((await keysOf(versionDisclosureCheck, webCtx(n))).keys).toEqual(['web.version_disclosed']);
  });
});

describe('security.txt', () => {
  it('geldig bestand', async () => {
    expect((await keysOf(securityTxtCheck, webCtx())).outcome).toBe('ok');
  });
  it('404 of HTML-pagina telt als ontbrekend', async () => {
    const st = `https://${D}/.well-known/security.txt`;
    const n404 = net((c) => (c.http![st] = { status: 404 }));
    const nHtml = net((c) => (c.http![st] = { status: 200, headers: { 'content-type': 'text/html' }, body: 'Contact: x' }));
    expect((await keysOf(securityTxtCheck, webCtx(n404))).keys).toEqual(['web.securitytxt_missing']);
    expect((await keysOf(securityTxtCheck, webCtx(nHtml))).keys).toEqual(['web.securitytxt_missing']);
  });
  it('verlopen', async () => {
    const st = `https://${D}/.well-known/security.txt`;
    const n = net(
      (c) => (c.http![st] = { headers: { 'content-type': 'text/plain' }, body: 'Contact: mailto:a@b.nl\nExpires: 2025-01-01T00:00:00Z' }),
    );
    expect((await keysOf(securityTxtCheck, webCtx(n))).keys).toEqual(['web.securitytxt_expired']);
  });
});

describe('DNS', () => {
  it('CAA ontbreekt', async () => {
    const n = net((c) => (c.caa = {}));
    expect((await keysOf(caaCheck, ctxFor(n))).keys).toEqual(['caa.missing']);
  });
  it.each([
    [{ hasDs: true, validated: true, bogus: false }, 'ok', []],
    [{ hasDs: false, validated: false, bogus: false }, 'finding', ['dnssec.missing']],
    [{ hasDs: true, validated: false, bogus: true }, 'finding', ['dnssec.invalid']],
    [null, 'unknown', []],
  ])('DNSSEC %j → %s', async (status, outcome, keys) => {
    const n = net((c) => (c.dnssec = { [D]: status }));
    expect(await keysOf(dnssecCheck, ctxFor(n))).toMatchObject({ outcome, keys });
  });
});
