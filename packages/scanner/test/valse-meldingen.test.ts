import { describe, expect, it } from 'vitest';
import { certificateCheck, tlsVersionsCheck } from '../src/checks/tls.ts';
import { cookiesCheck, headersCheck } from '../src/checks/web.ts';
import { NetError } from '../src/net.ts';
import { fakeNet, GOOD_HEADERS, goodTls, healthyConfig, type FakeNetConfig } from './fake-net.ts';
import { ctxFor, keysOf, website } from './helpers.ts';

/** Testgevallen 13, 14, 16, 17 uit de validatie van 27-11 (fout 6, 7, 10, 11, 12, 14). */
const D = 'voorbeeld.nl';
const W = website(D);
function net(patch: (c: FakeNetConfig) => void = () => {}) {
  const c = healthyConfig(D);
  patch(c);
  return fakeNet(c);
}
const webCtx = (n = net()) => ctxFor(n, D, W);
const page = (c: FakeNetConfig, patch: Record<string, unknown>) => {
  c.http![`https://${D}/`] = { ...(c.http![`https://${D}/`] as object), ...patch };
};

describe('oude TLS-versies (fout 6)', () => {
  it('alleen moderne versleuteling: in orde', async () => {
    expect((await keysOf(tlsVersionsCheck, webCtx())).outcome).toBe('ok');
  });
  it('accepteert ook TLS 1.0: bevinding', async () => {
    const r = await keysOf(tlsVersionsCheck, webCtx(net((c) => (c.tlsLegacy = { [D]: { TLSv1: true } }))));
    expect(r.keys).toEqual(['tls.legacy_enabled']);
    expect(r.out.findings![0]!.detail).toContain('TLS 1.0');
  });
  it('geval 13: server met alleen TLS 1.0: duidelijke bevinding, niet alleen "niet gecontroleerd"', async () => {
    const n = net((c) => {
      c.tls![D] = new NetError('ERR_SSL_UNSUPPORTED_PROTOCOL', 'unsupported protocol');
      c.tlsLegacy = { [D]: { TLSv1: true } };
    });
    expect((await keysOf(tlsVersionsCheck, webCtx(n))).keys).toEqual(['tls.only_legacy']);
  });
  it('niet vast te stellen: onbekend', async () => {
    expect((await keysOf(tlsVersionsCheck, webCtx(net((c) => (c.tlsLegacy = { [D]: { TLSv1: null } }))))).outcome).toBe('unknown');
  });
});

describe('certificaten', () => {
  it('geval 14: looptijd 6 dagen, nog 5 dagen geldig: geen bevinding (fout 7)', async () => {
    const n = net((c) => {
      // NOW in de tests is 26-11 12:00: uitgegeven 25-11, geldig tot 1-12 (6 dagen), nog 5 dagen.
      const t = goodTls(D, '2026-12-01T12:00:00.000Z');
      t.cert!.validFrom = '2026-11-25T12:00:00.000Z';
      c.tls![D] = t;
    });
    expect((await keysOf(certificateCheck, webCtx(n))).keys).toEqual([]);
  });
  it('90-dagencertificaat met nog 5 dagen: wel een bevinding', async () => {
    const n = net((c) => {
      const t = goodTls(D, '2026-12-01T12:00:00.000Z');
      t.cert!.validFrom = '2026-09-02T12:00:00.000Z';
      c.tls![D] = t;
    });
    expect((await keysOf(certificateCheck, webCtx(n))).keys).toEqual(['cert.expires_14d']);
  });
  it('certificaat voor een andere naam: één bevinding, niet ook "ongeldig" (fout 14)', async () => {
    const n = net((c) => {
      const t = goodTls('ander.nl');
      t.authorized = false;
      t.authorizationError = 'ERR_TLS_CERT_ALTNAME_INVALID';
      t.nameMatches = false;
      c.tls![D] = t;
    });
    expect((await keysOf(certificateCheck, webCtx(n))).keys).toEqual(['cert.name_mismatch']);
  });
});

describe('headers (fout 10, 12)', () => {
  it('geval 16: "nosniff, nosniff" en dubbele X-Frame-Options geven geen bevinding', async () => {
    const n = net((c) =>
      page(c, {
        headers: {
          ...GOOD_HEADERS,
          'content-security-policy': "default-src 'self'",
          'x-content-type-options': 'nosniff, nosniff',
          'x-frame-options': 'SAMEORIGIN, SAMEORIGIN',
        },
      }),
    );
    expect((await keysOf(headersCheck, webCtx(n))).keys).toEqual([]);
  });
  it('tegenstrijdige X-Frame-Options blijft een bevinding', async () => {
    const n = net((c) =>
      page(c, { headers: { ...GOOD_HEADERS, 'content-security-policy': "default-src 'self'", 'x-frame-options': 'SAMEORIGIN, ALLOWALL' } }),
    );
    expect((await keysOf(headersCheck, webCtx(n))).keys).toEqual(['web.framing_unprotected']);
  });
  it('geval 17b: CSP alleen in een meta-tag telt als CSP', async () => {
    const { 'content-security-policy': _csp, ...rest } = GOOD_HEADERS;
    const n = net((c) =>
      page(c, {
        headers: { ...rest, 'x-frame-options': 'DENY' },
        body: `<html><head><meta http-equiv="Content-Security-Policy" content="default-src 'self'"></head></html>`,
      }),
    );
    const r = await keysOf(headersCheck, webCtx(n));
    expect(r.keys).toEqual([]);
    expect(r.out.evidence?.metaCsp).toBe("default-src 'self'");
  });
});

describe('cookies (fout 11)', () => {
  it('geval 17a: alleen XSRF-TOKEN en csrftoken zonder HttpOnly: geen bevinding', async () => {
    const n = net((c) => page(c, { setCookies: ['XSRF-TOKEN=abc; Secure; SameSite=Lax', 'csrftoken=def; Secure; SameSite=Lax'] }));
    expect((await keysOf(cookiesCheck, webCtx(n))).keys).toEqual([]);
  });
  it('een echte sessiecookie zonder HttpOnly blijft een bevinding', async () => {
    const n = net((c) => page(c, { setCookies: ['PHPSESSID=abc; Secure; SameSite=Lax'] }));
    expect((await keysOf(cookiesCheck, webCtx(n))).keys).toEqual(['web.cookie_no_httponly']);
  });
});
