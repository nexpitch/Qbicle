import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import {
  ConnectorError,
  FixtureTransport,
  FritzboxConnector,
  HttpTransport,
  MikrotikConnector,
  ReadOnlyGuard,
  Secret,
  UNIFI_RULES,
  UnifiConnector,
  fritzOsVersion,
  lastSeenFrom,
  parseDigestChallenge,
} from '../src/index.ts';
import { demoConnector, fixtureTransport } from '../src/demo.ts';

const NOW = new Date('2026-11-26T12:00:00Z');

describe('UniFi', () => {
  it('leest gateway, accesspoint en clients uit, zonder VPN-clients', async () => {
    const { connector } = demoConnector('unifi', NOW);
    const r = await connector.read();
    expect(r.devices.map((d) => [d.role, d.model, d.firmware, d.updateAvailable])).toEqual([
      ['gateway', 'UDM Pro', '4.0.6', false],
      ['accesspoint', 'U6 Pro', '6.6.55', true],
    ]);
    expect(r.clients).toHaveLength(4);
    expect(r.clients.find((c) => c.hostname === 'iPhone')).toMatchObject({ guest: true, connection: 'draadloos' });
  });

  it('doet alleen GET-verzoeken op de vaste lijst', async () => {
    const { connector, transport } = demoConnector('unifi', NOW);
    await connector.read();
    expect(transport.requests.every((q) => q.method === 'GET' && UNIFI_RULES.some((r) => r.path.test(q.path)))).toBe(true);
  });

  it('bladert door pagina\'s tot alle clients binnen zijn', async () => {
    const base = '/proxy/network/integration/v1/sites';
    const page = (data: unknown[], total: number) => JSON.stringify({ offset: 0, limit: 200, count: data.length, totalCount: total, data });
    const clients = Array.from({ length: 250 }, (_, i) => ({ id: `c${i}`, type: 'WIRED', macAddress: `00:11:22:33:${(i >> 8).toString(16).padStart(2, '0')}:${(i & 255).toString(16).padStart(2, '0')}` }));
    const t = new FixtureTransport({
      [`GET ${base}?offset=0&limit=200`]: page([{ id: 's1' }], 1),
      [`GET ${base}/s1/devices?offset=0&limit=200`]: page([], 0),
      [`GET ${base}/s1/clients?offset=0&limit=200`]: page(clients.slice(0, 200), 250),
      [`GET ${base}/s1/clients?offset=200&limit=200`]: page(clients.slice(200), 250),
    });
    const r = await new UnifiConnector(t, { now: () => NOW }).read();
    expect(r.clients).toHaveLength(250);
  });
});

describe('FRITZ!Box', () => {
  it('leest model, FRITZ!OS, update, WAN-adres en de apparatenlijst', async () => {
    const r = await demoConnector('fritzbox', NOW).connector.read();
    expect(r.devices[0]).toMatchObject({ role: 'router', vendor: 'AVM', model: 'FRITZ!Box 7590', firmware: '154.07.29', updateAvailable: true });
    expect(r.wanIps).toEqual(['84.12.34.56']);
    expect(r.clients).toHaveLength(13);
    expect(r.clients.filter((c) => c.guest).map((c) => c.hostname)).toEqual(['Pieters-MacBook', 'Galaxy-S23']);
    expect(r.clients.find((c) => c.hostname === 'DiskStation')?.active).toBe(false);
  });

  it('stuurt alleen leesacties en haalt de lijst op het opgegeven pad', async () => {
    const { connector, transport } = demoConnector('fritzbox', NOW);
    await connector.read();
    expect(transport.requests.map((q) => q.headers?.SOAPAction ?? `${q.method} ${q.path}`)).toEqual([
      '"urn:dslforum-org:service:DeviceInfo:1#GetInfo"',
      '"urn:dslforum-org:service:UserInterface:1#GetInfo"',
      '"urn:dslforum-org:service:WANIPConnection:1#GetExternalIPAddress"',
      '"urn:dslforum-org:service:WANIPConnection:1#GetPortMappingNumberOfEntries"',
      '"urn:dslforum-org:service:WANIPConnection:1#GetGenericPortMappingEntry"',
      '"urn:dslforum-org:service:WANIPConnection:1#GetGenericPortMappingEntry"',
      '"urn:dslforum-org:service:Hosts:1#X_AVM-DE_GetHostListPath"',
      'GET /devicehostlist.lua?sid=0123456789abcdef',
    ]);
  });

  it('volgt geen pad naar elders als de router een vreemd pad teruggeeft', async () => {
    const responses = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries((fixtureTransport('fritzbox') as unknown as { responses: Record<string, string> }).responses))));
    const key = 'POST /upnp/control/hosts#X_AVM-DE_GetHostListPath';
    responses[key] = (responses[key] as string).replace('/devicehostlist.lua?sid=0123456789abcdef', '/../admin.lua?reboot=1');
    await expect(new FritzboxConnector(new FixtureTransport(responses)).read()).rejects.toMatchObject({ code: 'antwoord_onbekend' });
  });

  it('vertaalt de softwareversie naar FRITZ!OS', () => {
    expect(fritzOsVersion('154.07.29')).toBe('7.29');
    expect(fritzOsVersion('164.07.57-108270')).toBe('7.57');
    expect(fritzOsVersion('onzin')).toBeUndefined();
  });
});

describe('MikroTik', () => {
  it('voegt DHCP-leases en ARP samen en negeert de WAN-kant', async () => {
    const r = await demoConnector('mikrotik', NOW).connector.read();
    expect(r.devices[0]).toMatchObject({ vendor: 'MikroTik', model: 'RB750Gr3', firmware: '6.40.5', firmwareProduct: 'RouterOS', serial: '9A1B0C2D3E4F' });
    expect(r.wanIps).toEqual(['84.12.34.57']);
    expect(r.clients.map((c) => c.mac).sort()).toEqual(['00:1b:a9:11:22:33', '24:5e:be:0d:0e:0f', 'a4:c3:f0:44:55:66', 'b8:27:eb:01:02:03', 'c0:56:e3:aa:bb:cc']);
    expect(r.clients.find((c) => c.mac === '00:1b:a9:11:22:33')).toMatchObject({ active: false, lastSeen: '2026-11-23T08:00:00.000Z' });
  });

  it('rekent "last-seen" om naar een tijdstip', () => {
    expect(lastSeenFrom('1w2d3h4m5s', NOW)).toBe(new Date(NOW.getTime() - (9 * 86400 + 3 * 3600 + 4 * 60 + 5) * 1000).toISOString());
    expect(lastSeenFrom('never', NOW)).toBeUndefined();
  });
});

describe('alleen lezen', () => {
  it('weigert schrijfverzoeken voordat ze de router bereiken', async () => {
    const inner = new FixtureTransport({});
    const guard = new ReadOnlyGuard(inner, [{ method: 'GET', path: /^\/rest\/ip\/arp$/ }]);
    await expect(guard.send({ method: 'POST', path: '/rest/system/reboot' })).rejects.toBeInstanceOf(ConnectorError);
    await expect(guard.send({ method: 'GET', path: '/rest/system/reboot' })).rejects.toMatchObject({ code: 'niet_toegestaan' });
    await expect(guard.send({ method: 'GET', path: '/rest/ip/arp/../../system/reboot' })).rejects.toMatchObject({ code: 'niet_toegestaan' });
    expect(inner.requests).toHaveLength(0);
  });

  it('weigert een SOAP-actie die niet op de lijst staat', async () => {
    const inner = new FixtureTransport({});
    const c = new FritzboxConnector(inner);
    const guard = (c as unknown as { t: ReadOnlyGuard }).t;
    await expect(
      guard.send({ method: 'POST', path: '/upnp/control/deviceconfig', headers: { SOAPAction: '"urn:dslforum-org:service:DeviceConfig:1#Reboot"' } }),
    ).rejects.toMatchObject({ code: 'niet_toegestaan' });
    await expect(
      guard.send({ method: 'POST', path: '/upnp/control/hosts', headers: { SOAPAction: '"urn:dslforum-org:service:Hosts:1#X_AVM-DE_SetHostNameByMACAddress"' } }),
    ).rejects.toMatchObject({ code: 'niet_toegestaan' });
    expect(inner.requests).toHaveLength(0);
  });

  it('MikroTik roept geen commando\'s aan', async () => {
    const { connector, transport } = demoConnector('mikrotik', NOW);
    await connector.read();
    expect(transport.requests.every((q) => q.method === 'GET' && q.body === undefined)).toBe(true);
    expect(new MikrotikConnector(transport)).toBeDefined();
  });
});

describe('HTTP-transport', () => {
  it('weigert Basic-auth of API-sleutels over onversleuteld http', () => {
    expect(() => new HttpTransport({ baseUrl: 'http://192.168.88.1', tls: { mode: 'systeem' }, auth: { scheme: 'basic', username: 'x', password: new Secret('geheim') } })).toThrow(/https/);
  });

  it('vraagt bij een vastgepind certificaat om het certificaat zelf', () => {
    expect(() => new HttpTransport({ baseUrl: 'https://192.168.88.1', tls: { mode: 'vastgepind', fingerprint256: 'AA:BB' } })).toThrow(/PEM/);
  });

  it('leest een Digest-uitdaging', () => {
    expect(parseDigestChallenge('Digest realm="HTTPS Access", nonce="ABC123", algorithm=MD5, qop="auth"')).toEqual({ realm: 'HTTPS Access', nonce: 'ABC123', qop: 'auth', opaque: undefined });
    expect(parseDigestChallenge('Basic realm="x"')).toBeUndefined();
  });

  it('logt in met Digest, volgt geen redirects en zet het wachtwoord nooit in een foutmelding', async () => {
    const seen: string[] = [];
    const server = createServer((req, res) => {
      const auth = req.headers.authorization ?? '';
      seen.push(auth);
      if (req.url === '/elders') {
        res.writeHead(302, { Location: 'http://example.org/' }).end();
        return;
      }
      if (!auth.startsWith('Digest ')) {
        res.writeHead(401, { 'WWW-Authenticate': 'Digest realm="F!Box SOAP-Auth", nonce="1234567890ABCDEF", algorithm=MD5, qop="auth"' }).end();
        return;
      }
      if (!/username="qbicle"/.test(auth) || !/response="[0-9a-f]{32}"/.test(auth)) res.writeHead(403).end();
      else res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const password = new Secret('Zeer-Geheim-123');
      const t = new HttpTransport({ baseUrl: `http://127.0.0.1:${port}`, tls: { mode: 'systeem' }, auth: { scheme: 'digest', username: 'qbicle', password } });
      const res = await t.send({ method: 'GET', path: '/test' });
      expect(res.body).toBe('ok');
      expect(seen.some((h) => h.includes('Zeer-Geheim-123'))).toBe(false);
      const redirect = await t.send({ method: 'GET', path: '/elders' });
      expect(redirect.status).toBe(302);
      await expect(t.send({ method: 'GET', path: 'http://example.org/' })).rejects.toMatchObject({ code: 'niet_toegestaan' });

      const wrong = new HttpTransport({ baseUrl: `http://127.0.0.1:${port}`, tls: { mode: 'systeem' }, auth: { scheme: 'digest', username: 'iemand', password } });
      const err = await wrong.send({ method: 'GET', path: '/test' }).catch((e: unknown) => e as Error);
      expect(err).toMatchObject({ code: 'inloggen_mislukt' });
      expect(JSON.stringify(err) + String(err) + (err as Error).stack).not.toContain('Zeer-Geheim-123');
    } finally {
      server.close();
    }
  });

  it('meldt een onbereikbare router zonder details over inloggegevens', async () => {
    const t = new HttpTransport({ baseUrl: 'https://127.0.0.1:1', tls: { mode: 'systeem' }, timeoutMs: 2000, headers: { 'X-API-KEY': new Secret('sleutel-xyz') } });
    const err = (await t.send({ method: 'GET', path: '/' }).catch((e: unknown) => e)) as ConnectorError;
    expect(err.code).toBe('onbereikbaar');
    expect(err.message).not.toContain('sleutel-xyz');
  });
});
