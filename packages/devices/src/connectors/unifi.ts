import { ConnectorError, ReadOnlyGuard, type AllowRule, type Transport } from '../transport.ts';
import type { ClientDevice, NetworkDevice, Readout, RouterConnector } from '../types.ts';
import { json } from './util.ts';

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
];

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

  async read(): Promise<Readout> {
    const readAt = (this.opts.now?.() ?? new Date()).toISOString();
    const warnings: string[] = [];
    let sites = await this.all<UnifiSite>(`${BASE}/sites`, 'Sites', warnings);
    if (this.opts.site) sites = sites.filter((s) => s.id === this.opts.site || s.name === this.opts.site || s.internalReference === this.opts.site);
    if (sites.length === 0) throw new ConnectorError('antwoord_onbekend', 'Geen UniFi-site gevonden');

    const devices: NetworkDevice[] = [];
    const clients: ClientDevice[] = [];
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
    return { product: 'unifi', readAt, devices, clients, wanIps: [], warnings: [...warnings, 'WAN-adres komt niet uit de UniFi Network API; vul het aan via de buitenkant of Site Manager'] };
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
