import { describe, expect, it } from 'vitest';
import { organizationalDomain } from '../src/domain.ts';
import { CHECKS, scanDomain } from '../src/scan.ts';
import { fakeNet, healthyConfig, type FakeNetConfig } from './fake-net.ts';

/**
 * Testgevallen uit de validatie van 27-11: mail- en DNS-controles horen op het
 * hoofddomein of de zone, niet op de ingevulde naam (www, portaal, ...).
 */
const D = 'voorbeeld.nl';
const DOMAIN_CHECKS = CHECKS.filter((c) => c.appliesTo === 'domein');

async function scan(name: string, cfg: FakeNetConfig) {
  const r = await scanDomain(name, { net: fakeNet(cfg), checks: DOMAIN_CHECKS, now: new Date('2026-11-27T12:00:00Z') });
  return { keys: r.findings.map((f) => f.key).sort(), r, by: (k: string) => r.checks.find((c) => c.checkKey === k)! };
}

/** Zoals nexpitch.com: Google Workspace met SPF en DKIM, geen DMARC, geen DNSSEC, geen CAA; www is een CNAME naar een websitebouwer. */
function nexpitchLike(): FakeNetConfig {
  const cfg = healthyConfig(D);
  cfg.txt = {
    [D]: ['v=spf1 include:_spf.google.com ~all', 'google-site-verification=abc'],
    '_spf.google.com': ['v=spf1 ip4:35.190.247.0/24 ~all'],
    [`google._domainkey.${D}`]: ['v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A'],
    // Het doel van de CNAME heeft een eigen SPF dat niets met jouw mail te maken heeft.
    'cdn1.websitebouwer.net': ['v=spf1 -all'],
  };
  cfg.mx = { [D]: [{ exchange: 'aspmx.l.google.com', priority: 1 }] };
  cfg.caa = {};
  cfg.cname = { [`www.${D}`]: 'cdn1.websitebouwer.net' };
  cfg.dnssec = { [D]: { hasDs: false, validated: false, bogus: false } };
  return cfg;
}

describe('hoofddomein bepalen', () => {
  it('Public Suffix List, ook bij tweedelige extensies (geval 8)', () => {
    expect(organizationalDomain('www.voorbeeld.nl')).toBe('voorbeeld.nl');
    expect(organizationalDomain('portaal.bedrijf.co.uk')).toBe('bedrijf.co.uk');
    expect(organizationalDomain('bedrijf.co.uk')).toBe('bedrijf.co.uk');
    expect(organizationalDomain('klant.github.io')).toBe('klant.github.io');
  });
});

describe('subdomein en CNAME', () => {
  it('geval 1: www met CNAME, hoofddomein mailt zonder DMARC: alleen de echte problemen, gewone DMARC-variant', async () => {
    const { keys, by } = await scan(`www.${D}`, nexpitchLike());
    expect(keys).toEqual(['caa.missing', 'dmarc.missing', 'dnssec.missing']);
    expect(by('mail.spf').outcome).toBe('ok');
    expect(by('mail.spf').evidence.measuredOn).toBe(D);
    expect(by('mail.dkim').outcome).toBe('ok');
    const dmarc = by('mail.dmarc').findings[0]!;
    expect(dmarc.detail).toContain('p=none');
    expect(dmarc.detail).toContain('verwijst door naar cdn1.websitebouwer.net');
    expect(dmarc.detail).not.toMatch(/p=reject"? laat/);
  });

  it('geval 1b: hetzelfde domein direct gescand geeft dezelfde uitkomst', async () => {
    expect((await scan(D, nexpitchLike())).keys).toEqual(['caa.missing', 'dmarc.missing', 'dnssec.missing']);
  });

  it('geval 2: subdomein van een gezond domein: geen mail- of DNS-bevindingen', async () => {
    const { keys, r } = await scan(`portaal.${D}`, healthyConfig(D));
    expect(keys).toEqual([]);
    expect(r.score.band.key).toBe('weinig');
  });

  it('geval 3: hoofddomein p=reject met sp=none: "subdomeinen niet beschermd", niet "ontbreekt"', async () => {
    const cfg = healthyConfig(D);
    cfg.txt![`_dmarc.${D}`] = [`v=DMARC1; p=reject; sp=none; rua=mailto:d@${D}`];
    cfg.txt![`portaal.${D}`] = ['v=spf1 include:spf.protection.outlook.com -all'];
    const { keys } = await scan(`portaal.${D}`, cfg);
    expect(keys).toEqual(['dmarc.sp_none']);
  });

  it('geval 4: subdomein met eigen, zwakker DMARC-record: het eigen record telt', async () => {
    const cfg = healthyConfig(D);
    cfg.txt![`_dmarc.portaal.${D}`] = [`v=DMARC1; p=none; rua=mailto:d@${D}`];
    const { keys } = await scan(`portaal.${D}`, cfg);
    expect(keys).toEqual(['dmarc.p_none']);
  });

  it('geval 5: CAA alleen op het hoofddomein: in orde', async () => {
    const { by } = await scan(`portaal.${D}`, healthyConfig(D));
    expect(by('dns.caa').outcome).toBe('ok');
    expect(by('dns.caa').message).toContain(`vastgelegd op ${D}`);
  });

  it('geval 6: www met CNAME waarvan het doel een eigen CAA heeft: in orde met die uitgevers', async () => {
    const cfg = nexpitchLike();
    cfg.caa = { 'cdn1.websitebouwer.net': [{ tag: 'issue', value: 'digicert.com', critical: 0 }] };
    const { by } = await scan(`www.${D}`, cfg);
    expect(by('dns.caa').outcome).toBe('ok');
    expect(by('dns.caa').message).toContain('digicert.com');
  });

  it('geval 7: subdomein in een ondertekende zone zonder eigen DS: DNSSEC in orde', async () => {
    const cfg = healthyConfig(D);
    cfg.dnssec = { [D]: { hasDs: true, validated: true, bogus: false }, [`portaal.${D}`]: { hasDs: false, validated: true, bogus: false } };
    const { by } = await scan(`portaal.${D}`, cfg);
    expect(by('dns.dnssec').outcome).toBe('ok');
  });

  it('geval 8: subdomein onder .co.uk meet op bedrijf.co.uk', async () => {
    const cfg = healthyConfig('bedrijf.co.uk');
    const { keys, by } = await scan('portaal.bedrijf.co.uk', cfg);
    expect(keys).toEqual([]);
    expect(by('mail.spf').evidence.measuredOn).toBe('bedrijf.co.uk');
  });

  it('subdomein met eigen MX en SPF wordt zelf gemeten', async () => {
    const cfg = healthyConfig(D);
    cfg.mx![`mail.${D}`] = [{ exchange: 'mx.provider.net', priority: 10 }];
    cfg.txt![`mail.${D}`] = ['v=spf1 mx ?all'];
    const { by } = await scan(`mail.${D}`, cfg);
    expect(by('mail.spf').evidence.measuredOn).toBe(`mail.${D}`);
    expect(by('mail.spf').findings.map((f) => f.key)).toEqual(['spf.neutral_all']);
  });
});

describe('mailt dit domein? (fout 2)', () => {
  it('geval 9: geen MX, wel SPF met een verzender, geen DMARC: gewone variant, geen p=reject-advies', async () => {
    const cfg = healthyConfig(D);
    cfg.mx = {};
    cfg.txt![`_dmarc.${D}`] = [];
    cfg.txt![D] = ['v=spf1 include:servers.mcsv.net -all'];
    cfg.txt!['servers.mcsv.net'] = ['v=spf1 ip4:198.2.128.0/18 -all'];
    delete cfg.txt![`selector1._domainkey.${D}`];
    const { keys, by } = await scan(D, cfg);
    expect(keys).toEqual(['dmarc.missing']);
    expect(by('mail.dmarc').findings[0]!.detail).toContain('p=none');
  });

  it('geen MX en geen SPF, maar wel een DKIM-sleutel: er wordt gemaild, gewone variant', async () => {
    const cfg = healthyConfig(D);
    cfg.mx = {};
    cfg.txt![D] = [];
    cfg.txt![`_dmarc.${D}`] = [];
    expect((await scan(D, cfg)).keys).toEqual(['dmarc.missing', 'spf.missing']);
  });

  it('geval 10: null MX, geen SPF, geen DMARC: variant "mailt niet", voorwaardelijk geformuleerd', async () => {
    const cfg = healthyConfig(D);
    cfg.mx = { [D]: [{ exchange: '', priority: 0 }] };
    cfg.txt![D] = [];
    cfg.txt![`_dmarc.${D}`] = [];
    delete cfg.txt![`selector1._domainkey.${D}`];
    const { keys, by } = await scan(D, cfg);
    expect(keys).toEqual(['dmarc.missing_no_mail', 'spf.missing_no_mail']);
    expect(by('mail.spf').findings[0]!.detail).toContain('Verstuur je vanaf dit domein echt geen mail');
    expect(by('mail.spf').findings[0]!.detail).not.toContain('ontvangt mail');
  });

  it('MX-opvraging mislukt: bij twijfel gewone variant', async () => {
    const cfg = healthyConfig(D);
    cfg.txt![`_dmarc.${D}`] = [];
    delete cfg.txt![`selector1._domainkey.${D}`];
    const net = fakeNet(cfg);
    net.resolveMx = () => Promise.reject(Object.assign(new Error('x'), { code: 'ETIMEOUT' }));
    const r = await scanDomain(D, { net, checks: DOMAIN_CHECKS.filter((c) => c.key === 'mail.dmarc') });
    expect(r.findings.map((f) => f.key)).toEqual(['dmarc.missing']);
  });
});

describe('DKIM-wildcard (fout 13)', () => {
  it('geval 18: wildcard-TXT met DMARC-tekst op alle namen: DKIM onbekend, niet gevonden', async () => {
    const cfg = healthyConfig(D);
    delete cfg.txt![`selector1._domainkey.${D}`];
    const net = fakeNet(cfg);
    const orig = net.resolveTxt;
    net.resolveTxt = (n) => (n.endsWith(`._domainkey.${D}`) ? Promise.resolve(['v=DMARC1; p=reject']) : orig(n));
    const r = await scanDomain(D, { net, checks: DOMAIN_CHECKS.filter((c) => c.key === 'mail.dkim') });
    expect(r.checks[0]!.outcome).toBe('unknown');
  });

  it('wildcard met een echte sleutel op alle namen telt ook niet', async () => {
    const cfg = healthyConfig(D);
    delete cfg.txt![`selector1._domainkey.${D}`];
    const net = fakeNet(cfg);
    const orig = net.resolveTxt;
    net.resolveTxt = (n) => (n.endsWith(`._domainkey.${D}`) ? Promise.resolve(['v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0B']) : orig(n));
    const r = await scanDomain(D, { net, checks: DOMAIN_CHECKS.filter((c) => c.key === 'mail.dkim') });
    expect(r.checks[0]!.outcome).toBe('unknown');
    expect(r.checks[0]!.evidence.wildcard).toBe(true);
  });
});

describe('SPF-telling (fout 15)', () => {
  it('een include die twee keer voorkomt telt twee keer; een onbekende modifier met streepje is geen fout', async () => {
    const cfg = healthyConfig(D);
    cfg.txt![D] = ['v=spf1 include:spf.protection.outlook.com include:spf.protection.outlook.com x-custom-mod=1 -all'];
    const r = await scanDomain(D, { net: fakeNet(cfg), checks: DOMAIN_CHECKS.filter((c) => c.key === 'mail.spf') });
    expect(r.checks[0]!.evidence.lookups).toBe(2);
    expect(r.findings).toEqual([]);
  });
});
