import { ReadOnlyGuard, type AllowRule, type Transport } from '../transport.ts';
import type { ClientDevice, PortForward, Readout, RouterConnector } from '../types.ts';
import { isPublicIpv4, json } from './util.ts';

/**
 * MikroTik RouterOS 7 via de REST API (https, Basic-authenticatie).
 * Gebruik een eigen gebruiker in een groep met alleen de policies "read,api,rest-api".
 * Alleen GET op een vaste lijst paden; we roepen geen commando's aan
 * (ook niet "check-for-updates", want dat laat de router zelf naar buiten bellen).
 */
export const MIKROTIK_RULES: AllowRule[] = [
  { method: 'GET', path: /^\/rest\/system\/(resource|routerboard|identity)$/ },
  { method: 'GET', path: /^\/rest\/ip\/(dhcp-server\/lease|arp|address|firewall\/nat|upnp)$/ },
];

interface Resource {
  version?: string;
  'board-name'?: string;
  platform?: string;
}
interface Routerboard {
  routerboard?: string;
  model?: string;
  'serial-number'?: string;
  'current-firmware'?: string;
  'upgrade-firmware'?: string;
}
interface Lease {
  address?: string;
  'mac-address'?: string;
  'host-name'?: string;
  status?: string;
  'last-seen'?: string;
  disabled?: string;
}
interface Arp {
  address?: string;
  'mac-address'?: string;
  interface?: string;
  complete?: string;
}
interface NatRule {
  chain?: string;
  action?: string;
  protocol?: string;
  'dst-port'?: string;
  'to-addresses'?: string;
  'to-ports'?: string;
  disabled?: string;
  comment?: string;
}
interface Address {
  address?: string;
  interface?: string;
  disabled?: string;
}

export class MikrotikConnector implements RouterConnector {
  readonly product = 'mikrotik' as const;
  private readonly t: Transport;

  constructor(
    transport: Transport,
    private readonly opts: { now?: () => Date } = {},
  ) {
    this.t = new ReadOnlyGuard(transport, MIKROTIK_RULES);
  }

  private async get<T>(path: string, what: string): Promise<T> {
    return json<T>(await this.t.send({ method: 'GET', path }), what);
  }

  async read(): Promise<Readout> {
    const now = this.opts.now?.() ?? new Date();
    const readAt = now.toISOString();
    const warnings: string[] = [];
    const resource = await this.get<Resource>('/rest/system/resource', 'Systeem');
    const identity = await this.get<{ name?: string }>('/rest/system/identity', 'Naam').catch(() => ({ name: undefined }));
    let rb: Routerboard = {};
    try {
      rb = await this.get<Routerboard>('/rest/system/routerboard', 'Routerboard');
    } catch {
      warnings.push('Geen routerboard-gegevens (bijvoorbeeld een virtuele router)');
    }
    const leases = await this.get<Lease[]>('/rest/ip/dhcp-server/lease', 'DHCP-leases');
    const arp = await this.get<Arp[]>('/rest/ip/arp', 'ARP-tabel');
    const addresses = await this.get<Address[]>('/rest/ip/address', 'Adressen');

    // DHCP-leases en ARP-tabel samenvoegen op MAC: leases geven de hostnaam, ARP ook vaste adressen.
    const byMac = new Map<string, ClientDevice>();
    for (const l of leases) {
      const mac = l['mac-address']?.toLowerCase();
      if (!mac || l.disabled === 'true') continue;
      byMac.set(mac, {
        mac,
        ip: l.address,
        hostname: l['host-name'] || undefined,
        active: l.status === 'bound',
        lastSeen: lastSeenFrom(l['last-seen'], now),
      });
    }
    for (const a of arp) {
      const mac = a['mac-address']?.toLowerCase();
      // Alleen het eigen netwerk: ARP-regels met een publiek adres horen bij de provider (WAN-kant).
      if (!mac || a.complete === 'false' || (a.address && isPublicIpv4(a.address))) continue;
      const known = byMac.get(mac);
      if (known) {
        known.ip ??= a.address;
        known.active = true;
      } else byMac.set(mac, { mac, ip: a.address, active: true, lastSeen: readAt });
    }

    const wanIps = addresses
      .filter((a) => a.disabled !== 'true')
      .map((a) => a.address?.split('/')[0] ?? '')
      .filter(isPublicIpv4);

    // Doorgezette poorten (dst-nat) en of UPnP aanstaat: configuratie lezen, niet scannen.
    const portForwards: PortForward[] = [];
    let upnpEnabled: boolean | undefined;
    try {
      for (const r of await this.get<NatRule[]>('/rest/ip/firewall/nat', 'NAT-regels')) {
        if (r.chain !== 'dstnat' || r.action !== 'dst-nat' || !r['to-addresses'] || !r['dst-port']) continue;
        for (const port of expandPorts(r['dst-port'])) {
          portForwards.push({
            protocol: r.protocol === 'udp' ? 'udp' : 'tcp',
            externalPort: port,
            internalIp: r['to-addresses'].split('-')[0]!,
            internalPort: Number(r['to-ports'] ?? port) || port,
            description: r.comment,
            enabled: r.disabled !== 'true',
            origin: 'regel',
          });
        }
      }
      upnpEnabled = (await this.get<{ enabled?: string }>('/rest/ip/upnp', 'UPnP')).enabled === 'true';
    } catch {
      warnings.push('NAT-regels of UPnP-instelling niet uitgelezen');
    }

    const privateWan = addresses.find((a) => a.interface && /ether1|wan|pppoe/i.test(a.interface) && a.address && !isPublicIpv4(a.address.split('/')[0]!));
    const version = resource.version?.match(/^[\d.]+/)?.[0];
    return {
      product: 'mikrotik',
      readAt,
      devices: [
        {
          role: 'router',
          vendor: 'MikroTik',
          model: rb.model ?? resource['board-name'],
          name: identity.name,
          serial: rb['serial-number'],
          firmware: version,
          firmwareProduct: 'RouterOS',
        },
      ],
      clients: [...byMac.values()],
      wanIps,
      privateWanIp: wanIps.length === 0 ? privateWan?.address?.split('/')[0] : undefined,
      portForwards,
      upnpEnabled,
      warnings,
    };
  }
}

/** "1w2d3h4m5s" geleden naar een ISO-tijdstip. "never" of leeg = onbekend. */
export function lastSeenFrom(raw: string | undefined, now: Date): string | undefined {
  if (!raw || raw === 'never') return undefined;
  const units: Record<string, number> = { w: 604800, d: 86400, h: 3600, m: 60, s: 1 };
  let secs = 0;
  let matched = false;
  for (const m of raw.matchAll(/(\d+)([wdhms])/g)) {
    secs += Number(m[1]) * units[m[2]!]!;
    matched = true;
  }
  if (!matched) return undefined;
  return new Date(now.getTime() - secs * 1000).toISOString();
}

/** "80,443,8000-8002" naar losse poorten (maximaal 64 per regel). */
export function expandPorts(spec: string): number[] {
  const out: number[] = [];
  for (const part of spec.split(',')) {
    const [a, b] = part.split('-').map(Number);
    if (!Number.isInteger(a)) continue;
    for (let p = a!; p <= (Number.isInteger(b) ? b! : a!) && out.length < 64; p++) out.push(p);
  }
  return out;
}
