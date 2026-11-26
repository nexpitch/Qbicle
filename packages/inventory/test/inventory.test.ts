import { describe, expect, it } from 'vitest';
import {
  buildInventory,
  exposureFactor,
  fromScanAsset,
  inventoryFindings,
  isRandomizedMac,
  normalizeIdentifier,
  strengthOf,
  toScanTargets,
  type Observation,
} from '../src/index.ts';
import { NOW, connector, entra, fritz, intune, laptopViaDrieBronnen, printer, unifi } from './fixtures.ts';

describe('identifiers', () => {
  it('normaliseert MAC-adressen in elk gangbaar formaat', () => {
    for (const raw of ['3C-22-FB-12-34-56', '3c22.fb12.3456', '3c22fb123456', '3C:22:FB:12:34:56']) {
      expect(normalizeIdentifier({ type: 'mac', value: raw })).toEqual({ type: 'mac', value: '3c:22:fb:12:34:56' });
    }
    expect(normalizeIdentifier({ type: 'mac', value: 'ff:ff:ff:ff:ff:ff' })).toBeUndefined();
    expect(normalizeIdentifier({ type: 'mac', value: 'geen-mac' })).toBeUndefined();
  });

  it('herkent willekeurige (privacy-)MAC-adressen als zwak', () => {
    expect(isRandomizedMac('da:a1:19:00:11:22')).toBe(true);
    expect(isRandomizedMac('3c:22:fb:12:34:56')).toBe(false);
    expect(strengthOf({ type: 'mac', value: 'da:a1:19:00:11:22' })).toBe('zwak');
    expect(strengthOf({ type: 'mac', value: '3c:22:fb:12:34:56' })).toBe('sterk');
  });

  it('gooit opvul-serienummers weg en kort hostnamen in', () => {
    expect(normalizeIdentifier({ type: 'serial', value: 'To be filled by O.E.M.' })).toBeUndefined();
    expect(normalizeIdentifier({ type: 'hostname', value: 'Printer-Hal.local.' })).toEqual({ type: 'hostname', value: 'printer-hal' });
  });
});

describe('samenvoegen', () => {
  it('maakt van drie bronnen over dezelfde laptop één asset', () => {
    const [laptop, ...rest] = buildInventory(laptopViaDrieBronnen, { now: NOW });
    expect(rest).toHaveLength(0);
    expect(laptop!.key).toBe('serial:PF3ABC12');
    expect(laptop!.sourceIds).toEqual(['entra', 'intune', 'unifi-utrecht']);
    expect(laptop!.managed).toBe('ja');
    expect(laptop!.category).toBe('laptop');
    expect(laptop!.exposure).toBe('intern');
  });

  it('laat Intune winnen van Entra en bewaart het verschil', () => {
    const [laptop] = buildInventory(laptopViaDrieBronnen, { now: NOW });
    expect(laptop!.attributes.osVersion).toMatchObject({ value: '10.0.22631', sourceId: 'intune' });
    expect(laptop!.attributes.vendor).toMatchObject({ value: 'Intel', sourceId: 'unifi-utrecht' });
    expect(laptop!.conflicts).toContainEqual({ key: 'osVersion', losing: expect.objectContaining({ value: '10.0.22621', sourceId: 'entra' }) });
  });

  it('koppelt een mDNS-aankondiging via hostnaam + IP aan de printer en leidt de categorie af', () => {
    const [p, ...rest] = buildInventory(printer, { now: NOW });
    expect(rest).toHaveLength(0);
    expect(p!.key).toBe('mac:00:1b:a9:aa:bb:cc');
    expect(p!.category).toBe('printer');
    expect(p!.attributes.category).toMatchObject({ certainty: 'mogelijk', sourceId: 'afleiding' });
  });

  it('voegt zwakke identifiers niet samen buiten het tijdvenster', () => {
    const later: Observation = {
      ...printer[1]!,
      observedAt: '2026-11-29T11:00:00Z',
    };
    const assets = buildInventory([printer[0]!, later], { now: NOW });
    expect(assets).toHaveLength(2);
  });

  it('voegt dezelfde hostnaam en hetzelfde privé-IP in twee kantoren niet samen', () => {
    const nas = (source: typeof unifi): Observation => ({
      source,
      observedAt: '2026-11-26T10:00:00Z',
      identifiers: [
        { type: 'hostname', value: 'nas' },
        { type: 'ip', value: '192.168.1.10' },
      ],
      attributes: { exposure: 'intern' },
    });
    expect(buildInventory([nas(unifi), nas(fritz)], { now: NOW })).toHaveLength(2);
  });

  it('voegt telefoons met wisselende privacy-MAC niet samen op alleen de naam', () => {
    const phone = (mac: string, ip: string, at: string): Observation => ({
      source: unifi,
      observedAt: at,
      identifiers: [
        { type: 'mac', value: mac },
        { type: 'hostname', value: 'iPhone' },
        { type: 'ip', value: ip },
      ],
      attributes: { os: 'iOS 18', exposure: 'intern' },
    });
    const assets = buildInventory(
      [phone('da:a1:19:00:11:22', '192.168.1.50', '2026-11-20T10:00:00Z'), phone('6e:01:02:03:04:05', '192.168.1.51', '2026-11-26T10:00:00Z')],
      { now: NOW },
    );
    expect(assets).toHaveLength(2);
    expect(assets.every((a) => a.category === 'telefoon')).toBe(true);
  });

  it('houdt twee laptops met een gedeelde USB-netwerkadapter apart (verschillende serienummers)', () => {
    const laptop = (serial: string): Observation => ({
      source: intune,
      observedAt: '2026-11-26T08:00:00Z',
      identifiers: [
        { type: 'serial', value: serial },
        { type: 'mac', value: '00:e0:4c:68:00:01' },
      ],
      attributes: { category: 'laptop', exposure: 'intern' },
    });
    expect(buildInventory([laptop('AAA111'), laptop('BBB222')], { now: NOW })).toHaveLength(2);
  });

  it('markeert een asset dat 30 dagen niet gezien is als verdwenen', () => {
    const oud: Observation = {
      source: connector,
      observedAt: '2026-10-01T10:00:00Z',
      identifiers: [{ type: 'mac', value: '00:11:22:33:44:99' }],
      attributes: {},
    };
    expect(buildInventory([oud], { now: NOW })[0]!.status).toBe('verdwenen');
  });
});

describe('bevindingen uit de inventaris', () => {
  const gastLaptop: Observation = {
    source: unifi,
    observedAt: '2026-11-26T10:00:00Z',
    identifiers: [
      { type: 'mac', value: '00:11:22:33:44:55' },
      { type: 'hostname', value: 'DESKTOP-GAST' },
    ],
    attributes: { category: 'laptop', exposure: 'intern' },
    certainty: 'mogelijk',
  };
  const admin: Observation = {
    source: entra,
    observedAt: '2026-11-26T09:00:00Z',
    identifiers: [{ type: 'upn', value: 'Beheer@Bakker.nl' }],
    attributes: { kind: 'account', name: 'beheer@bakker.nl', admin: true, mfa: false },
  };

  it('meldt een laptop die niet in Intune staat, een admin zonder MFA en achterstallige updates', () => {
    const oudePatch: Observation = {
      ...laptopViaDrieBronnen[0]!,
      attributes: { ...laptopViaDrieBronnen[0]!.attributes, lastPatched: '2026-08-01T00:00:00Z' },
    };
    const assets = buildInventory([oudePatch, gastLaptop, admin, ...printer], { now: NOW });
    const keys = inventoryFindings(assets, { now: NOW }).map((f) => `${f.key}@${f.assetKey}`);
    expect(keys).toEqual(
      expect.arrayContaining([
        'apparaat.onbeheerd@mac:00:11:22:33:44:55',
        'account.admin_zonder_mfa@upn:beheer@bakker.nl',
        'apparaat.updates_achter@serial:PF3ABC12',
      ]),
    );
    // De printer is geen eindgebruikersapparaat: daarvoor melden we niet "onbeheerd".
    expect(keys.some((k) => k.includes('00:1b:a9'))).toBe(false);
  });

  it('meldt "onbeheerd" niet als er geen beheertool gekoppeld is', () => {
    const assets = buildInventory([gastLaptop], { now: NOW });
    expect(assets[0]!.managed).toBe('onbekend');
    expect(inventoryFindings(assets, { now: NOW })).toHaveLength(0);
  });

  it('geeft een voorlopige factor z per blootstelling', () => {
    expect(exposureFactor('internet', 'onbekend')).toBe(1.0);
    expect(exposureFactor('intern', 'ja')).toBe(0.4);
    expect(exposureFactor('intern', 'nee')).toBe(0.6);
  });
});

describe('koppeling met de scanner', () => {
  it('neemt gescande assets op en geeft nieuwe internetgerichte assets terug als doel', () => {
    const wan: Observation = {
      source: unifi,
      observedAt: '2026-11-26T10:00:00Z',
      identifiers: [{ type: 'ip', value: '84.12.34.56' }],
      attributes: { kind: 'ip-adres', exposure: 'internet', name: 'WAN kantoor Utrecht' },
    };
    const website = fromScanAsset(
      { type: 'website', value: 'https://www.bakker.nl', source: 'opgegeven', visibility: 'primair' },
      '2026-11-26T07:00:00Z',
    );
    const assets = buildInventory([wan, website, ...printer], { now: NOW });
    expect(assets.find((a) => a.kind === 'website')?.exposure).toBe('internet');
    expect(toScanTargets(assets)).toEqual([
      { type: 'host', value: '84.12.34.56', source: 'inventaris:unifi-utrecht', visibility: 'primair' },
    ]);
  });
});
