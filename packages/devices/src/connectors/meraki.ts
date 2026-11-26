import { ConnectorError, ReadOnlyGuard, type AllowRule, type Transport } from '../transport.ts';
import type { ClientDevice, NetworkDevice, Readout, RouterConnector } from '../types.ts';
import { isPublicIpv4, json } from './util.ts';

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
];

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
    return { product: 'meraki', readAt, devices, clients, wanIps: [...wanIps], warnings };
  }
}
