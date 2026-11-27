import { ConnectorError, ReadOnlyGuard, type AllowRule, type Transport } from '../transport.ts';
import type { ClientDevice, NetworkDevice, PortForward, Readout, RouterConnector } from '../types.ts';
import { json, portRange } from './util.ts';

/**
 * UniFi Network (Ubiquiti) via de officiële Network API op de console
 * (UniFi OS: /proxy/network/integration/v1), met een API-sleutel uit
 * "Instellingen > Control Plane > Integraties". Alleen GET-verzoeken.
 *
 * Levert: accesspoints, switches en gateway met model en firmware, en alle clients
 * met MAC, IP, naam, verbindingstype en of ze op het gastnetwerk zitten.
 */
const BASE = '/proxy/network/integration/v1';

export const UNIFI_RULES: AllowRule[] = [
  { method: 'GET', path: /^\/proxy\/network\/integration\/v1\/sites(\?offset=\d+&limit=\d+)?$/ },
  { method: 'GET', path: /^\/proxy\/network\/integration\/v1\/sites\/[\w-]+\/(devices|clients)(\?offset=\d+&limit=\d+)?$/ },
  { method: 'GET', path: /^\/proxy\/network\/integration\/v1\/sites\/[\w-]+\/devices\/[\w-]+$/ },
  // Doorgezette poorten staan (nog) niet in de Network API v1. We lezen ze uit de
  // klassieke lijst van de console; zelfde API-sleutel, alleen GET.
  { method: 'GET', path: /^\/proxy\/network\/api\/s\/[\w-]+\/rest\/portforward$/ },
];

interface UnifiPortForward {
  name?: string;
  enabled?: boolean;
  /** "any" of een adres/bereik dat toegang heeft. */
  src?: string;
  dst_port?: string;
  fwd?: string;
  fwd_port?: string;
  proto?: 'tcp' | 'udp' | 'tcp_udp' | string;
}

interface Page<T> {
  offset: number;
  limit: number;
  count: number;
  totalCount: number;
  data: T[];
}

interface UnifiSite {
  id: string;
  name?: string;
  internalReference?: string;
}

interface UnifiDevice {
  id: string;
  name?: string;
  model?: string;
  macAddress?: string;
  ipAddress?: string;
  state?: string;
  /** Lijst in het overzicht, object in de details. */
  features?: string[] | Record<string, unknown>;
  firmwareVersion?: string;
  firmwareUpdatable?: boolean;
}

interface UnifiClient {
  id: string;
  type?: 'WIRED' | 'WIRELESS' | 'VPN' | 'TELEPORT' | string;
  name?: string;
  connectedAt?: string;
  ipAddress?: string;
  macAddress?: string;
  access?: { type?: string };
}

const PAGE = 200;
const MAX_PAGES = 50; // 10.000 clients is ruim genoeg voor MKB; daarboven stoppen we en melden het.

export class UnifiConnector implements RouterConnector {
  readonly product = 'unifi' as const;
  private readonly t: Transport;

  constructor(
    transport: Transport,
    private readonly opts: { site?: string; now?: () => Date } = {},
  ) {
    this.t = new ReadOnlyGuard(transport, UNIFI_RULES);
  }

  private async all<T>(path: string, what: string, warnings: string[]): Promise<T[]> {
    const out: T[] = [];
    for (let i = 0; i < MAX_PAGES; i++) {
      const page = json<Page<T>>(await this.t.send({ method: 'GET', path: `${path}?offset=${i * PAGE}&limit=${PAGE}` }), what);
      if (!Array.isArray(page.data)) throw new ConnectorError('antwoord_onbekend', `${what}: geen lijst`);
      out.push(...page.data);
      if (page.data.length === 0 || out.length >= (page.totalCount ?? out.length)) return out;
    }
    warnings.push(`${what}: meer dan ${PAGE * MAX_PAGES} items, de rest is niet uitgelezen`);
    return out;
  }

  /** null = niet uitgelezen (dan zeggen we "niet gecontroleerd", nooit "geen open poorten"). */
  private async portForwards(site: UnifiSite, warnings: string[]): Promise<PortForward[] | null> {
    const ref = site.internalReference;
    if (!ref || !/^[\w-]+$/.test(ref)) {
      warnings.push('Doorgezette poorten niet uitgelezen: site zonder interne naam');
      return null;
    }
    let body: { data?: UnifiPortForward[] };
    try {
      body = json<{ data?: UnifiPortForward[] }>(await this.t.send({ method: 'GET', path: `/proxy/network/api/s/${ref}/rest/portforward` }), 'Port forwarding');
    } catch (err) {
      if (!(err instanceof ConnectorError) || err.code === 'niet_toegestaan') throw err;
      warnings.push('Doorgezette poorten niet uitgelezen (oudere UniFi-versie of API-sleutel zonder toegang)');
      return null;
    }
    if (!Array.isArray(body.data)) {
      warnings.push('Doorgezette poorten niet uitgelezen: onverwacht antwoord');
      return null;
    }
    const out: PortForward[] = [];
    for (const r of body.data) {
      const ext = portRange(r.dst_port);
      const int = portRange(r.fwd_port ?? r.dst_port);
      if (!r.fwd || ext.length === 0) continue;
      const protos: Array<'tcp' | 'udp'> = r.proto === 'udp' ? ['udp'] : r.proto === 'tcp' ? ['tcp'] : ['tcp', 'udp'];
      for (const [i, port] of ext.entries()) for (const protocol of protos) {
        out.push({
          protocol,
          externalPort: port,
          internalIp: r.fwd,
          internalPort: int[i] ?? int[0] ?? port,
          description: r.name,
          enabled: r.enabled !== false,
          origin: 'regel',
          allowedFrom: r.src && r.src !== 'any' ? [r.src] : undefined,
        });
      }
    }
    return out;
  }

  async read(): Promise<Readout> {
    const readAt = (this.opts.now?.() ?? new Date()).toISOString();
    const warnings: string[] = [];
    let sites = await this.all<UnifiSite>(`${BASE}/sites`, 'Sites', warnings);
    if (this.opts.site) sites = sites.filter((s) => s.id === this.opts.site || s.name === this.opts.site || s.internalReference === this.opts.site);
    if (sites.length === 0) throw new ConnectorError('antwoord_onbekend', 'Geen UniFi-site gevonden');

    const devices: NetworkDevice[] = [];
    const clients: ClientDevice[] = [];
    const portForwards: PortForward[] = [];
    let portForwardsRead = true;
    for (const site of sites) {
      if (!/^[\w-]+$/.test(site.id)) throw new ConnectorError('antwoord_onbekend', 'Onverwachte site-id');
      for (const d of await this.all<UnifiDevice>(`${BASE}/sites/${site.id}/devices`, 'Apparaten', warnings)) {
        let detail = d;
        if (d.firmwareVersion === undefined && /^[\w-]+$/.test(d.id)) {
          try {
            detail = { ...d, ...json<UnifiDevice>(await this.t.send({ method: 'GET', path: `${BASE}/sites/${site.id}/devices/${d.id}` }), 'Apparaat') };
          } catch (err) {
            if (!(err instanceof ConnectorError) || err.code === 'niet_toegestaan') throw err;
            warnings.push(`Firmware van ${d.name ?? d.model ?? 'een apparaat'} niet uitgelezen`);
          }
        }
        devices.push(toNetworkDevice(detail));
      }
      const fw = await this.portForwards(site, warnings);
      if (fw) portForwards.push(...fw);
      else portForwardsRead = false;
      for (const c of await this.all<UnifiClient>(`${BASE}/sites/${site.id}/clients`, 'Clients', warnings)) {
        if (c.type === 'VPN' || c.type === 'TELEPORT') continue; // Op afstand verbonden, geen apparaat op dit netwerk.
        clients.push({
          mac: c.macAddress,
          ip: c.ipAddress,
          hostname: c.name,
          connection: c.type === 'WIRED' ? 'bekabeld' : c.type === 'WIRELESS' ? 'draadloos' : undefined,
          guest: c.access?.type === 'GUEST',
          active: true, // De API geeft alleen verbonden clients.
          lastSeen: readAt,
        });
      }
    }
    return { product: 'unifi', readAt, devices, clients, wanIps: [], portForwards, portForwardsRead, warnings: [...warnings, 'WAN-adres komt niet uit de UniFi Network API; vul het aan via de buitenkant of Site Manager'] };
  }
}

function toNetworkDevice(d: UnifiDevice): NetworkDevice {
  const f = new Set(Array.isArray(d.features) ? d.features : Object.keys(d.features ?? {}));
  const model = d.model ?? '';
  const role: NetworkDevice['role'] =
    /^(UDM|UDR|UCG|UXG|USG|UDW|UX\b|EFG)/i.test(model) || /gateway/i.test(model) ? 'gateway' : f.has('accessPoint') ? 'accesspoint' : f.has('switching') ? 'switch' : 'accesspoint';
  return {
    role,
    vendor: 'Ubiquiti',
    model: d.model,
    name: d.name,
    mac: d.macAddress,
    ip: d.ipAddress,
    firmware: d.firmwareVersion,
    firmwareProduct: 'UniFi firmware',
    updateAvailable: d.firmwareUpdatable,
  };
}
