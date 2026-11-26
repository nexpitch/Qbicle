import type { InventoryAsset } from '@qbicle/inventory';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PRIVACY, EolDb, FixtureTransport, MERAKI_RULES, MerakiConnector, discover } from '../src/index.ts';
import { DEMO_PSEUDONYM_KEY, DEMO_SOURCES, demoConnector, demoEolDb, demoOui, demoVulnDb } from '../src/demo.ts';

const NOW = new Date('2026-11-26T12:00:00Z');

describe('Cisco Meraki', () => {
  it('leest apparaten, WAN-adres van de MX en clients, alleen met GET', async () => {
    const { connector, transport } = demoConnector('meraki', NOW);
    const r = await connector.read();
    expect(r.devices.map((d) => [d.role, d.model, d.firmware])).toEqual([
      ['firewall', 'MX67', 'wired-18-211'],
      ['accesspoint', 'MR36', 'wireless-29-7'],
    ]);
    expect(r.wanIps).toEqual(['84.12.34.60']);
    expect(r.clients.map((c) => [c.hostname, c.vendor, c.connection])).toEqual([
      ['Camera-ingang', 'Hikvision', 'bekabeld'],
      ['Marks-iPad', 'Apple', 'draadloos'],
    ]);
    expect(transport.requests.every((q) => q.method === 'GET' && MERAKI_RULES.some((x) => x.path.test(q.path)))).toBe(true);
  });

  it('volgt geen redirect naar een andere host', async () => {
    const t = new FixtureTransport({ 'GET /api/v1/organizations': { status: 308, headers: { location: 'https://n123.meraki.com/api/v1/organizations' }, body: '' } });
    await expect(new MerakiConnector(t).read()).rejects.toThrow(/n123\.meraki\.com/);
  });

  it('deelt de clients in via de fabrikant die Meraki meldt', async () => {
    const r = await discover({
      connectors: [{ connector: demoConnector('meraki', NOW).connector, source: DEMO_SOURCES.meraki }],
      oui: demoOui(),
      vulnDb: demoVulnDb(),
      privacy: { ...DEFAULT_PRIVACY, pseudonymKey: DEMO_PSEUDONYM_KEY },
      now: NOW,
    });
    expect(r.assets.find((a) => a.attributes.name?.value === 'Camera-ingang')?.category).toBe('camera');
    expect(r.assets.find((a) => a.attributes.name?.value === '…-iPad')?.category).toBe('tablet');
  });
});

describe('end-of-life', () => {
  const asset = (attrs: Record<string, string>): InventoryAsset =>
    ({
      key: 'serial:X',
      kind: 'netwerkapparaat',
      category: 'router',
      exposure: 'intern',
      managed: 'onbekend',
      identifiers: [],
      conflicts: [],
      sourceIds: ['r'],
      firstSeen: '',
      lastSeen: '',
      status: 'actief',
      attributes: Object.fromEntries(Object.entries(attrs).map(([k, v]) => [k, { value: v, sourceId: 'r', sourceKind: 'netwerk', observedAt: '', certainty: 'vastgesteld' }])),
    }) as InventoryAsset;

  const db = demoEolDb();

  it('herkent hardware zonder updates en firmware in een afgelopen cyclus', () => {
    expect(db.check(asset({ vendor: 'DrayTek', model: 'Vigor2860n' }), NOW)).toEqual([
      { status: 'buiten-ondersteuning', what: 'hardware', date: '2024-12-31', source: 'voorbeeld', certainty: 'vastgesteld' },
    ]);
    expect(db.check(asset({ vendor: 'MikroTik', model: 'hAP ax2', os: 'RouterOS', firmware: '6.49.10' }), NOW)).toEqual([
      { status: 'buiten-ondersteuning', what: 'firmware', date: '2025-01-01', certainty: 'vastgesteld' },
    ]);
    expect(db.check(asset({ vendor: 'MikroTik', model: 'hAP ax2', os: 'RouterOS', firmware: '7.15.3' }), NOW)).toEqual([
      { status: 'ondersteund', what: 'firmware', date: undefined, certainty: 'vastgesteld' },
    ]);
    expect(db.check(asset({ vendor: 'MikroTik', model: 'RB750Gr3' }), NOW)[0]!.status).toBe('binnenkort');
    expect(new EolDb().check(asset({ vendor: 'X', model: 'Y' }), NOW)).toEqual([]);
  });

  it('laat EOL meetellen in de score', async () => {
    const r = await discover({
      connectors: [{ connector: demoConnector('mikrotik', NOW).connector, source: DEMO_SOURCES.mikrotik }],
      oui: demoOui(),
      vulnDb: demoVulnDb(),
      eolDb: db,
      privacy: { ...DEFAULT_PRIVACY, pseudonymKey: DEMO_PSEUDONYM_KEY },
      now: NOW,
    });
    expect(r.findings.map((f) => f.key).sort()).toEqual([
      'netwerkapparaat.einde_ondersteuning',
      'netwerkapparaat.einde_ondersteuning_binnenkort',
      'netwerkapparaat.kwetsbaarheid',
    ]);
    expect(r.score.topActions.map((a) => a.key)).toEqual(['firmware-bijwerken', 'apparaat-vervangen']);
  });
});
