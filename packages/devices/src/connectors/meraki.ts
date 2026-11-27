import { ConnectorError, ReadOnlyGuard, type AllowRule, type Transport } from '../transport.ts';
import type { ClientDevice, NetworkDevice, PortForward, Readout, RouterConnector } from '../types.ts';
import { isPublicIpv4, json, portRange } from './util.ts';

/**
 * Cisco Meraki via de Dashboard API v1 (cloud, https://api.meraki.com/api/v1),
 * met een API-sleutel van een beheerder met alleen-lezen rechten ("read-only admin").
 * Alleen GET. Geen connector op locatie nodig.
 *
 * Levert: alle Meraki-apparaten (MX, MR, MS, Z) met model, serienummer en firmware,
 * publieke IP's van de MX-uplinks, en per netwerk de clients van de afgelopen 24 uur.
 */
const B = '/api/v1';

export const MERAKI_RULES: AllowRule[] = [
  { method: 'GET', path: /^\/api\/v1\/organizations$/ },
  { method: 'GET', path: /^\/api\/v1\/organizations\/[\w-]+\/(devices|networks|appliance\/uplink\/statuses)(\?perPage=\d+)?$/ },
  { method: 'GET', path: /^\/api\/v1\/networks\/[\w-]+\/clients\?timespan=\d+&perPage=\d+$/ },
  { method: 'GET', path: /^\/api\/v1\/networks\/[\w-]+\/appliance\/firewall\/(portForwardingRules|oneToOneNatRules)$/ },
];

/** Port forwarding op de MX (Security & SD-WAN > Firewall). Poorten zijn "443" of "8100-8101". */
interface ForwardRule { name?: string; lanIp?: string; protocol?: string; publicPort?: string; localPort?: string; allowedIps?: string[] }
/** 1:1 NAT: een publiek adres dat naar één intern apparaat wijst, met de toegestane inkomende poorten. */
interface OneToOneRule {
  name?: string;
  lanIp?: string;
  publicIp?: string;
  allowedInbound?: Array<{ protocol?: string; destinationPorts?: string[]; allowedIps?: string[] }>;
}

interface Org { id: string; name?: string }
interface Net { id: string; name?: string; productTypes?: string[] }
interface Dev { name?: string; serial?: string; mac?: string; model?: string; lanIp?: string; firmware?: string; productType?: string }
interface Uplink { serial?: string; uplinks?: Array<{ interface?: string; status?: string; publicIp?: string; ip?: string }> }
interface Client {
  mac?: string;
  ip?: string;
  description?: string;
  manufacturer?: string;
  os?: string;
  lastSeen?: number | string;
  status?: string;
  ssid?: string | null;
}

const PER_PAGE = 1000;
const ROLE: Record<string, NetworkDevice['role']> = { appliance: 'firewall', wireless: 'accesspoint', switch: 'switch', cellularGateway: 'gateway' };

export class MerakiConnector implements RouterConnector {
  readonly product = 'meraki' as const;
  private readonly t: Transport;

  constructor(
    transport: Transport,
    private readonly opts: { organizationId?: string; now?: () => Date } = {},
  ) {
    this.t = new ReadOnlyGuard(transport, MERAKI_RULES);
  }

  private async get<T>(path: string, what: string): Promise<T> {
    const res = await this.t.send({ method: 'GET', path });
    if (res.status >= 300 && res.status < 400) {
      // Wij volgen geen redirects. Meraki verwijst soms naar een eigen shard (nXXX.meraki.com).
      throw new ConnectorError('antwoord_onbekend', `${what}: Meraki verwijst door; stel de basis-URL in op ${new URL(res.headers.location ?? 'https://api.meraki.com').origin}`);
    }
    return json<T>(res, what);
  }

  async read(): Promise<Readout> {
    const readAt = (this.opts.now?.() ?? new Date()).toISOString();
    const warnings: string[] = [];
    let orgs = await this.get<Org[]>(`${B}/organizations`, 'Organisaties');
    if (this.opts.organizationId) orgs = orgs.filter((o) => o.id === this.opts.organizationId);
    if (orgs.length === 0) throw new ConnectorError('antwoord_onbekend', 'Geen Meraki-organisatie gevonden');

    const devices: NetworkDevice[] = [];
    const clients: ClientDevice[] = [];
    const wanIps = new Set<string>();
    const portForwards: PortForward[] = [];
    let forwardsMissed = false;
    let appliances = 0;
    for (const org of orgs) {
      if (!/^[\w-]+$/.test(org.id)) throw new ConnectorError('antwoord_onbekend', 'Onverwachte organisatie-id');
      for (const d of await this.get<Dev[]>(`${B}/organizations/${org.id}/devices?perPage=${PER_PAGE}`, 'Apparaten')) {
        devices.push({
          role: ROLE[d.productType ?? ''] ?? 'router',
          vendor: 'Cisco Meraki',
          model: d.model,
          name: d.name,
          serial: d.serial,
          mac: d.mac,
          ip: d.lanIp,
          firmware: d.firmware,
          firmwareProduct: 'Meraki firmware',
        });
      }
      try {
        for (const u of await this.get<Uplink[]>(`${B}/organizations/${org.id}/appliance/uplink/statuses?perPage=${PER_PAGE}`, 'Uplinks')) {
          for (const l of u.uplinks ?? []) if (l.publicIp && isPublicIpv4(l.publicIp)) wanIps.add(l.publicIp);
        }
      } catch (err) {
        if (!(err instanceof ConnectorError) || err.code === 'niet_toegestaan') throw err;
        warnings.push('Internetadressen van de MX niet uitgelezen');
      }
      for (const n of await this.get<Net[]>(`${B}/organizations/${org.id}/networks?perPage=${PER_PAGE}`, 'Netwerken')) {
        if (!/^[\w-]+$/.test(n.id)) continue;
        if (n.productTypes?.includes('appliance')) {
          appliances++;
          try {
            portForwards.push(...(await this.forwards(n.id)));
          } catch (err) {
            if (!(err instanceof ConnectorError) || err.code === 'niet_toegestaan') throw err;
            forwardsMissed = true;
            warnings.push(`Netwerk ${n.name ?? n.id}: doorgezette poorten niet uitgelezen`);
          }
        }
        const list = await this.get<Client[]>(`${B}/networks/${n.id}/clients?timespan=86400&perPage=${PER_PAGE}`, 'Clients');
        if (list.length >= PER_PAGE) warnings.push(`Netwerk ${n.name ?? n.id}: meer dan ${PER_PAGE} clients, de rest is niet gelezen`);
        for (const c of list) {
          clients.push({
            mac: c.mac,
            ip: c.ip,
            hostname: c.description,
            vendor: c.manufacturer,
            model: c.os,
            connection: c.ssid ? 'draadloos' : 'bekabeld',
            active: c.status === 'Online',
            lastSeen: typeof c.lastSeen === 'number' ? new Date(c.lastSeen * 1000).toISOString() : c.lastSeen,
          });
        }
      }
    }
    // Zonder MX (alleen wifi of switches) zet Meraki zelf niets door: dan staat de rand elders.
    if (appliances === 0) warnings.push('Geen Meraki-firewall (MX) gevonden; doorgezette poorten staan dan op een ander apparaat');
    return { product: 'meraki', readAt, devices, clients, wanIps: [...wanIps], portForwards, portForwardsRead: appliances > 0 && !forwardsMissed, warnings };
  }

  private async forwards(networkId: string): Promise<PortForward[]> {
    const out: PortForward[] = [];
    const pf = await this.get<{ rules?: ForwardRule[] }>(`${B}/networks/${networkId}/appliance/firewall/portForwardingRules`, 'Port forwarding');
    for (const r of pf.rules ?? []) {
      if (!r.lanIp) continue;
      const pub = portRange(r.publicPort);
      const loc = portRange(r.localPort);
      for (const [i, port] of pub.entries()) {
        for (const protocol of protocols(r.protocol)) {
          out.push({ protocol, externalPort: port, internalIp: r.lanIp, internalPort: loc[i] ?? loc[0] ?? port, description: r.name, enabled: true, origin: 'regel', allowedFrom: restricted(r.allowedIps) });
        }
      }
    }
    const nat = await this.get<{ rules?: OneToOneRule[] }>(`${B}/networks/${networkId}/appliance/firewall/oneToOneNatRules`, '1:1 NAT');
    for (const r of nat.rules ?? []) {
      if (!r.lanIp) continue;
      for (const a of r.allowedInbound ?? []) {
        if (a.protocol === 'icmp-ping') continue; // Alleen ping, geen dienst.
        const ports = a.destinationPorts ?? [];
        const from = restricted(a.allowedIps);
        if (ports.some((p) => p === 'any') || a.protocol === 'any') {
          out.push({ protocol: 'tcp', externalPort: 0, internalIp: r.lanIp, internalPort: 0, description: r.name, enabled: true, origin: 'regel', allowedFrom: from, allPorts: true });
          continue;
        }
        for (const p of ports.flatMap(portRange)) {
          for (const protocol of protocols(a.protocol)) {
            out.push({ protocol, externalPort: p, internalIp: r.lanIp, internalPort: p, description: r.name, enabled: true, origin: 'regel', allowedFrom: from });
          }
        }
      }
    }
    return out;
  }
}

function protocols(p: string | undefined): Array<'tcp' | 'udp'> {
  if (p === 'udp') return ['udp'];
  if (p === 'tcp') return ['tcp'];
  return ['tcp', 'udp'];
}

function restricted(ips: string[] | undefined): string[] | undefined {
  if (!ips || ips.length === 0 || ips.some((ip) => ip === 'any' || ip === '0.0.0.0/0')) return undefined;
  return ips;
}
