import { score } from '@qbicle/score';
import { describe, expect, it } from 'vitest';
import { cookiesCheck, headersCheck } from '../src/checks/web.ts';
import { assignOwners, ownerFor } from '../src/eigenaar.ts';
import { scanDomain } from '../src/scan.ts';
import { fakeNet, GOOD_HEADERS, goodTls, healthyConfig, type FakeNetConfig } from './fake-net.ts';
import { ctxFor, keysOf, website } from './helpers.ts';

/**
 * Testgevallen 1 t/m 8 uit "Wat kan de klant zelf doen? Bevindingen per hostingtype"
 * (27-11-2026, akkoord Erik).
 */
const D = 'voorbeeld.nl';
const NOW = new Date('2026-11-27T12:00:00Z');

/** Zoals nexpitch.com: Wix achter Cloudflare, Wix stuurt HSTS en nosniff mee. */
function wixSite(signalen: 'header-en-cname' | 'alleen-cname' = 'header-en-cname'): FakeNetConfig {
  const c = healthyConfig(D);
  c.cname = { [D]: 'cdn1.wixdns.net' };
  c.addresses = { 'cdn1.wixdns.net': ['203.0.114.20'] };
  c.tls = { [D]: goodTls(D) };
  c.http = {
    [`http://${D}/`]: { status: 301, headers: { location: `https://${D}/` } },
    [`https://${D}/`]: {
      status: 200,
      headers: {
        'strict-transport-security': 'max-age=31536000',
        'x-content-type-options': 'nosniff',
        ...(signalen === 'header-en-cname' ? { 'x-wix-request-id': '1764.123' } : {}),
      },
      setCookies: ['ssr-caching=cache#desc=hit; Max-Age=20'],
      body: '<html><body><button>Inloggen</button></body></html>',
    },
    [`https://${D}/.well-known/security.txt`]: { status: 404, body: 'Niet gevonden' },
    [`https://${D}/security.txt`]: { status: 404, body: 'Niet gevonden' },
  };
  return c;
}

async function scan(cfg: FakeNetConfig) {
  const r = await scanDomain(D, { net: fakeNet(cfg), now: NOW });
  const web = r.findings.filter((f) => f.asset.type === 'website');
  const c = (key: string) => r.score.contributions.find((x) => x.key === key);
  return { r, web, keys: web.map((f) => f.key).sort(), c };
}

describe('geval 1: Wix-site zoals nexpitch.com', () => {
  it('platform herkend, geen taken voor de webbouwer, CSP en insluiten zonder gewicht', async () => {
    const { r, keys, web, c } = await scan(wixSite());
    const software = r.checks.find((x) => x.checkKey === 'web.software')!;
    expect((software.evidence as { hosting: { naam: string; zekerheid: string } }).hosting).toMatchObject({ naam: 'Wix', zekerheid: 'zeker' });

    // Geen bevinding voor Referrer-Policy en de cookie ssr-caching.
    expect(keys).not.toContain('web.referrer_missing');
    expect(keys).not.toContain('web.cookie_insecure');
    expect(keys).toEqual(expect.arrayContaining(['web.csp_missing', 'web.framing_unprotected', 'web.securitytxt_missing']));

    for (const k of ['web.csp_missing', 'web.framing_unprotected']) {
      expect(web.find((f) => f.key === k)).toMatchObject({ owner: 'platform', platform: 'Wix' });
      expect(c(k)).toMatchObject({ p: 0, weight: 0 });
    }
    // security.txt: ter info, voor de klant zelf.
    expect(web.find((f) => f.key === 'web.securitytxt_missing')!.owner).toBe('zelf');
    expect(c('web.securitytxt_missing')!.info).toBe(true);

    expect(r.score.topActions.some((a) => a.forWho === 'webbouwer')).toBe(false);
    expect(r.score.platformNotes).toEqual([{ platform: 'Wix', fingerprints: expect.any(Array) }]);
    expect(r.score.platformNotes[0]!.fingerprints).toHaveLength(2);
  });
});

describe('geval 2: alleen de CNAME als signaal', () => {
  it('platform "waarschijnlijk"', async () => {
    const { r, web } = await scan(wixSite('alleen-cname'));
    const software = r.checks.find((x) => x.checkKey === 'web.software')!;
    const hosting = (software.evidence as { hosting?: { naam: string; zekerheid: string } | null }).hosting;
    // Zonder softwareherkenning geeft de softwarecheck "niet van toepassing", maar de hosting staat er wel bij.
    expect(hosting).toMatchObject({ naam: 'Wix', zekerheid: 'waarschijnlijk' });
    expect(web.find((f) => f.key === 'web.csp_missing')!.owner).toBe('platform');
  });
});

describe('geval 3: Wix-site met verlopen certificaat', () => {
  it('blijft zwaar en telt mee; de klant regelt het via Wix', async () => {
    const cfg = wixSite();
    cfg.tls = { [D]: { ...goodTls(D, '2026-11-20T00:00:00.000Z'), authorized: false, authorizationError: 'CERT_HAS_EXPIRED' } };
    const { r, c } = await scan(cfg);
    const cert = r.score.contributions.find((x) => x.key.startsWith('cert.'))!;
    expect(cert).toMatchObject({ owner: 'platform', p: 1 });
    expect(cert.weight).toBeGreaterThanOrEqual(45);
    const action = r.score.topActions.find((a) => a.key === 'cert-vernieuwen')!;
    expect(action).toMatchObject({ forWho: 'zelf', platform: 'Wix' });
    expect(c('web.csp_missing')!.weight).toBe(0);
  });
});

describe('geval 4: gedeelde hosting met Apache, zonder HSTS en CSP', () => {
  it('eigenaar webbouwer, telt mee', async () => {
    const cfg = healthyConfig(D);
    cfg.ptr = { '203.0.114.10': ['web0123.zxcs.nl'] };
    cfg.http![`https://${D}/`] = { status: 200, headers: { server: 'Apache', 'x-content-type-options': 'nosniff' } };
    const { web, c } = await scan(cfg);
    for (const k of ['web.hsts_missing', 'web.csp_missing']) {
      expect(web.find((f) => f.key === k)).toMatchObject({ owner: 'webbouwer', platform: 'Antagonist' });
      expect(c(k)!.weight).toBeGreaterThan(0);
    }
  });
});

const W = website(D);
const page = (patch: Record<string, unknown>) =>
  fakeNet({ ...healthyConfig(D), http: { [`https://${D}/`]: { status: 200, headers: GOOD_HEADERS, ...patch } } });

describe('geval 5 en 6: cookies zonder Secure', () => {
  it('5: site met HSTS en een analysecookie zonder Secure: geen bevinding', async () => {
    const r = await keysOf(cookiesCheck, ctxFor(page({ setCookies: ['_ga=GA1.2.3; Path=/'] }), D, W));
    expect(r.keys).toEqual([]);
  });
  it('6: site zonder HSTS en een sessiecookie zonder Secure: bevinding', async () => {
    const headers: Record<string, string> = { ...GOOD_HEADERS };
    delete headers['strict-transport-security'];
    const r = await keysOf(cookiesCheck, ctxFor(page({ headers, setCookies: ['PHPSESSID=abc; HttpOnly; Path=/'] }), D, W));
    expect(r.keys).toEqual(['web.cookie_insecure']);
  });
  it('zonder HSTS telt ook een gewone cookie zonder Secure', async () => {
    const headers = { 'content-security-policy': GOOD_HEADERS['content-security-policy'] };
    const r = await keysOf(cookiesCheck, ctxFor(page({ headers, setCookies: ['_ga=GA1.2.3; Path=/'] }), D, W));
    expect(r.keys).toEqual(['web.cookie_insecure']);
  });
  it('met HSTS: een sessiecookie zonder Secure blijft een bevinding', async () => {
    const r = await keysOf(cookiesCheck, ctxFor(page({ setCookies: ['PHPSESSID=abc; HttpOnly; Path=/'] }), D, W));
    expect(r.keys).toEqual(['web.cookie_insecure']);
  });
});

describe('geval 7: insluiten', () => {
  const noFraming = { ...GOOD_HEADERS, 'content-security-policy': "default-src 'self'" };
  it('met een inlogformulier: aandacht (telt zwaarder dan ter info)', async () => {
    const body = '<form method="post"><input name="user"><input type="password" name="pw"></form>';
    const r = await keysOf(headersCheck, ctxFor(page({ headers: noFraming, body }), D, W));
    expect(r.keys).toEqual(['web.framing_login']);
    const s = score({ findings: r.out.findings!.map((f) => ({ ...f, checkKey: 'web.headers', asset: W, fingerprint: f.key })), outcomes: ['finding'] });
    expect(s.contributions[0]!.info).toBe(false);
  });
  it('met een betaalformulier: ook aandacht', async () => {
    const body = '<input autocomplete="cc-number" name="kaart">';
    expect((await keysOf(headersCheck, ctxFor(page({ headers: noFraming, body }), D, W))).keys).toEqual(['web.framing_login']);
  });
  it('zonder formulier: ter info', async () => {
    const r = await keysOf(headersCheck, ctxFor(page({ headers: noFraming, body: '<p>Welkom</p>' }), D, W));
    expect(r.keys).toEqual(['web.framing_unprotected']);
    const s = score({ findings: r.out.findings!.map((f) => ({ ...f, checkKey: 'web.headers', asset: W, fingerprint: f.key })), outcomes: ['finding'] });
    expect(s.contributions[0]!.info).toBe(true);
  });
});

describe('Referrer-Policy', () => {
  it('ontbreekt: geen bevinding', async () => {
    const headers = { ...GOOD_HEADERS } as Record<string, string>;
    delete headers['referrer-policy'];
    expect((await keysOf(headersCheck, ctxFor(page({ headers }), D, W))).keys).toEqual([]);
  });
  it('onveilige waarde: bevinding', async () => {
    const headers = { ...GOOD_HEADERS, 'referrer-policy': 'unsafe-url' };
    expect((await keysOf(headersCheck, ctxFor(page({ headers }), D, W))).keys).toEqual(['web.referrer_unsafe']);
  });
  it('de laatste geldige waarde telt', async () => {
    const headers = { ...GOOD_HEADERS, 'referrer-policy': 'no-referrer-when-downgrade, strict-origin-when-cross-origin' };
    expect((await keysOf(headersCheck, ctxFor(page({ headers }), D, W))).keys).toEqual([]);
  });
});

describe('geval 8: klant corrigeert het platform', () => {
  it('van Wix naar eigen server: de eigenaar verandert mee en het telt weer', () => {
    const f = {
      key: 'web.csp_missing',
      checkKey: 'web.headers',
      asset: W,
      certainty: 'vastgesteld' as const,
      title: 'Geen Content-Security-Policy',
      detail: '',
      fingerprint: 'fp1',
    };
    const opWix = assignOwners([f], new Map([[W.value, { naam: 'Wix', soort: 'platform' } as never]]));
    expect(score({ findings: opWix, outcomes: ['finding'] }).totalWeight).toBe(0);
    const eigen = assignOwners([f], new Map([[W.value, { naam: 'Hetzner', soort: 'cloud' } as never]]));
    expect(eigen[0]!.owner).toBe('it-partner');
    expect(score({ findings: eigen, outcomes: ['finding'] }).totalWeight).toBeGreaterThan(0);
  });
});

describe('eigenaar per hostingtype', () => {
  it('DNS en mail zijn overal van de klant', () => {
    expect(ownerFor('dmarc.missing', { soort: 'platform' })).toBe('zelf');
    expect(ownerFor('spf.missing', null)).toBe('zelf');
  });
  it('TLS en de server bij de hoster, headers bij de webbouwer', () => {
    expect(ownerFor('tls.legacy_enabled', { soort: 'hosting' })).toBe('hosting');
    expect(ownerFor('web.version_disclosed', { soort: 'hosting' })).toBe('hosting');
    expect(ownerFor('web.hsts_missing', { soort: 'hosting' })).toBe('webbouwer');
    expect(ownerFor('web.software_kwetsbaar', { soort: 'cloud' })).toBe('webbouwer');
  });
  it('onbekende hosting of alleen een beschermlaag: geen eigenaar', () => {
    expect(ownerFor('web.hsts_missing', null)).toBeUndefined();
    expect(ownerFor('web.hsts_missing', { soort: 'cdn' })).toBeUndefined();
  });
  it('platform met een actief misbruikt lek telt mee', () => {
    const f = {
      key: 'web.software_kwetsbaar',
      checkKey: 'web.software',
      asset: W,
      certainty: 'vastgesteld' as const,
      title: '',
      detail: '',
      fingerprint: 'fp2',
      owner: 'platform' as const,
      platform: 'Shopify',
      vulns: [{ cveId: 'CVE-2026-1', inKev: true }],
    };
    expect(score({ findings: [f], outcomes: ['finding'] }).contributions[0]!.p).toBe(1);
  });
});
