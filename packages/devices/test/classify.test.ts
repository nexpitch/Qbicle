import { describe, expect, it } from 'vitest';
import { OuiDb, classifyClient, shortVendor } from '../src/index.ts';
import { demoOui } from '../src/demo.ts';

const oui = demoOui();

describe('MAC-prefixregister', () => {
  it('leest het IEEE-formaat, ook met komma\'s tussen aanhalingstekens', () => {
    expect(oui.lookup('00-1B-A9-AA-BB-CC')).toBe('Brother industries, LTD.');
    expect(oui.lookup('c0:56:e3:00:00:01')).toBe('Hangzhou Hikvision Digital Technology Co.,Ltd.');
  });

  it('kiest de langste prefix (MA-S boven MA-L)', () => {
    const db = OuiDb.fromCsv('Registry,Assignment,Organization Name,Organization Address\nMA-L,70B3D5,IEEE Registration Authority,x\nMA-S,70B3D5123,Kleine Fabrikant BV,y\n');
    expect(db.lookup('70:b3:d5:12:34:56')).toBe('Kleine Fabrikant BV');
    expect(db.lookup('70:b3:d5:99:34:56')).toBe('IEEE Registration Authority');
  });

  it('zoekt een privacy-MAC niet op: die heeft geen fabrikant', () => {
    expect(OuiDb.fromCsv('Registry,Assignment,Organization Name,Organization Address\nMA-L,DAA119,Niet echt,x\n').lookup('da:a1:19:00:11:22')).toBeUndefined();
  });
});

describe('indeling in categorieën', () => {
  const cases: Array<[string, Parameters<typeof classifyClient>[0], string]> = [
    ['printer via MAC-prefix en hostnaam', { mac: '00:1b:a9:aa:bb:cc', hostname: 'BRN001BA9AABBCC' }, 'printer'],
    ['printer via mDNS', { hostname: 'kantoorprinter-hal', services: ['_ipp._tcp'] }, 'printer'],
    ['camera via fabrikant', { mac: 'c0:56:e3:00:00:09' }, 'camera'],
    ['camera via model', { model: 'DS-2CD2143G2-I' }, 'camera'],
    ['slimme speaker', { hostname: 'Echo-Dot-Kantine' }, 'slimme-speaker'],
    ['Sonos', { mac: '00:0e:58:ab:cd:ef', hostname: 'Sonos-Kantoor' }, 'slimme-speaker'],
    ['zonnepanelen (SMA)', { mac: '00:40:ad:01:02:03', hostname: 'SMA3004123456' }, 'zonnepanelen'],
    ['zonnepanelen (Enphase Envoy)', { hostname: 'envoy' }, 'zonnepanelen'],
    ['laadpaal', { hostname: 'EASEE-EH123456' }, 'laadpaal'],
    ['laadpaal (Alfen als fabrikant van de router)', { vendor: 'Alfen B.V.' }, 'laadpaal'],
    ['alarmsysteem', { vendor: 'Ajax Systems Inc', hostname: 'Hub-2-Plus' }, 'alarmsysteem'],
    ['IoT (Shelly op Espressif)', { mac: '24:0a:c4:aa:00:01', hostname: 'shelly1pm-A1B2C3' }, 'iot'],
    ['NAS', { mac: '00:11:32:0a:0b:0c', hostname: 'DiskStation' }, 'nas'],
    ['telefoon', { hostname: 'Galaxy-S23' }, 'telefoon'],
    ['telefoon met privacy-MAC', { mac: 'da:a1:19:00:11:22', hostname: 'iPhone' }, 'telefoon'],
    ['tablet', { hostname: 'iPad-receptie' }, 'tablet'],
    ['laptop', { mac: '3c:22:fb:12:34:56', hostname: 'Annes-MacBook-Pro' }, 'laptop'],
    ['desktop', { hostname: 'DESKTOP-7H3K2LQ' }, 'desktop'],
    ['tv', { hostname: 'LGwebOSTV' }, 'tv-media'],
    ['server', { hostname: 'SRV-DC01' }, 'server'],
  ];
  for (const [name, input, expected] of cases) {
    it(name, () => {
      const c = classifyClient(input, oui);
      expect(c.category).toBe(expected);
      expect(c.certainty).toBe('mogelijk');
      expect(c.reasons.length).toBeGreaterThan(0);
    });
  }

  it('zegt "onbekend" bij te weinig aanwijzingen, niet een gok', () => {
    expect(classifyClient({ mac: '12:34:56:78:9a:bc' }, oui)).toMatchObject({ category: 'onbekend', certainty: 'onbekend' });
    expect(classifyClient({ mac: '3c:22:fb:00:00:01' }, oui)).toMatchObject({ category: 'onbekend' }); // alleen "Apple" is te weinig
  });

  it('geeft de fabrikant terug met herkomst', () => {
    expect(classifyClient({ mac: '00:40:ad:01:02:03' }, oui)).toMatchObject({ vendor: 'SMA Regelsysteme GmbH', vendorSource: 'mac-prefix' });
    expect(classifyClient({ mac: '00:40:ad:01:02:03', vendor: 'SMA' }, oui)).toMatchObject({ vendorSource: 'router' });
  });

  it('kort fabrikantnamen in voor de uitleg', () => {
    expect(shortVendor('Hangzhou Hikvision Digital Technology Co.,Ltd.')).toBe('Hikvision');
    expect(shortVendor('Synology Incorporated')).toBe('Synology Incorporated');
    expect(shortVendor('Sonos, Inc.')).toBe('Sonos');
  });
});
