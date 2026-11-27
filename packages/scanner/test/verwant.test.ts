import { describe, expect, it } from 'vitest';
import { scanDomain } from '../src/scan.ts';
import { hoofddomein, isExterneDienst, kandidatenUitChecks } from '../src/verwant.ts';
import { fakeNet, goodTls, healthyConfig, type FakeNetConfig } from './fake-net.ts';
import { NOW } from './helpers.ts';

/** "Hoort dit ook bij jullie?": alleen met bewijs, nooit hetzelfde hoofddomein of een externe dienst. */

const D = 'bakkerij.nl';

function metCertificaat(cfg: FakeNetConfig, altNames: string[]): FakeNetConfig {
  const tls = goodTls(D);
  tls.cert!.altNames = altNames;
  cfg.tls = { ...cfg.tls, [D]: tls };
  return cfg;
}

function metWebsite(cfg: FakeNetConfig, host: string, res: { status?: number; headers?: Record<string, string> } = {}): FakeNetConfig {
  cfg.addresses = { ...cfg.addresses, [host]: ['203.0.114.20'] };
  cfg.http = { ...cfg.http, [`https://${host}/`]: { status: 200, ...res } };
  return cfg;
}

describe('verwante domeinen: hulpfuncties', () => {
  it('hoofddomein volgens de Public Suffix List', () => {
    expect(hoofddomein('www.nexpitch.com')).toBe('nexpitch.com');
    expect(hoofddomein('*.shop.bakkerij.co.uk')).toBe('bakkerij.co.uk');
    expect(hoofddomein('https://www.bakkerij.nl/pad')).toBe('bakkerij.nl');
    expect(hoofddomein('KPN Box 12')).toBeNull();
    expect(hoofddomein('localhost')).toBeNull();
  });

  it('herkent externe diensten, ook subdomeinen en klantnamen daaronder', () => {
    expect(isExterneDienst('wixsite.com')).toBe(true);
    expect(isExterneDienst('cdn3.wixdns.net')).toBe(true);
    expect(isExterneDienst('cloudflaressl.com')).toBe(true);
    expect(isExterneDienst('bakkerij-online.nl')).toBe(false);
  });
});

describe('verwante domeinen in een scan', () => {
  it('www en hoofddomein op hetzelfde certificaat: geen suggestie', async () => {
    const cfg = metCertificaat(healthyConfig(D), [D, `www.${D}`]);
    const r = await scanDomain(D, { net: fakeNet(cfg), now: NOW });
    expect(r.verwanteDomeinen).toEqual([]);
  });

  it('website verwijst door van www naar het hoofddomein: geen suggestie', async () => {
    const cfg = healthyConfig(`www.${D}`);
    cfg.http![`https://www.${D}/`] = { status: 301, headers: { location: `https://${D}/` } };
    const r = await scanDomain(`www.${D}`, { net: fakeNet(cfg), now: NOW });
    expect(r.verwanteDomeinen ?? []).toEqual([]);
  });

  it('externe dienst op het certificaat of als doorverwijzing: geen suggestie', async () => {
    const cfg = metCertificaat(healthyConfig(D), [D, 'sni.cloudflaressl.com', 'klant.wixsite.com']);
    metWebsite(cfg, 'sni.cloudflaressl.com');
    cfg.http![`https://${D}/`] = { status: 302, headers: { location: 'https://www.facebook.com/bakkerij' } };
    const r = await scanDomain(D, { net: fakeNet(cfg), now: NOW });
    expect(r.verwanteDomeinen).toEqual([]);
  });

  it('gedeeld certificaat met veel verschillende domeinen telt niet als bewijs', () => {
    const tls = goodTls(D);
    tls.cert!.altNames = [D, 'een.nl', 'twee.nl', 'drie.nl', 'vier.nl', 'vijf.nl'];
    const k = kandidatenUitChecks(D, [{ checkKey: 'tls.certificate', asset: { type: 'website', value: `https://${D}` }, outcome: 'ok', evidence: { ...tls } } as never]);
    expect(k).toEqual([]);
  });

  it('ongeldig certificaat telt niet als bewijs', () => {
    const tls = goodTls(D);
    tls.authorized = false;
    tls.cert!.altNames = [D, 'bakkerij-online.nl'];
    const k = kandidatenUitChecks(D, [{ checkKey: 'tls.certificate', asset: { type: 'website', value: `https://${D}` }, outcome: 'ok', evidence: { ...tls } } as never]);
    expect(k).toEqual([]);
  });

  it('bewijs (zelfde certificaat) en een website: wel een suggestie, met reden', async () => {
    const cfg = metCertificaat(healthyConfig(D), [D, 'bakkerij-online.nl', 'www.bakkerij-online.nl']);
    metWebsite(cfg, 'bakkerij-online.nl', { status: 301, headers: { location: `https://${D}/` } });
    const r = await scanDomain(D, { net: fakeNet(cfg), now: NOW });
    expect(r.verwanteDomeinen).toEqual([
      {
        domein: 'bakkerij-online.nl',
        dienst: 'website',
        bewijs: [
          { soort: 'certificaat', via: D },
          { soort: 'verwijst-terug', via: 'bakkerij-online.nl' },
        ],
      },
    ]);
  });

  it('website verwijst door naar een ander eigen domein: wel een suggestie', async () => {
    const cfg = healthyConfig(D);
    cfg.http![`https://${D}/`] = { status: 301, headers: { location: 'https://bakkerijdevries.nl/' } };
    metWebsite(cfg, 'bakkerijdevries.nl');
    const r = await scanDomain(D, { net: fakeNet(cfg), now: NOW });
    expect(r.verwanteDomeinen).toEqual([{ domein: 'bakkerijdevries.nl', dienst: 'website', bewijs: [{ soort: 'doorverwijzing', via: D }] }]);
  });

  it('bewijs maar er hangt niets aan (geen adres, geen mail): geen suggestie', async () => {
    const cfg = metCertificaat(healthyConfig(D), [D, 'oude-naam.nl']);
    const r = await scanDomain(D, { net: fakeNet(cfg), now: NOW });
    expect(r.verwanteDomeinen).toEqual([]);
  });

  it('geparkeerd domein dat doorstuurt naar een derde partij: geen suggestie', async () => {
    const cfg = metCertificaat(healthyConfig(D), [D, 'oude-naam.nl']);
    metWebsite(cfg, 'oude-naam.nl', { status: 302, headers: { location: 'https://parkeerdienst.example/te-koop' } });
    const r = await scanDomain(D, { net: fakeNet(cfg), now: NOW });
    expect(r.verwanteDomeinen).toEqual([]);
  });

  it('alleen een mailserver telt ook als dienst', async () => {
    const cfg = metCertificaat(healthyConfig(D), [D, 'bakkerij-mail.nl']);
    cfg.mx = { ...cfg.mx, 'bakkerij-mail.nl': [{ exchange: 'mx.bakkerij-mail.nl', priority: 10 }] };
    const r = await scanDomain(D, { net: fakeNet(cfg), now: NOW });
    expect(r.verwanteDomeinen?.map((v) => [v.domein, v.dienst])).toEqual([['bakkerij-mail.nl', 'mail']]);
  });

  it('niveau 0 zoekt niet en maakt geen verbindingen', async () => {
    const net = fakeNet(metCertificaat(healthyConfig(D), [D, 'bakkerij-online.nl']));
    const r = await scanDomain(D, { net, now: NOW, maxLevel: 0 });
    expect(r.verwanteDomeinen).toBeUndefined();
    expect(net.requests).toEqual([]);
  });
});
