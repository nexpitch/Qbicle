import { WEIGHTS } from '@qbicle/score';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHECKS, DomainNotFoundError, OptOutError, normalizeOutput, scanDomain } from '../src/scan.ts';
import type { Check } from '../src/types.ts';
import { fakeNet, healthyConfig } from './fake-net.ts';
import { NOW } from './helpers.ts';

const D = 'voorbeeld.nl';

describe('scanDomain', () => {
  it('gezond domein: urgentie 0, volledige dekking', async () => {
    const r = await scanDomain(D, { net: fakeNet(healthyConfig(D)), now: NOW });
    expect(r.findings).toEqual([]);
    expect(r.score.urgency).toBe(0);
    expect(r.score.band.label).toBe('Weinig urgent');
    // DKIM is ok, alles is gecontroleerd
    // De softwarecheck is n.v.t.: de website vertelt geen versies.
    expect(r.score.coverage).toEqual({ done: CHECKS.length - 1, applicable: CHECKS.length - 1, pct: 100 });
    expect(r.score.coverageWarning).toBeNull();
  });

  it('typisch MKB-domein: geen DMARC, verouderde website', async () => {
    const cfg = healthyConfig(D);
    cfg.txt![`_dmarc.${D}`] = [];
    cfg.txt![`selector1._domainkey.${D}`] = [];
    cfg.http![`https://${D}/`] = { headers: { server: 'Apache/2.4.41' }, setCookies: ['PHPSESSID=1; path=/'] };
    const r = await scanDomain(D, { net: fakeNet(cfg), now: NOW });
    expect(r.score.urgency).toBeGreaterThan(25);
    expect(r.score.topActions[0]!.key).toBe('dmarc-instellen');
    expect(r.score.topActions.length).toBeLessThanOrEqual(3);
    // DKIM onbekend verlaagt dekking, niet de score
    expect(r.checks.find((c) => c.checkKey === 'mail.dkim')!.outcome).toBe('unknown');
    expect(r.score.coverage.pct).toBeLessThan(100);
  });

  it('niveau 0 maakt geen enkele verbinding met de systemen van de klant', async () => {
    const net = fakeNet(healthyConfig(D));
    const r = await scanDomain(D, { net, now: NOW, maxLevel: 0 });
    expect(net.requests).toEqual([]);
    expect(r.checks.every((c) => c.level === 0)).toBe(true);
  });

  it('domein dat naar een intern adres wijst wordt niet benaderd', async () => {
    const cfg = healthyConfig(D);
    cfg.addresses = { [D]: ['10.0.0.5'], [`www.${D}`]: ['127.0.0.1'] };
    const net = fakeNet(cfg);
    const r = await scanDomain(D, { net, now: NOW });
    expect(net.requests).toEqual([]);
    const web = r.checks.filter((c) => c.group === 'website' || c.group === 'certificaat');
    expect(web.every((c) => c.outcome === 'not_applicable')).toBe(true);
  });

  it('zonder website tellen websitechecks niet mee in de dekking', async () => {
    const cfg = healthyConfig(D);
    cfg.addresses = {};
    const r = await scanDomain(D, { net: fakeNet(cfg), now: NOW });
    expect(r.score.coverage.applicable).toBe(CHECKS.filter((c) => c.appliesTo === 'domein').length);
  });

  it('scant apex en www als beide bestaan', async () => {
    const cfg = healthyConfig(D);
    cfg.addresses![`www.${D}`] = ['203.0.114.11'];
    const r = await scanDomain(D, { net: fakeNet(cfg), now: NOW });
    expect(r.assets.map((a) => a.value)).toEqual([D, `https://${D}`, `https://www.${D}`]);
  });

  it('www dat alleen via een wildcard bestaat wordt niet gescand', async () => {
    const cfg = healthyConfig(D);
    cfg.addresses![`www.${D}`] = ['203.0.114.10'];
    const net = fakeNet(cfg);
    const orig = net.resolveAddresses;
    // Elke onbekende naam onder het domein wijst naar hetzelfde adres (wildcard).
    net.resolveAddresses = async (n) => (n.startsWith('qbicle-') ? ['203.0.114.10'] : orig(n));
    const r = await scanDomain(D, { net, now: NOW });
    expect(r.assets.map((a) => a.value)).toEqual([D, `https://${D}`]);
  });

  it('kapotte DNSSEC: alleen de DNSSEC-bevinding, de rest onbekend', async () => {
    const cfg = healthyConfig(D);
    cfg.dnssec = { [D]: { hasDs: true, validated: false, bogus: true } };
    cfg.txt = {};
    const r = await scanDomain(D, { net: fakeNet(cfg), now: NOW });
    expect(r.findings.map((f) => f.key)).toEqual(['dnssec.invalid']);
    expect(r.checks.filter((c) => c.checkKey !== 'dns.dnssec').every((c) => c.outcome === 'unknown')).toBe(true);
  });

  it('niet-bestaand domein geeft geen valse bevindingen maar een melding', async () => {
    await expect(scanDomain(D, { net: fakeNet({ nxdomain: [D] }) })).rejects.toThrow(DomainNotFoundError);
  });

  it('DNS-storing bij het opzoeken stopt de scan in plaats van "alles ontbreekt"', async () => {
    const net = { ...fakeNet({}), domainExists: () => Promise.reject(Object.assign(new Error('x'), { code: 'ETIMEOUT' })) };
    await expect(scanDomain(D, { net })).rejects.toThrow(DomainNotFoundError);
  });

  it('respecteert de opt-outlijst', async () => {
    await expect(scanDomain('Voorbeeld.nl', { net: fakeNet({}), optOut: new Set([D]) })).rejects.toThrow(OptOutError);
  });

  it('vingerafdrukken zijn stabiel over scans heen', async () => {
    const cfg = healthyConfig(D);
    cfg.txt![`_dmarc.${D}`] = [];
    const a = await scanDomain(D, { net: fakeNet(cfg), now: NOW });
    const b = await scanDomain(D, { net: fakeNet(cfg), now: NOW });
    expect(a.findings.map((f) => f.fingerprint)).toEqual(b.findings.map((f) => f.fingerprint));
  });
});

describe('een fout is nooit "in orde"', () => {
  it('een check die crasht wordt "error"', async () => {
    const broken: Check = {
      key: 'test.crash',
      level: 0,
      group: 'domein',
      appliesTo: 'domein',
      title: 'crasht',
      run: async () => {
        throw new Error('stuk');
      },
    };
    const r = await scanDomain(D, { net: fakeNet({}), checks: [broken] });
    expect(r.checks[0]!.outcome).toBe('error');
    expect(r.score.coverage.pct).toBe(0);
  });

  it('elke check geeft bij DNS-storingen Onbekend of Fout, nooit In orde', async () => {
    const err = () => Object.assign(new Error('SERVFAIL'), { code: 'ESERVFAIL' });
    const failing = {
      ...fakeNet({}),
      resolveTxt: async () => Promise.reject(err()),
      resolveMx: async () => Promise.reject(err()),
      resolveCaa: async () => Promise.reject(err()),
      resolveAddresses: async () => Promise.reject(err()),
      dnssec: async () => null,
    };
    const r = await scanDomain(D, { net: failing, now: NOW });
    for (const c of r.checks) expect(['unknown', 'error'], c.checkKey).toContain(c.outcome);
  });

  it('elke websitecheck geeft bij netwerkstoringen Onbekend of Fout, nooit In orde', async () => {
    const cfg = healthyConfig(D);
    cfg.tls = {};
    cfg.http = {};
    const timeout = Object.assign(new Error('time-out'), { code: 'ETIMEDOUT' });
    const net = { ...fakeNet(cfg), tlsHandshake: () => Promise.reject(timeout), httpGet: () => Promise.reject(timeout) };
    const r = await scanDomain(D, { net, now: NOW });
    for (const c of r.checks.filter((c) => c.asset.type === 'website')) {
      expect(['unknown', 'error'], c.checkKey).toContain(c.outcome);
    }
  });

  it('normalizeOutput herstelt tegenstrijdige uitkomsten', () => {
    const f = { key: 'x', certainty: 'vastgesteld' as const, title: 't', detail: 'd' };
    expect(normalizeOutput({ outcome: 'ok', findings: [f] }).outcome).toBe('finding');
    expect(normalizeOutput({ outcome: 'finding', findings: [] }).outcome).toBe('error');
    expect(normalizeOutput({ outcome: 'unknown', findings: [f] }).findings).toEqual([]);
  });
});

describe('scoremodel dekt alle bevindingen', () => {
  it('elke bevindingssleutel in de checks heeft een gewicht', () => {
    const dir = join(import.meta.dirname, '../src/checks');
    const checkKeys = new Set(CHECKS.map((c) => c.key));
    const keys = new Set<string>();
    for (const file of readdirSync(dir)) {
      const src = readFileSync(join(dir, file), 'utf8');
      for (const m of src.matchAll(/key: '([a-z]+\.[a-z0-9_]+)'/g)) if (!checkKeys.has(m[1]!)) keys.add(m[1]!);
    }
    expect(keys.size).toBeGreaterThan(20);
    for (const k of keys) expect(WEIGHTS[k], k).toBeDefined();
  });
});
