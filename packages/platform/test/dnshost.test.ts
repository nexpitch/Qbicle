import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addDomain,
  createOrganization,
  describeDnsHost,
  findDnsHost,
  instructionsFor,
  loadDnsProviders,
  providerForHosts,
  registrarFromRdap,
  type HostLookup,
} from '../src/index.ts';
import { createTestPlatform, hasDb, type TestPlatform } from './support/db.ts';
import { loginAs } from './support/users.ts';

function fake(ns: Record<string, string[]>, mx: string[] = [], registrar: string | null = null): HostLookup {
  return {
    resolveNs: async (n) => ns[n] ?? [],
    resolveMx: async () => mx,
    registrar: async () => registrar,
  };
}
const ins = instructionsFor('bakkerij.nl', 'abc');

describe('waar staat mijn domein', () => {
  it('de providerlijst is geldig en heeft https-inloglinks', () => {
    const list = loadDnsProviders();
    expect(list.length).toBeGreaterThan(10);
    expect(new Set(list.map((p) => p.id)).size).toBe(list.length);
    for (const p of list) expect(p.inlog).toMatch(/^https:\/\//);
  });

  it('herkent partijen aan de naamservers, ook awsdns-nummers', () => {
    expect(providerForHosts(['ns0.transip.net', 'ns1.transip.nl'], 'ns')!.id).toBe('transip');
    expect(providerForHosts(['ada.ns.cloudflare.com'], 'ns')!.id).toBe('cloudflare');
    expect(providerForHosts(['ns-12.awsdns-34.org'], 'ns')!.id).toBe('aws');
    expect(providerForHosts(['ns1.nietcloudflare.com'], 'ns')).toBeNull();
    expect(providerForHosts(['bakkerij-nl.mail.protection.outlook.com'], 'mx')!.id).toBe('microsoft');
  });

  it('naamservers geven "waarschijnlijk", met stappen en mail via Microsoft', async () => {
    const r = await describeDnsHost('bakkerij.nl', fake({ 'bakkerij.nl': ['NS1.STRATO.DE.', 'docks01.rzone.de'] }, ['bakkerij-nl.mail.protection.outlook.com'], 'TransIP B.V.'), ins);
    expect(r.dnsBeheer).toMatchObject({ naam: 'Strato', zekerheid: 'waarschijnlijk' });
    expect(r.dnsBeheer.provider!.stappen.length).toBeGreaterThan(2);
    expect(r.registrar).toMatchObject({ naam: 'TransIP B.V.' });
    expect(r.mail.provider!.id).toBe('microsoft');
  });

  it('onbekende naamservers maar bekende registrar: "mogelijk"', async () => {
    const r = await describeDnsHost('bakkerij.nl', fake({ 'bakkerij.nl': ['ns1.webbouwer-xyz.nl'] }, [], 'Vimexx B.V.'), ins);
    expect(r.dnsBeheer).toMatchObject({ naam: 'Vimexx', zekerheid: 'mogelijk' });
  });

  it('niets herkend of niets gevonden: eerlijk "onbekend"', async () => {
    expect((await describeDnsHost('bakkerij.nl', fake({ 'bakkerij.nl': ['ns1.webbouwer-xyz.nl'] }), ins)).dnsBeheer).toMatchObject({ provider: null, zekerheid: 'onbekend', reden: expect.stringMatching(/webbouwer-xyz/) });
    expect((await describeDnsHost('bakkerij.nl', fake({}), ins)).dnsBeheer.reden).toMatch(/niet opvragen/);
  });

  it('bij een subdomein zoeken we de naamservers op het bovenliggende domein', async () => {
    const r = await describeDnsHost('shop.bakkerij.nl', fake({ 'bakkerij.nl': ['ns1.hostnet.nl'] }), ins);
    expect(r).toMatchObject({ zone: 'bakkerij.nl', dnsBeheer: { naam: 'Hostnet' } });
  });

  it('leest de registrar uit RDAP', () => {
    const rdap = { entities: [{ roles: ['registrant'] }, { roles: ['registrar'], vcardArray: ['vcard', [['version', {}, 'text', '4.0'], ['fn', {}, 'text', 'Hostnet B.V.']]] }] };
    expect(registrarFromRdap(rdap)).toBe('Hostnet B.V.');
    expect(registrarFromRdap({})).toBeNull();
  });
});

describe.skipIf(!hasDb)('waar staat mijn domein: rechten', () => {
  let p: TestPlatform & { hostLookup: HostLookup };
  beforeAll(async () => {
    p = Object.assign(await createTestPlatform(), { hostLookup: fake({ 'kapper.nl': ['ns1.antagonist.nl'] }) });
  });
  afterAll(async () => p?.close());

  it('alleen voor de eigen organisatie, met de TXT-regel van dat domein', async () => {
    const eva = await loginAs(p, 'eva@kapper.nl');
    const kees = await loginAs(p, 'kees@elders.nl');
    const org = (await createOrganization(p, eva, { name: 'Kapper Eva', kind: 'klant' })).id;
    const d = await addDomain(p, eva, org, { name: 'kapper.nl' });
    const r = await findDnsHost(p, eva.userId, org, d.id);
    expect(r.dnsBeheer.naam).toBe('Antagonist');
    expect(r.instructions.dns.value).toBe(d.instructions.dns.value);
    await expect(findDnsHost(p, kees.userId, org, d.id)).rejects.toMatchObject({ code: 'niet_gevonden' });
  });
});
