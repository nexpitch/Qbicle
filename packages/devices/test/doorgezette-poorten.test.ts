import { describe, expect, it } from 'vitest';
import { DEFAULT_PRIVACY, FixtureTransport, FritzboxConnector, MERAKI_RULES, MerakiConnector, UnifiConnector, discover, forwardCoverage, type Readout } from '../src/index.ts';
import { DEMO_PSEUDONYM_KEY, DEMO_SOURCES, demoConnector, demoOui, demoVulnDb, fixtureTransport } from '../src/demo.ts';

/**
 * Open poorten naar internet, uitgelezen uit de router zelf (geen scan).
 * Eerlijke status: alleen "gecontroleerd" als de router de hele lijst gaf.
 */
const NOW = new Date('2026-11-26T12:00:00Z');
const privacy = { ...DEFAULT_PRIVACY, pseudonymKey: DEMO_PSEUDONYM_KEY };
const responses = (p: 'fritzbox' | 'meraki' | 'unifi') => ({ ...(fixtureTransport(p) as unknown as { responses: Record<string, unknown> }).responses }) as ConstructorParameters<typeof FixtureTransport>[0];

describe('FRITZ!Box: Portfreigaben', () => {
  it('leest de doorgezette poorten via TR-064', async () => {
    const r = await demoConnector('fritzbox', NOW).connector.read();
    expect(r.portForwardsRead).toBe(true);
    expect(r.portForwards).toEqual([
      expect.objectContaining({ protocol: 'tcp', externalPort: 8080, internalIp: '192.168.178.40', internalPort: 80, description: 'Camera ingang', origin: 'regel' }),
      expect.objectContaining({ protocol: 'tcp', externalPort: 3389, internalIp: '192.168.178.20', internalPort: 3389 }),
    ]);
  });

  it('valt terug op de DSL-verbinding (WANPPPConnection)', async () => {
    const res = responses('fritzbox');
    const count = res['POST /upnp/control/wanipconnection1#GetPortMappingNumberOfEntries'] as string;
    delete res['POST /upnp/control/wanipconnection1#GetPortMappingNumberOfEntries'];
    res['POST /upnp/control/wanpppconn1#GetPortMappingNumberOfEntries'] = count.replace('<NewPortMappingNumberOfEntries>2<', '<NewPortMappingNumberOfEntries>0<');
    const r = await new FritzboxConnector(new FixtureTransport(res), { now: () => NOW }).read();
    expect(r.portForwardsRead).toBe(true);
    expect(r.portForwards).toEqual([]);
  });

  it('zegt "niet uitgelezen" als de gebruiker het niet mag zien, nooit "niets open"', async () => {
    const res = responses('fritzbox');
    delete res['POST /upnp/control/wanipconnection1#GetPortMappingNumberOfEntries'];
    const r = await new FritzboxConnector(new FixtureTransport(res), { now: () => NOW }).read();
    expect(r.portForwardsRead).toBe(false);
    expect(r.warnings.join(' ')).toMatch(/niet uitgelezen/);
    expect(forwardCoverage([r]).status).toBe('niet_gecontroleerd');
  });
});

describe('Meraki: port forwarding en 1:1 NAT', () => {
  it('leest de regels per MX-netwerk, met alleen GET op de vaste lijst', async () => {
    const { connector, transport } = demoConnector('meraki', NOW);
    const r = await connector.read();
    expect(r.portForwardsRead).toBe(true);
    expect(r.portForwards).toEqual([
      expect.objectContaining({ externalPort: 8443, internalIp: '192.168.128.40', internalPort: 443, allowedFrom: undefined }),
      expect.objectContaining({ externalPort: 3389, internalIp: '192.168.128.10', allowedFrom: ['203.0.113.7'] }),
    ]);
    expect(transport.requests.every((q) => q.method === 'GET' && MERAKI_RULES.some((x) => x.path.test(q.path)))).toBe(true);
  });

  it('herkent 1:1 NAT met alle poorten open en poortbereiken', async () => {
    const res = responses('meraki');
    res['GET /api/v1/networks/N_1/appliance/firewall/portForwardingRules'] = JSON.stringify({ rules: [{ lanIp: '192.168.128.50', allowedIps: ['any'], protocol: 'tcp', publicPort: '8100-8102', localPort: '8100-8102' }] });
    res['GET /api/v1/networks/N_1/appliance/firewall/oneToOneNatRules'] = JSON.stringify({
      rules: [{ name: 'Server', lanIp: '192.168.128.20', publicIp: '84.12.34.61', allowedInbound: [{ protocol: 'any', destinationPorts: ['any'], allowedIps: ['any'] }, { protocol: 'icmp-ping', allowedIps: ['any'] }] }],
    });
    const r = await new MerakiConnector(new FixtureTransport(res), { now: () => NOW }).read();
    expect(r.portForwards!.map((f) => (f.allPorts ? `alle->${f.internalIp}` : `${f.externalPort}->${f.internalPort}`))).toEqual(['8100->8100', '8101->8101', '8102->8102', 'alle->192.168.128.20']);
  });
});

describe('UniFi: port forwarding', () => {
  it('leest de klassieke lijst met dezelfde API-sleutel en slaat uitgeschakelde regels niet over in de lijst', async () => {
    const r = await demoConnector('unifi', NOW).connector.read();
    expect(r.portForwardsRead).toBe(true);
    expect(r.portForwards!.map((f) => [f.externalPort, f.internalIp, f.internalPort, f.enabled])).toEqual([
      [8443, '192.168.1.40', 443, true],
      [21, '192.168.1.40', 21, false],
    ]);
  });

  it('oudere versie of sleutel zonder toegang: niet gecontroleerd, de rest gaat door', async () => {
    const res = responses('unifi');
    res['GET /proxy/network/api/s/default/rest/portforward'] = { status: 401, headers: {}, body: '' };
    const r = await new UnifiConnector(new FixtureTransport(res), { now: () => NOW }).read();
    expect(r.portForwardsRead).toBe(false);
    expect(r.devices.length).toBeGreaterThan(0);
    expect(r.warnings.join(' ')).toMatch(/Doorgezette poorten niet uitgelezen/);
  });
});

describe('bevindingen in gewone taal', () => {
  it('camera en extern bureaublad open naar internet, met stappen om te sluiten', async () => {
    const r = await discover({ connectors: [{ connector: demoConnector('fritzbox', NOW).connector, source: DEMO_SOURCES.fritzbox }], oui: demoOui(), vulnDb: demoVulnDb(), privacy, now: NOW });
    const open = r.findings.filter((f) => f.checkKey === 'inventaris.doorgezette_poorten');
    expect(open.map((f) => f.title)).toEqual([
      'Je camera (Hikvision) is vanaf internet bereikbaar via de beheerpagina',
      'Je laptop (Intel) is vanaf internet bereikbaar via Extern bureaublad (RDP)',
    ]);
    expect(open[0]!.detail).toMatch(/Internet > Freigaben > Portfreigaben/);
    expect(open[0]!.detail).toMatch(/Iedereen op internet/);
    expect(open[0]!.detail).toMatch(/Opnieuw controleren/);
    expect(open.every((f) => f.certainty === 'vastgesteld' && f.z === 1)).toBe(true);
  });

  it('een regel die alleen voor vaste adressen open staat telt minder zwaar', async () => {
    const r = await discover({ connectors: [{ connector: demoConnector('meraki', NOW).connector, source: DEMO_SOURCES.meraki }], oui: demoOui(), vulnDb: demoVulnDb(), privacy, now: NOW });
    const rdp = r.findings.find((f) => f.title.includes('RDP'))!;
    expect(rdp.title).toMatch(/beperkt aantal adressen/);
    expect(rdp.detail).toMatch(/Alleen bereikbaar vanaf 203\.0\.113\.7/);
    expect(rdp.detail).toMatch(/Security & SD-WAN/);
    expect(rdp.z).toBe(0.5);
  });
});

describe('eerlijke status', () => {
  const base: Readout = { product: 'fritzbox', readAt: NOW.toISOString(), devices: [], clients: [], wanIps: [], warnings: [] };
  it('zonder router: niet gecontroleerd', () => {
    expect(forwardCoverage([]).status).toBe('niet_gecontroleerd');
  });
  it('alle routers gaven de lijst: gecontroleerd', () => {
    expect(forwardCoverage([{ ...base, portForwardsRead: true }]).status).toBe('gecontroleerd');
  });
  it('een router niet: deels', () => {
    expect(forwardCoverage([{ ...base, portForwardsRead: true }, { ...base, product: 'unifi' }])).toMatchObject({ status: 'deels', nietUitgelezen: ['unifi'] });
  });
  it('achter het providermodem (dubbele NAT): deels, want het modem kan ook doorzetten', () => {
    expect(forwardCoverage([{ ...base, portForwardsRead: true, privateWanIp: '192.168.2.10' }]).status).toBe('deels');
  });
});
