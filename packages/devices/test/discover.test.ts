import { buildInventory, type Observation } from '@qbicle/inventory';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PRIVACY, discover, readoutToObservations, type DiscoveryResult } from '../src/index.ts';
import { DEMO_PSEUDONYM_KEY, DEMO_SOURCES, demoConnector, demoOui, demoVulnDb } from '../src/demo.ts';

const NOW = new Date('2026-11-26T12:00:00Z');
const privacy = { ...DEFAULT_PRIVACY, pseudonymKey: DEMO_PSEUDONYM_KEY };

async function run(products: Array<'unifi' | 'fritzbox' | 'mikrotik'>, other: Observation[] = []): Promise<DiscoveryResult> {
  return discover({
    connectors: products.map((p) => ({ connector: demoConnector(p, NOW).connector, source: DEMO_SOURCES[p] })),
    otherObservations: other,
    oui: demoOui(),
    vulnDb: demoVulnDb(),
    privacy,
    now: NOW,
  });
}

describe('van router tot score', () => {
  it('deelt de apparaten achter een FRITZ!Box in', async () => {
    const r = await run(['fritzbox']);
    const byName = Object.fromEntries(r.assets.map((a) => [a.attributes.name?.value ?? a.key, a.category]));
    expect(byName).toMatchObject({
      'AVM FRITZ!Box 7590': 'router',
      'LAPTOP-…': 'laptop',
      'iPhone-van-…': 'telefoon',
      BRN001BA9AABBCC: 'printer',
      'DS-2CD2143G2-I': 'camera',
      'Sonos-Kantoor': 'slimme-speaker',
      SMA3004123456: 'zonnepanelen',
      'EASEE-EH123456': 'laadpaal',
      'Hub-2-Plus': 'alarmsysteem',
      'shelly1pm-A1B2C3': 'iot',
      DiskStation: 'nas',
    });
    // Router meldt het apparaat (vastgesteld); de categorie is onze afleiding (mogelijk).
    const cam = r.assets.find((a) => a.attributes.name?.value === 'DS-2CD2143G2-I')!;
    expect(cam.attributes.category).toMatchObject({ certainty: 'mogelijk', sourceKind: 'afleiding' });
    expect(cam.attributes.vendor).toMatchObject({ value: 'Hangzhou Hikvision Digital Technology Co.,Ltd.', certainty: 'mogelijk' });
    expect(cam.exposure).toBe('intern');
  });

  it('maakt van het WAN-adres een doel voor de buitenkant-checks', async () => {
    const r = await run(['fritzbox', 'mikrotik']);
    const wan = r.assets.filter((a) => a.exposure === 'internet').map((a) => a.key);
    expect(wan).toEqual(['ip:84.12.34.56', 'ip:84.12.34.57']);
  });

  it('koppelt firmware aan CVE, KEV en NCSC en laat de score dat zien', async () => {
    const r = await run(['fritzbox', 'mikrotik', 'unifi']);
    expect(r.vulns.map((v) => [v.component.cpe.split(':')[4], v.cve.id, v.certainty])).toEqual([
      ['routeros', 'CVE-2018-14847', 'vastgesteld'],
      ['fritz\\!os', 'CVE-2099-1001', 'vastgesteld'],
    ]);
    const keys = r.findings.map((f) => `${f.key}@${f.asset.value}`).sort();
    expect(keys).toEqual([
      'apparaat.beheerpoort_open_naar_internet@mac:00:1b:a9:aa:bb:cc', // printer-beheerpagina doorgezet in UniFi
      'apparaat.beheerpoort_open_naar_internet@mac:a4:c3:f0:11:22:33', // RDP naar de laptop, Portfreigabe in de FRITZ!Box
      'apparaat.beheerpoort_open_naar_internet@mac:c0:56:e3:12:34:56', // camera-inlogpagina, Portfreigabe in de FRITZ!Box
      'apparaat.beheerpoort_open_naar_internet@serial:9A1B0C2D3E4F', // Winbox doorgezet in de NAT-regels
      'netwerkapparaat.kwetsbaarheid@serial:989BCB000001',
      'netwerkapparaat.kwetsbaarheid@serial:9A1B0C2D3E4F',
      'netwerkapparaat.update_beschikbaar@mac:24:a4:3c:00:00:02',
      'netwerkapparaat.update_beschikbaar@serial:989BCB000001',
    ]);
    const mikrotik = r.score.contributions.find((c) => c.key === 'netwerkapparaat.kwetsbaarheid' && c.m === 2)!;
    expect(mikrotik).toMatchObject({ b: 30, m: 2, z: 1, k: 1, weight: 60 }); // KEV verdubbelt; router telt als randapparaat
    const fritz = r.score.contributions.find((c) => c.key === 'netwerkapparaat.kwetsbaarheid' && c.m !== 2)!;
    expect(fritz.m).toBe(1.5); // NCSC kans hoog
    expect(r.score.band.key).toBe('direct');
    expect(r.score.topActions[0]!.key).toBe('firmware-bijwerken');
    expect(r.score.unknownKeys).toEqual([]);
  });

  it('zet een KEV-lek minstens op "Hoge urgentie", ook als het het enige is', async () => {
    const { score } = await import('@qbicle/score');
    const r = await run(['mikrotik']);
    const kevOnly = r.findings.filter((f) => f.key === 'netwerkapparaat.kwetsbaarheid');
    expect(kevOnly).toHaveLength(1);
    const s = score({ findings: kevOnly, outcomes: ['finding'] });
    expect(['hoog', 'direct']).toContain(s.band.key);
  });

  it('voegt de laptop uit de router samen met dezelfde laptop uit Intune', async () => {
    const intune: Observation = {
      source: { id: 'intune', kind: 'mdm', product: 'intune', level: '1C' },
      observedAt: '2026-11-26T08:00:00Z',
      identifiers: [
        { type: 'serial', value: 'PF3ABC12' },
        { type: 'mac', value: 'A4-C3-F0-11-22-33' },
      ],
      attributes: { kind: 'apparaat', category: 'laptop', name: 'LAPTOP-ERIK', os: 'Windows 11', lastPatched: '2026-11-20T00:00:00Z' },
    };
    const r = await run(['fritzbox'], [intune]);
    const laptop = r.assets.find((a) => a.key === 'serial:PF3ABC12')!;
    expect(laptop.sourceIds).toEqual(['fritzbox-amersfoort', 'intune']);
    expect(laptop.managed).toBe('ja');
    expect(laptop.attributes.category).toMatchObject({ value: 'laptop', sourceId: 'intune', certainty: 'vastgesteld' });
    // Met een beheertool gekoppeld valt de telefoon zonder beheer op.
    expect(r.findings.some((f) => f.key === 'apparaat.onbeheerd' && f.asset.value === 'ip:192.168.178.21')).toBe(true);
  });

  it('telt een router die niet uit te lezen is als fout in de dekking, niet als veilig', async () => {
    const broken = { product: 'mikrotik' as const, read: async () => Promise.reject(new Error('stuk')) };
    const r = await discover({ connectors: [{ connector: broken, source: DEMO_SOURCES.mikrotik }], oui: demoOui(), vulnDb: demoVulnDb(), privacy, now: NOW });
    expect(r.sources).toEqual([{ sourceId: 'mikrotik-werkplaats', outcome: 'error', error: 'interne_fout' }]);
    expect(r.score.coverage).toMatchObject({ done: 0, applicable: 1 });
  });
});

describe('AVG in de hele keten', () => {
  it('bewaart nergens een naam uit een hostnaam of het MAC-adres van een gast', async () => {
    const r = await run(['fritzbox', 'unifi', 'mikrotik']);
    const stored = JSON.stringify({ observations: r.observations, assets: r.assets, clients: r.clients, findings: r.findings });
    for (const leak of ['Sanne', 'ERIK', 'Erik', 'Pieter', '3c:22:fb:99:88:77', '6e:01:02:03:04:05', 'da:a1:19:33:44:55']) {
      expect(stored).not.toContain(leak);
    }
  });

  it('kan de categorie nog steeds bepalen uit de hostnaam voordat die wordt weggelaten', async () => {
    const { connector } = demoConnector('fritzbox', NOW);
    const out = readoutToObservations(await connector.read(), { source: DEMO_SOURCES.fritzbox, oui: demoOui(), privacy });
    const sanne = out.clients.find((c) => c.displayName === 'iPhone-van-…')!;
    expect(sanne.classification.category).toBe('telefoon');
    expect(sanne.classification.reasons.join(' ')).toContain('iPhone-van-…');
    expect(sanne.identifiers.map((i) => i.type)).toEqual(['mac', 'ip']); // geen hostname
    const assets = buildInventory(out.observations, { now: NOW });
    expect(assets.find((a) => a.attributes.name?.value === '…-MacBook')?.identifiers.map((i) => i.type)).toEqual(['mac-hash', 'ip']);
  });
});
