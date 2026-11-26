import { describe, expect, it } from 'vitest';
import { DEFAULT_PRIVACY, FixtureSnmpSession, OID, SnmpConnector, TableConnector, discover, firmwareFrom, parseTable, vendorFrom } from '../src/index.ts';
import { DEMO_PSEUDONYM_KEY, demoOui, demoVulnDb } from '../src/demo.ts';

const NOW = new Date('2026-11-26T12:00:00Z');

describe('ARP- en DHCP-tabellen (oudere routers)', () => {
  it('leest arp -a van Windows', () => {
    const out = parseTable({
      format: 'arp-windows',
      content: 'Interface: 192.168.1.20 --- 0xb\n  Internet Address      Physical Address      Type\n  192.168.1.1           00-1b-a9-aa-bb-cc     dynamic\n  192.168.1.255         ff-ff-ff-ff-ff-ff     static\n',
    });
    expect(out).toEqual([{ ip: '192.168.1.1', mac: '00:1b:a9:aa:bb:cc', active: true, lastSeen: undefined }]);
  });

  it('leest arp -a van macOS, ook zonder voorloopnullen', () => {
    const out = parseTable({ format: 'arp-unix', content: '? (192.168.1.40) at 0:1b:a9:aa:bb:c on en0 ifscope [ethernet]\nprinter.lan (192.168.1.41) at c0:56:e3:12:34:56 on en0 [ethernet]\n' });
    expect(out.map((c) => [c.ip, c.mac, c.hostname])).toEqual([
      ['192.168.1.40', '00:1b:a9:aa:bb:0c', undefined],
      ['192.168.1.41', 'c0:56:e3:12:34:56', 'printer'], // zoekdomein (.lan, .home) eraf,
    ]);
  });

  it('leest ip neigh, dnsmasq, ISC dhcpd en een Windows DHCP-export', () => {
    expect(parseTable({ format: 'ip-neigh', content: '192.168.1.5 dev eth0 lladdr 00:40:ad:01:02:03 REACHABLE\n192.168.1.6 dev eth0  FAILED\n' })).toHaveLength(1);
    expect(parseTable({ format: 'dnsmasq', content: '1795700000 00:0e:58:ab:cd:ef 192.168.1.60 Sonos-Kantoor 01:00:0e:58:ab:cd:ef\n' })[0]).toMatchObject({ hostname: 'Sonos-Kantoor' });
    const isc = parseTable({
      format: 'isc-dhcpd',
      content: 'lease 192.168.1.70 {\n  starts 3 2026/11/25 08:00:00;\n  ends 4 2026/11/26 08:00:00;\n  binding state active;\n  hardware ethernet 24:0a:c4:aa:00:01;\n  client-hostname "shelly1pm-A1B2C3";\n}\nlease 192.168.1.71 {\n  binding state free;\n  hardware ethernet 24:0a:c4:aa:00:02;\n}\n',
    });
    expect(isc).toEqual([{ ip: '192.168.1.70', mac: '24:0a:c4:aa:00:01', hostname: 'shelly1pm-A1B2C3', active: true, lastSeen: '2026-11-26T08:00:00Z' }]);
    const win = parseTable({
      format: 'windows-dhcp-csv',
      content: '#TYPE Microsoft.Management.Infrastructure.CimInstance\n"IPAddress","ScopeId","ClientId","HostName","AddressState"\n"10.0.0.21","10.0.0.0","a4-c3-f0-44-55-66","DESKTOP-7H3K2LQ.bakker.local","Active"\n"10.0.0.22","10.0.0.0","a4-c3-f0-44-55-67","oud.bakker.local","Expired"\n',
    });
    expect(win).toEqual([{ ip: '10.0.0.21', mac: 'a4:c3:f0:44:55:66', hostname: 'DESKTOP-7H3K2LQ', active: true, lastSeen: undefined }]);
  });

  it('voegt ARP en DHCP samen en loopt door de hele keten', async () => {
    const connector = new TableConnector(
      [
        { format: 'arp-windows', content: '  192.168.1.40          00-1b-a9-aa-bb-cc     dynamic\n  84.1.2.1              00-00-5e-00-01-01     dynamic\n' },
        { format: 'dnsmasq', content: '1795700000 00:1b:a9:aa:bb:cc 192.168.1.40 BRN001BA9AABBCC *\n' },
      ],
      { now: () => NOW, wanIps: ['84.1.2.3'] },
    );
    const r = await discover({
      connectors: [{ connector, source: { id: 'tabel-hal', kind: 'connector', product: 'tabel', level: '2P', network: 'hal' } }],
      oui: demoOui(),
      vulnDb: demoVulnDb(),
      privacy: { ...DEFAULT_PRIVACY, pseudonymKey: DEMO_PSEUDONYM_KEY },
      now: NOW,
    });
    expect(r.readouts[0]!.clients).toHaveLength(1); // WAN-kant weggelaten, twee tabellen samengevoegd
    expect(r.assets.find((a) => a.key === 'mac:00:1b:a9:aa:bb:cc')?.category).toBe('printer');
    expect(r.assets.some((a) => a.key === 'ip:84.1.2.3' && a.exposure === 'internet')).toBe(true);
  });
});

describe('SNMP (generiek, alle merken)', () => {
  const session = () =>
    new FixtureSnmpSession([
      { oid: OID.sysDescr, value: 'RouterOS 6.40.5 RB750Gr3' },
      { oid: OID.sysObjectID, value: '1.3.6.1.4.1.14988.1' },
      { oid: OID.sysName, value: 'router-werkplaats' },
      { oid: `${OID.ipNetToMediaPhysAddress}.2.192.168.88.10`, value: Buffer.from('b827eb010203', 'hex') },
      { oid: `${OID.ipNetToMediaPhysAddress}.1.84.12.34.1`, value: Buffer.from('00005e000101', 'hex') },
      { oid: `${OID.ipAdEntAddr}.84.12.34.57`, value: '84.12.34.57' },
      { oid: `${OID.ipAdEntAddr}.192.168.88.1`, value: '192.168.88.1' },
    ]);

  it('weigert zonder getekende opdracht (niveau 2A)', () => {
    expect(() => new SnmpConnector(session(), { consentRef: '', host: '192.168.88.1' })).toThrow(/2A/);
  });

  it('leest fabrikant, firmware, ARP-tabel en WAN-adres, met terugval op de oude IP-MIB-tabel', async () => {
    const s = session();
    const r = await new SnmpConnector(s, { consentRef: 'opdracht-2026-001', host: '192.168.88.1', now: () => NOW }).read();
    expect(r.devices[0]).toMatchObject({ vendor: 'MikroTik', firmwareProduct: 'RouterOS', firmware: '6.40.5', model: 'RB750Gr3', name: 'router-werkplaats' });
    expect(r.clients).toEqual([{ ip: '192.168.88.10', mac: 'b8:27:eb:01:02:03', active: true, lastSeen: NOW.toISOString() }]);
    expect(r.wanIps).toEqual(['84.12.34.57']);
    expect(s.requests).toContain(`walk ${OID.ipNetToPhysicalPhysAddress}`);
    expect(s.requests).toContain(`walk ${OID.ipNetToMediaPhysAddress}`);
  });

  it('herkent fabrikant en firmware van andere merken', () => {
    expect(vendorFrom('1.3.6.1.4.1.9.1.2066', '')).toBe('Cisco');
    expect(vendorFrom(undefined, 'DrayTek Vigor2865 Series')).toBe('DrayTek');
    expect(firmwareFrom('Cisco IOS Software, C880 Software (C880DATA-UNIVERSALK9-M), Version 15.2(4)M6, RELEASE')).toEqual({ product: 'Cisco IOS', version: '15.2(4)M6' });
    expect(firmwareFrom('DrayTek Vigor2862 Series 3.9.6.3')).toMatchObject({ product: 'DrayOS', model: 'Vigor2862', version: '3.9.6.3' });
  });
});

describe('mDNS-aankondigingen (avahi-browse)', () => {
  it('koppelt diensten op IP aan ARP-regels en deelt zo in', async () => {
    const connector = new TableConnector(
      [
        { format: 'arp-unix', content: '? (192.168.1.40) at 12:34:56:78:9a:bc on eth0 [ether]\n' },
        { format: 'avahi-browse', content: '+;eth0;IPv4;Kantoorprinter;_ipp._tcp;local\n=;eth0;IPv4;Kantoorprinter;_ipp._tcp;local;kantoorprinter.local;192.168.1.40;631;"rp=ipp/print"\n=;eth0;IPv6;Kantoorprinter;_ipp._tcp;local;kantoorprinter.local;fe80::1;631;""\n' },
      ],
      { now: () => NOW },
    );
    const r = await connector.read();
    expect(r.clients).toEqual([expect.objectContaining({ mac: '12:34:56:78:9a:bc', hostname: 'kantoorprinter', services: ['_ipp._tcp'] })]);
  });
});
