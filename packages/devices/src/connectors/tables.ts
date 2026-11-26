import { normalizeMac } from '@qbicle/inventory';
import type { ClientDevice, NetworkDevice, Readout, RouterConnector } from '../types.ts';
import { isPublicIpv4 } from './util.ts';

/**
 * Generieke route voor routers zonder (bruikbare) API, zoals oudere of
 * providerapparatuur: de ARP- en DHCP-tabellen die het netwerk al kent.
 *
 * De lokale connector (of een beheerder) levert de tabel aan als tekst; wij lezen
 * alleen. Ondersteunde formaten:
 * - arp-windows: uitvoer van `arp -a` op Windows
 * - arp-unix:    uitvoer van `arp -a` op macOS/Linux/BSD
 * - ip-neigh:    uitvoer van `ip neigh` (Linux)
 * - dnsmasq:     dnsmasq.leases (veel consumentenrouters, OpenWrt, Pi-hole)
 * - isc-dhcpd:   dhcpd.leases (ISC DHCP, pfSense)
 * - windows-dhcp-csv: Get-DhcpServerv4Lease | Export-Csv (Windows DHCP-server)
 * - avahi-browse: `avahi-browse -aprt` (mDNS-aankondigingen: diensten en namen per IP; geen MAC)
 *
 * Niveau 2P: de connector luistert of leest tabellen en stuurt zelf niets uit.
 */
export type TableFormat = 'arp-windows' | 'arp-unix' | 'ip-neigh' | 'dnsmasq' | 'isc-dhcpd' | 'windows-dhcp-csv' | 'avahi-browse';

export interface TableInput {
  format: TableFormat;
  content: string;
  /** Tijdstip waarop de tabel is gemaakt (ISO). */
  capturedAt?: string;
}

/** "0:11:22:3:4:55" (macOS laat voorloopnullen weg) wordt "00:11:22:03:04:55". */
function mac(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const parts = raw.split(/[:-]/);
  const padded = parts.length === 6 ? parts.map((p) => p.padStart(2, '0')).join(':') : raw;
  return normalizeMac(padded);
}

const IPV4 = String.raw`(\d{1,3}(?:\.\d{1,3}){3})`;

export function parseTable(input: TableInput): ClientDevice[] {
  const at = input.capturedAt;
  const out: ClientDevice[] = [];
  const lines = input.content.split(/\r?\n/);
  switch (input.format) {
    case 'arp-windows':
      for (const l of lines) {
        const m = l.match(new RegExp(`^\\s*${IPV4}\\s+([0-9a-f]{2}(?:-[0-9a-f]{2}){5})\\s+(dynamic|static|dynamisch|statisch)`, 'i'));
        if (m) out.push({ ip: m[1], mac: mac(m[2]), active: true, lastSeen: at });
      }
      break;
    case 'arp-unix':
      for (const l of lines) {
        const m = l.match(new RegExp(`^(\\S+)\\s+\\(${IPV4}\\)\\s+at\\s+([0-9a-f]{1,2}(?::[0-9a-f]{1,2}){5})`, 'i'));
        if (m) out.push({ ip: m[2], mac: mac(m[3]), hostname: m[1] === '?' ? undefined : m[1]!.split('.')[0], active: true, lastSeen: at });
      }
      break;
    case 'ip-neigh':
      for (const l of lines) {
        const m = l.match(new RegExp(`^${IPV4}\\s.*\\blladdr\\s+([0-9a-f:]{17})\\s+(\\w+)`, 'i'));
        if (m && m[3] !== 'FAILED' && m[3] !== 'INCOMPLETE') out.push({ ip: m[1], mac: mac(m[2]), active: m[3] === 'REACHABLE', lastSeen: at });
      }
      break;
    case 'dnsmasq':
      for (const l of lines) {
        const [expiry, m, ip, host] = l.trim().split(/\s+/);
        if (!expiry || !m || !ip || !/^\d+$/.test(expiry)) continue;
        out.push({ ip, mac: mac(m), hostname: host && host !== '*' ? host : undefined, active: true, lastSeen: at });
      }
      break;
    case 'isc-dhcpd':
      for (const block of input.content.matchAll(new RegExp(`lease\\s+${IPV4}\\s*\\{([\\s\\S]*?)\\}`, 'g'))) {
        const body = block[2]!;
        const state = body.match(/binding state (\w+);/)?.[1];
        if (state && state !== 'active') continue;
        const ends = body.match(/ends \d+ (\d{4})\/(\d{2})\/(\d{2}) (\d{2}:\d{2}:\d{2});/);
        out.push({
          ip: block[1],
          mac: mac(body.match(/hardware ethernet ([0-9a-f:]+);/i)?.[1]),
          hostname: body.match(/client-hostname "([^"]*)";/)?.[1] || undefined,
          active: state === 'active',
          lastSeen: ends ? `${ends[1]}-${ends[2]}-${ends[3]}T${ends[4]}Z` : at,
        });
      }
      break;
    case 'windows-dhcp-csv': {
      const rows = lines.filter((l) => l.trim() && !l.startsWith('#'));
      const header = (rows.shift() ?? '').split(',').map((h) => h.replace(/"/g, '').trim());
      const col = (name: string) => header.indexOf(name);
      for (const r of rows) {
        const f = r.split(',').map((v) => v.replace(/^"|"$/g, '').trim());
        const state = f[col('AddressState')] ?? '';
        if (state && !/active/i.test(state)) continue;
        out.push({ ip: f[col('IPAddress')], mac: mac(f[col('ClientId')]), hostname: f[col('HostName')]?.split('.')[0] || undefined, active: true, lastSeen: at });
      }
      break;
    }
    case 'avahi-browse': {
      // "=;eth0;IPv4;Naam;_ipp._tcp;local;BRN001BA9AABBCC.local;192.168.1.40;631;txt"
      const byIp = new Map<string, ClientDevice>();
      for (const l of lines) {
        const f = l.split(';');
        if (f[0] !== '=' || f[2] !== 'IPv4' || !f[4] || !f[7]) continue;
        const c = byIp.get(f[7]) ?? { ip: f[7], hostname: f[6]?.replace(/\.local$/, '') || undefined, services: [], lastSeen: at };
        if (!c.services!.includes(f[4])) c.services!.push(f[4]);
        byIp.set(f[7], c);
      }
      out.push(...byIp.values());
      break;
    }
  }
  // Alleen het eigen netwerk; regels met een publiek adres horen bij de WAN-kant.
  return out.filter((c) => c.ip && (c.mac || c.services?.length) && !isPublicIpv4(c.ip) && !isGroupAddress(c));
}

/**
 * Multicast- en broadcastregels (224.0.0.251, x.x.x.255, ff:ff:ff:ff:ff:ff, 01:00:5e:...)
 * staan in elke ARP-tabel van macOS, maar zijn geen apparaten.
 */
function isGroupAddress(c: ClientDevice): boolean {
  const first = Number(c.ip!.split('.')[0]);
  if (first >= 224 || c.ip!.endsWith('.255')) return true;
  if (!c.mac) return false;
  return (parseInt(c.mac.slice(0, 2), 16) & 1) === 1;
}

/** Voegt tabellen samen op MAC: DHCP geeft de hostnaam, ARP ook vaste adressen. */
export function mergeClients(lists: ClientDevice[][]): ClientDevice[] {
  const byMac = new Map<string, ClientDevice>();
  const announcements: ClientDevice[] = [];
  for (const c of lists.flat()) {
    if (!c.mac) {
      announcements.push(c);
      continue;
    }
    const known = byMac.get(c.mac);
    if (!known) byMac.set(c.mac, { ...c });
    else {
      known.ip ??= c.ip;
      known.hostname ??= c.hostname;
      known.active = Boolean(known.active || c.active);
      if (c.lastSeen && (!known.lastSeen || c.lastSeen > known.lastSeen)) known.lastSeen = c.lastSeen;
    }
  }
  // mDNS-aankondigingen hebben geen MAC: koppelen op IP aan wat ARP/DHCP al kent.
  const out = [...byMac.values()];
  for (const a of announcements) {
    const known = out.find((c) => c.ip === a.ip);
    if (known) {
      known.services = [...new Set([...(known.services ?? []), ...(a.services ?? [])])];
      known.hostname ??= a.hostname;
    } else out.push({ ...a });
  }
  return out;
}

export class TableConnector implements RouterConnector {
  readonly product = 'tabel' as const;

  constructor(
    private readonly tables: TableInput[],
    private readonly opts: { router?: NetworkDevice; wanIps?: string[]; now?: () => Date } = {},
  ) {}

  async read(): Promise<Readout> {
    const readAt = (this.opts.now?.() ?? new Date()).toISOString();
    const clients = mergeClients(this.tables.map((t) => parseTable({ ...t, capturedAt: t.capturedAt ?? readAt })));
    const warnings = this.tables.length === 0 ? ['Geen tabellen aangeleverd'] : [];
    if (!this.opts.router) warnings.push('Model en firmware van de router zijn niet bekend via deze route; vul ze aan of koppel SNMP');
    return {
      product: 'tabel',
      readAt,
      devices: this.opts.router ? [this.opts.router] : [],
      clients,
      wanIps: (this.opts.wanIps ?? []).filter(isPublicIpv4),
      warnings,
    };
  }
}
