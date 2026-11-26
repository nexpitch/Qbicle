import type { InventoryAsset } from '@qbicle/inventory';
import { describe, expect, it } from 'vitest';
import { VulnDb, buildCpe, compareVersions, componentsFor, inRange, parseCpe, type Component } from '../src/index.ts';
import { demoVulnDb } from '../src/demo.ts';

describe('versies', () => {
  it('vergelijkt per segment, numeriek', () => {
    expect(compareVersions('7.10', '7.9')).toBe(1);
    expect(compareVersions('6.40.5', '6.42')).toBe(-1);
    expect(compareVersions('7.0', '7')).toBe(0);
    expect(compareVersions('7.57a', '7.57')).toBe(1);
    expect(compareVersions('v4.0.6', '4.0.6')).toBe(0);
  });

  it('kent de vier NVD-grenzen', () => {
    expect(inRange('6.42', { versionEndIncluding: '6.42' })).toBe(true);
    expect(inRange('6.42', { versionEndExcluding: '6.42' })).toBe(false);
    expect(inRange('7.0', { versionStartIncluding: '7.0', versionEndExcluding: '7.12' })).toBe(true);
    expect(inRange('7.0', { versionStartExcluding: '7.0' })).toBe(false);
  });
});

describe('CPE', () => {
  it('bouwt en leest CPE 2.3 met escapes', () => {
    const cpe = buildCpe('o', 'avm', 'fritz!os', '7.29');
    expect(cpe).toBe('cpe:2.3:o:avm:fritz\\!os:7.29:*:*:*:*:*:*:*');
    expect(parseCpe(cpe)).toEqual({ part: 'o', vendor: 'avm', product: 'fritz\\!os', version: '7.29' });
  });

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
      attributes: Object.fromEntries(
        Object.entries(attrs).map(([k, v]) => [k, { value: v, sourceId: 'r', sourceKind: 'netwerk', observedAt: '', certainty: 'vastgesteld' }]),
      ),
    }) as InventoryAsset;

  it('vertaalt wat routers melden naar CPE (vertaaltabel)', () => {
    expect(componentsFor(asset({ vendor: 'MikroTik', os: 'RouterOS', firmware: '6.40.5' }))[0]).toMatchObject({
      cpe: 'cpe:2.3:o:mikrotik:routeros:6.40.5:*:*:*:*:*:*:*',
      cpeCertainty: 'vastgesteld',
    });
    expect(componentsFor(asset({ vendor: 'AVM', os: 'FRITZ!OS', firmware: '154.07.29' }))[0]).toMatchObject({ version: '7.29', cpeCertainty: 'vastgesteld' });
    expect(componentsFor(asset({ vendor: 'Ubiquiti', model: 'U6 Pro', firmware: '6.6.55' }))[0]).toMatchObject({
      cpe: 'cpe:2.3:o:ui:u6_pro_firmware:6.6.55:*:*:*:*:*:*:*',
      cpeCertainty: 'mogelijk',
    });
    expect(componentsFor(asset({ vendor: 'Onbekend merk', firmware: '1.0' }))).toEqual([]);
  });
});

describe('koppeling aan CVE, KEV en NCSC', () => {
  const db = demoVulnDb();
  const comp = (cpe: string, version: string | undefined, cpeCertainty: Component['cpeCertainty'] = 'vastgesteld'): Component => ({
    assetKey: 'a',
    kind: 'firmware',
    vendor: 'x',
    product: 'x',
    version,
    cpe,
    cpeCertainty,
    sourceId: 'r',
  });

  it('koppelt een exacte versie in het bereik als vastgesteld, met KEV', () => {
    const [hit, ...rest] = db.match([comp(buildCpe('o', 'mikrotik', 'routeros', '6.40.5'), '6.40.5')]);
    expect(rest).toHaveLength(0);
    expect(hit).toMatchObject({ certainty: 'vastgesteld', cve: { id: 'CVE-2018-14847' }, linked: { inKev: true, cvss: 9.1 } });
  });

  it('koppelt niet buiten het bereik', () => {
    expect(db.match([comp(buildCpe('o', 'mikrotik', 'routeros', '7.12'), '7.12')])).toEqual([]);
    expect(db.match([comp(buildCpe('o', 'mikrotik', 'routeros', '7.11.2'), '7.11.2')]).map((v) => v.cve.id)).toEqual(['CVE-2099-1002']);
  });

  it('neemt het NCSC-advies mee als factor (kans hoog)', () => {
    const [hit] = db.match([comp(buildCpe('o', 'avm', 'fritz!os', '7.29'), '7.29')]);
    expect(hit).toMatchObject({ cve: { id: 'CVE-2099-1001' }, ncsc: { id: 'NCSC-2099-0001' }, linked: { ncscHigh: true, inKev: false } });
  });

  it('zonder versie: alleen actief misbruikte lekken, en dan "mogelijk"', () => {
    const hits = db.match([comp(buildCpe('o', 'mikrotik', 'routeros'), undefined, 'mogelijk')]);
    expect(hits.map((h) => [h.cve.id, h.certainty])).toEqual([['CVE-2018-14847', 'mogelijk']]);
  });

  it('leest EPSS', () => {
    const d = new VulnDb();
    d.addNvd({ vulnerabilities: [] });
    expect(d.addEpssCsv('#model_version:v2025.03.14,score_date:2026-11-26\ncve,epss,percentile\nCVE-2018-14847,0.94,0.99\n')).toBe(1);
  });
});
