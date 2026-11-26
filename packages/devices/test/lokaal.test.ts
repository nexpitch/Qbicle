import { describe, expect, it } from 'vitest';
import { OuiDb, parseTable } from '../src/index.ts';
import { locateIgd, mSearch, parseSsdpLocation, parseUpnpDescription } from '../src/connectors/ssdp.ts';
import { runLocal } from '../src/lokaal.ts';
import { deviceRows, parseNames, renderReport } from '../src/rapport.ts';
import { classifyClient } from '../src/classify.ts';
import { fixtureTransport } from '../src/demo.ts';

const OUI = OuiDb.fromCsv(
  [
    'Registry,Assignment,Organization Name,Organization Address',
    'MA-L,7C8BCA,"TP-LINK TECHNOLOGIES CO.,LTD.","Shenzhen CN"',
    'MA-L,882593,Arcadyan Corporation,"Hsinchu TW"',
    'MA-L,001BA9,"Brother industries, LTD.","Nagoya JP"',
    'MA-L,C056E3,"Hangzhou Hikvision Digital Technology Co.,Ltd.","Hangzhou CN"',
  ].join('\n'),
);

// Zoals `arp -a` op een Mac het geeft, met de multicast- en broadcastregels die macOS altijd toont.
const ARP = `? (192.168.2.254) at 88:25:93:1:2:3 on en0 ifscope [ethernet]
deco-m4.home (192.168.2.20) at 7c:8b:ca:aa:bb:1 on en0 ifscope [ethernet]
? (192.168.2.21) at 7c:8b:ca:aa:bb:2 on en0 ifscope [ethernet]
brn001ba9aabbcc.home (192.168.2.30) at 0:1b:a9:aa:bb:cc on en0 ifscope [ethernet]
? (192.168.2.40) at c0:56:e3:99:88:77 on en0 ifscope [ethernet]
? (192.168.2.41) at (incomplete) on en0 ifscope [ethernet]
? (192.168.2.255) at ff:ff:ff:ff:ff:ff on en0 ifscope [ethernet]
mdns.mcast.net (224.0.0.251) at 1:0:5e:0:0:fb on en0 ifscope permanent [ethernet]
`;

const NOW = new Date('2026-11-26T20:00:00Z');

describe('ARP-tabel van macOS', () => {
  it('slaat multicast, broadcast en onvolledige regels over', () => {
    const ips = parseTable({ format: 'arp-unix', content: ARP }).map((c) => c.ip);
    expect(ips).toEqual(['192.168.2.254', '192.168.2.20', '192.168.2.21', '192.168.2.30', '192.168.2.40']);
  });
});

describe('TP-Link Deco', () => {
  it('herkent een Deco aan de naam en aan de fabrikant als wifi-punt', () => {
    expect(classifyClient({ mac: '7c:8b:ca:aa:bb:01', hostname: 'deco-m4.home' }, OUI).category).toBe('accesspoint');
    expect(classifyClient({ mac: '7c:8b:ca:aa:bb:02' }, OUI).category).toBe('accesspoint');
  });
  it('een Tapo-camera of -stekker van TP-Link blijft een camera of slim apparaat', () => {
    expect(classifyClient({ mac: '7c:8b:ca:aa:bb:03', hostname: 'tapo-c200' }, OUI).category).toBe('camera');
    expect(classifyClient({ mac: '7c:8b:ca:aa:bb:04', hostname: 'Tapo_P100' }, OUI).category).toBe('iot');
  });
});

describe('SSDP', () => {
  it('neemt alleen een beschrijving op de gateway zelf aan', () => {
    const ok = 'HTTP/1.1 200 OK\r\nCACHE-CONTROL: max-age=120\r\nLOCATION: http://192.168.2.254:49152/rootDesc.xml\r\nST: x\r\n\r\n';
    expect(parseSsdpLocation(ok, '192.168.2.254')?.href).toBe('http://192.168.2.254:49152/rootDesc.xml');
    expect(parseSsdpLocation(ok.replace('192.168.2.254:', '203.0.113.9:'), '192.168.2.254')).toBeUndefined();
    expect(parseSsdpLocation(ok.replace('http://', 'file://'), '192.168.2.254')).toBeUndefined();
    expect(parseSsdpLocation('NOTIFY * HTTP/1.1\r\n', '192.168.2.254')).toBeUndefined();
    expect(mSearch('urn:x', '192.168.2.254')).toContain('MAN: "ssdp:discover"');
  });
  it('weigert een gateway buiten het eigen netwerk', async () => {
    await expect(locateIgd('8.8.8.8')).rejects.toThrow(/eigen netwerk/);
  });
});

describe('eerste test eigen netwerk', () => {
  const run = (locate: () => Promise<URL | undefined>) =>
    runLocal({
      gateway: '192.168.2.254',
      tables: [{ format: 'arp-unix', content: ARP }],
      oui: OUI,
      now: NOW,
      locate,
      transportFor: () => fixtureTransport('upnp'),
    });

  it('leest het KPN-modem via UPnP en zet de apparaten erachter in de lijst', async () => {
    const r = await run(async () => new URL('http://192.168.2.254:49152/rootDesc.xml'));
    expect(r.sources.every((s) => s.outcome !== 'error')).toBe(true);
    const rows = deviceRows(r);
    const modem = rows.find((x) => x.ip === '192.168.2.254')!;
    expect(modem.type).toBe('Modem van KPN');
    expect(rows.filter((x) => x.ip === '192.168.2.254')).toHaveLength(1);
    expect(rows.find((x) => x.ip === '192.168.2.20')!.type).toBe('Wifi-accesspoint');
    expect(rows.find((x) => x.ip === '192.168.2.30')!.type).toBe('Printer');
    expect(rows.find((x) => x.ip === '192.168.2.40')!.type).toBe('Camera');
    expect(r.findings.some((f) => f.key === 'netwerkapparaat.upnp_aan')).toBe(true);
    const html = renderReport(r, { generatedAt: NOW, pingSweep: false });
    expect(html).toContain('Modem van KPN');
    expect(html).toContain('Je netwerk in kaart');
    expect(html).not.toMatch(/<script[^>]*src=/);
  });

  it('werkt ook als het modem niet op UPnP antwoordt', async () => {
    const r = await run(async () => undefined);
    const rows = deviceRows(r);
    expect(rows.find((x) => x.ip === '192.168.2.254')!.vendor).toBe('Arcadyan');
    expect(rows).toHaveLength(5);
    expect(r.notes.join(' ')).toMatch(/UPnP/);
  });

  it('weigert een gateway met een publiek adres', async () => {
    await expect(runLocal({ gateway: '203.0.113.1', tables: [], oui: OUI })).rejects.toThrow(/eigen netwerk/);
  });
});

describe('meer herkenning (tweede ronde, na de eerste echte test)', () => {
  const bundled = OuiDb.bundled();

  it('levert het IEEE-register mee, ook zonder download', () => {
    expect(bundled.size).toBeGreaterThan(30000);
    expect(bundled.lookup('e0:98:06:00:00:01')).toMatch(/Espressif/);
    expect(bundled.lookup('d8:07:b6:00:00:01')).toMatch(/TP-LINK/i);
    expect(bundled.lookup('38:b4:d3:00:00:01')).toMatch(/BSH/);
  });

  it('herkent huishoudapparaten, robotstofzuigers, tv-ontvanger en kleine wifi-apparaten', () => {
    const cat = (mac: string, hostname?: string) => classifyClient({ mac, hostname }, bundled).category;
    expect(cat('38:b4:d3:c4:fd:6f', 'bosch-oven-383010532607002251')).toBe('iot');
    expect(cat('c8:d7:78:63:3e:4a', 'bosch-dishwasher-013010519588040195')).toBe('iot');
    expect(cat('b0:4a:39:8a:d8:4c', 'roborock-vacuum-a38')).toBe('iot');
    expect(cat('94:3c:96:25:a2:16', 'diw7022-25a216')).toBe('tv-media');
    expect(cat('f8:17:2d:a1:e9:d4', 'wlan0-4')).toBe('iot');
    expect(cat('e0:98:06:c8:a2:c4')).toBe('iot');
  });

  it('leest Bonjour van de Mac: diensten, model en fabrikant per IP', () => {
    const out = parseTable({
      format: 'dns-sd-macos',
      content: [
        '### L _ipp._tcp HP\\032LaserJet',
        '20:05:01.456  HP\\032LaserJet._ipp._tcp.local. can be reached at NPI2FABEA.local.:631 (interface 4)',
        ' txtvers=1 ty=HP\\ LaserJet\\ MFP\\ M234sdw usb_MFG=HP',
        '### G NPI2FABEA.local',
        '20:05:04.123  Add  40000002       4  NPI2FABEA.local.                       192.168.2.27                                 120',
      ].join('\n'),
    });
    expect(out).toEqual([expect.objectContaining({ ip: '192.168.2.27', hostname: 'npi2fabea', services: ['_ipp._tcp'], model: 'HP LaserJet MFP M234sdw', vendor: 'HP' })]);
  });

  it('leest fabrikant, model en type uit een UPnP-beschrijving', () => {
    const xml = '<root><device><deviceType>urn:schemas-upnp-org:device:ZonePlayer:1</deviceType><friendlyName>Woonkamer</friendlyName><manufacturer>Sonos, Inc.</manufacturer><modelName>Sonos One</modelName><modelNumber>S18</modelNumber><deviceList><device><manufacturer>x</manufacturer></device></deviceList></device></root>';
    expect(parseUpnpDescription(xml)).toEqual({ vendor: 'Sonos, Inc.', model: 'Sonos One S18', deviceType: 'ZonePlayer' });
  });

  it('neemt zelf gegeven namen over en zegt waarom iets onbekend blijft', async () => {
    const r = await runLocal({
      gateway: '192.168.2.254',
      tables: [{ format: 'arp-unix', content: '? (192.168.2.35) at 60:45:2e:4b:e4:cf on en0 ifscope [ethernet]\n? (192.168.2.36) at 5a:9b:81:00:00:01 on en0 ifscope [ethernet]\n' }],
      oui: bundled,
      now: NOW,
      locate: async () => undefined,
    });
    const before = deviceRows(r);
    expect(before.find((x) => x.ip === '192.168.2.35')!.whyUnknown).toMatch(/Intel/);
    expect(before.find((x) => x.ip === '192.168.2.36')!.whyUnknown).toMatch(/privacy-MAC/);
    const names = parseNames('# mac,naam,type\n60:45:2E:4B:E4:CF;Werklaptop;Laptop\nonzin\n');
    const after = deviceRows(r, names).find((x) => x.ip === '192.168.2.35')!;
    expect(after).toMatchObject({ name: 'Werklaptop', type: 'Laptop', certainty: 'Door jou opgegeven', risk: 'geen' });
    expect(after.sources).toContain('zelf benoemd');
  });
});
