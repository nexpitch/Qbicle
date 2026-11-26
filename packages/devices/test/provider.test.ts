import { describe, expect, it } from 'vitest';
import { DEFAULT_PRIVACY, FixtureTransport, HttpTransport, UPNP_RULES, UpnpIgdConnector, discover, expandPorts, identifyProviderModem } from '../src/index.ts';
import { DEMO_PSEUDONYM_KEY, DEMO_SOURCES, demoBehindModem, demoConnector, demoOui, demoVulnDb } from '../src/demo.ts';

const NOW = new Date('2026-11-26T12:00:00Z');
const privacy = { ...DEFAULT_PRIVACY, pseudonymKey: DEMO_PSEUDONYM_KEY };

describe('providermodem via UPnP (zonder providerlogin)', () => {
  it('leest model, WAN-adres en door UPnP geopende poorten', async () => {
    const { connector, transport } = demoConnector('upnp', NOW);
    const r = await connector.read();
    expect(r.devices[0]).toMatchObject({ vendor: 'Arcadyan', model: 'Experia Box v10', provider: 'KPN', serial: 'EXP0000001' });
    expect(r.wanIps).toEqual(['84.12.34.70']);
    expect(r.upnpEnabled).toBe(true);
    expect(r.portForwards?.map((f) => `${f.protocol}/${f.externalPort}->${f.internalIp}:${f.internalPort}`)).toEqual([
      'tcp/8000->192.168.2.40:80',
      'tcp/3389->192.168.2.10:3389',
      'udp/3074->192.168.2.50:3074',
    ]);
    // Alleen de beschrijving en de twee leesacties; geen AddPortMapping of iets anders.
    expect(transport.requests.every((q) => UPNP_RULES.some((x) => x.method === q.method && x.path.test(q.path)))).toBe(true);
    expect(transport.requests.filter((q) => q.method === 'POST').every((q) => /#(GetExternalIPAddress|GetGenericPortMappingEntry)"$/.test(q.headers!.SOAPAction!))).toBe(true);
  });

  it('weigert schrijfacties zoals AddPortMapping', async () => {
    const inner = new FixtureTransport({});
    const c = new UpnpIgdConnector(inner, { descriptionPath: '/rootDesc.xml' });
    const guard = (c as unknown as { t: { send: HttpTransport['send'] } }).t;
    await expect(
      guard.send({ method: 'POST', path: '/ctl/IPConn', headers: { SOAPAction: '"urn:schemas-upnp-org:service:WANIPConnection:1#AddPortMapping"' } }),
    ).rejects.toMatchObject({ code: 'niet_toegestaan' });
    expect(() => new UpnpIgdConnector(inner, { descriptionPath: '/../etc/passwd.xml' })).toThrow();
    expect(inner.requests).toHaveLength(0);
  });

  it('mag over http praten zolang er geen inloggegevens meegaan', () => {
    expect(() => new HttpTransport({ baseUrl: 'http://192.168.2.254:49152', tls: { mode: 'systeem' } })).not.toThrow();
  });

  it('herkent providermodems aan model, fabrikant of netwerkeigenaar', () => {
    expect(identifyProviderModem({ model: 'Connect Box CH7465LG' })).toMatchObject({ provider: 'Ziggo', certainty: 'vastgesteld' });
    expect(identifyProviderModem({ friendlyName: 'KPN Box 12' })).toMatchObject({ provider: 'KPN' });
    expect(identifyProviderModem({ vendor: 'Sagemcom Broadband SAS', wanAsn: 33915 })).toMatchObject({ provider: 'Ziggo', certainty: 'mogelijk' });
    expect(identifyProviderModem({ vendor: 'Sagemcom Broadband SAS' })).toMatchObject({ provider: undefined, certainty: 'mogelijk' });
    expect(identifyProviderModem({ vendor: 'AVM', model: 'FRITZ!Box 7590' })).toBeUndefined();
  });
});

describe('modem plus apparaten erachter', () => {
  it('koppelt doorgezette poorten aan de apparaten die de connector ziet', async () => {
    const r = await discover({
      connectors: [{ connector: demoConnector('upnp', NOW).connector, source: DEMO_SOURCES.upnp }, demoBehindModem(NOW)],
      oui: demoOui(),
      vulnDb: demoVulnDb(),
      privacy,
      now: NOW,
    });
    const f = r.findings.map((x) => [x.key, x.asset.value, x.title]);
    expect(f).toEqual(
      expect.arrayContaining([
        ['apparaat.beheerpoort_open_naar_internet', 'mac:c0:56:e3:99:88:77', 'Je camera (Hikvision) is vanaf internet bereikbaar via de beheerpagina'],
        ['apparaat.beheerpoort_open_naar_internet', 'mac:a4:c3:f0:77:88:99', 'Je computer (Intel) is vanaf internet bereikbaar via Extern bureaublad (RDP)'],
        ['apparaat.poort_open_naar_internet', 'serial:EXP0000001', 'Een poort van een apparaat op 192.168.2.50 staat open naar internet'],
        ['netwerkapparaat.upnp_aan', 'serial:EXP0000001', 'Op je router staat UPnP aan: apparaten kunnen zelf poorten naar internet openzetten'],
      ]),
    );
    expect(r.score.topActions[0]!.key).toBe('poort-sluiten');
    expect(r.score.contributions.find((c) => c.key === 'apparaat.beheerpoort_open_naar_internet')).toMatchObject({ z: 1, k: 1 });
  });

  it('meldt dubbele NAT als de interne router achter het modem staat', async () => {
    const responses = JSON.parse(JSON.stringify((demoConnector('mikrotik', NOW).transport as unknown as { responses: Record<string, string> }).responses));
    responses['GET /rest/ip/address'] = JSON.stringify([
      { address: '192.168.88.1/24', interface: 'bridge', disabled: 'false' },
      { address: '192.168.2.2/24', interface: 'ether1', disabled: 'false' },
    ]);
    const { MikrotikConnector } = await import('../src/index.ts');
    const r = await discover({
      connectors: [{ connector: new MikrotikConnector(new FixtureTransport(responses), { now: () => NOW }), source: DEMO_SOURCES.mikrotik }],
      oui: demoOui(),
      vulnDb: demoVulnDb(),
      privacy,
      now: NOW,
    });
    expect(r.readouts[0]!.privateWanIp).toBe('192.168.2.2');
    expect(r.readouts[0]!.warnings.join(' ')).toMatch(/dubbele NAT/);
  });

  it('leest doorgezette poorten uit MikroTik-NAT-regels, uitgeschakelde regels niet', async () => {
    const r = await demoConnector('mikrotik', NOW).connector.read();
    expect(r.portForwards?.filter((f) => f.enabled).map((f) => f.externalPort)).toEqual([8291]);
    expect(r.upnpEnabled).toBe(false);
    expect(expandPorts('80,443,8000-8002')).toEqual([80, 443, 8000, 8001, 8002]);
  });
});
