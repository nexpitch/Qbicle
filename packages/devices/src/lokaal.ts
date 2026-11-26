import { randomBytes } from 'node:crypto';
import type { Source } from '@qbicle/inventory';
import { UpnpIgdConnector } from './connectors/upnp.ts';
import { mergeClients, parseTable, type TableFormat } from './connectors/tables.ts';
import { describeUpnpDevices, locateIgd, type UpnpDeviceInfo } from './connectors/ssdp.ts';
import { isPrivateIpv4 } from './connectors/util.ts';
import { discover, type DiscoveryResult } from './discover.ts';
import type { EolDb } from './eol.ts';
import type { OuiDb } from './oui.ts';
import { DEFAULT_PRIVACY } from './privacy.ts';
import { identifyProviderModem } from './providers.ts';
import { HttpTransport, type Transport } from './transport.ts';
import type { Readout, RouterConnector } from './types.ts';
import { VulnDb } from './vulns/db.ts';

/**
 * Eerste test op je eigen netwerk: het providermodem (of je eigen router) via UPnP,
 * zonder inloggen, plus de apparaten die je computer al kent uit zijn ARP-tabel.
 *
 * Wat er over het netwerk gaat: één SSDP-zoekvraag en de UPnP-leesacties, alleen naar
 * de gateway. De ARP-tabel maakt het script op de Mac zelf (zie scripts/mijn-netwerk.sh).
 */
export interface LocalRunInput {
  /** IP-adres van de gateway (het modem of je router), bijvoorbeeld 192.168.2.254. */
  gateway: string;
  tables: Array<{ format: TableFormat; content: string; capturedAt?: string }>;
  oui: OuiDb;
  vulnDb?: VulnDb;
  eolDb?: EolDb;
  now?: Date;
  /** Voor tests: eigen SSDP en transport. */
  locate?: (gateway: string) => Promise<URL | undefined>;
  transportFor?: (origin: string) => Transport;
  /**
   * Met scanopdracht: vraag elk apparaat één keer (unicast) om zijn UPnP-beschrijving
   * (fabrikant, model, type). Geen poortscan.
   */
  askDevices?: boolean;
  describe?: (ips: string[]) => Promise<Map<string, UpnpDeviceInfo>>;
}

/** Waar de gegevens over een apparaat vandaan komen, per IP-adres. */
export type Evidence = 'ARP-tabel' | 'MAC-fabrikant' | 'naam in het netwerk' | 'Bonjour' | 'UPnP';

export interface LocalRunResult extends DiscoveryResult {
  gateway: string;
  /** Adres van de UPnP-beschrijving, als het modem die gaf. */
  upnpLocation?: string;
  /** Wat er niet lukte, in gewone taal. */
  notes: string[];
  /** Per IP-adres: welke bronnen iets over het apparaat zeiden. */
  evidence: Record<string, Evidence[]>;
  /** Per IP-adres: het MAC-adres (voor zelf benoemen) en of het een privacy-adres is. */
  macs: Record<string, string>;
}

export async function runLocal(input: LocalRunInput): Promise<LocalRunResult> {
  if (!isPrivateIpv4(input.gateway)) throw new Error('De gateway moet een adres in je eigen netwerk zijn (bijvoorbeeld 192.168.2.254)');
  const now = input.now ?? new Date();
  const notes: string[] = [];
  const parsed = input.tables.map((t) => ({ format: t.format, clients: parseTable({ ...t, capturedAt: t.capturedAt ?? now.toISOString() }) }));
  const evidence: Record<string, Set<Evidence>> = {};
  const mark = (ip: string | undefined, e: Evidence) => ip && (evidence[ip] ??= new Set()).add(e);
  for (const t of parsed) {
    for (const c of t.clients) {
      if (t.format === 'dns-sd-macos' || t.format === 'avahi-browse') mark(c.ip, 'Bonjour');
      else mark(c.ip, 'ARP-tabel');
      if (c.hostname && t.format !== 'dns-sd-macos') mark(c.ip, 'naam in het netwerk');
    }
  }
  const allClients = mergeClients(parsed.map((t) => t.clients));
  if (input.askDevices) {
    const ips = allClients.map((c) => c.ip!).filter((ip) => ip && ip !== input.gateway);
    const info = await (input.describe ?? ((x: string[]) => describeUpnpDevices(x)))(ips).catch(() => new Map<string, UpnpDeviceInfo>());
    for (const c of allClients) {
      const d = c.ip ? info.get(c.ip) : undefined;
      if (!d) continue;
      mark(c.ip, 'UPnP');
      c.vendor ??= d.vendor;
      c.model ??= d.model;
      if (d.deviceType) c.services = [...new Set([...(c.services ?? []), `upnp:${d.deviceType.toLowerCase()}`])];
    }
  }
  const macs: Record<string, string> = {};
  for (const c of allClients) {
    if (!c.ip || !c.mac) continue;
    macs[c.ip] = c.mac;
    if (input.oui.lookup(c.mac)) mark(c.ip, 'MAC-fabrikant');
  }
  const gatewayEntry = allClients.find((c) => c.ip === input.gateway);
  const clients = allClients.filter((c) => c.ip !== input.gateway);
  const gatewayVendor = gatewayEntry?.mac ? input.oui.lookup(gatewayEntry.mac) : undefined;

  const connectors: Array<{ connector: RouterConnector; source: Source }> = [];
  let upnpLocation: URL | undefined;
  try {
    upnpLocation = await (input.locate ?? locateIgd)(input.gateway);
  } catch {
    upnpLocation = undefined;
  }
  if (upnpLocation && /^\/[\w./-]{1,100}\.xml$/.test(upnpLocation.pathname)) {
    const transport = input.transportFor?.(upnpLocation.origin) ?? new HttpTransport({ baseUrl: upnpLocation.origin, tls: { mode: 'systeem' }, timeoutMs: 5000 });
    const upnp = new UpnpIgdConnector(transport, { descriptionPath: upnpLocation.pathname, now: () => now });
    connectors.push({
      // Het modem zegt in UPnP niet welk IP- en MAC-adres het heeft; die kennen we uit de ARP-tabel.
      connector: {
        product: 'upnp',
        async read(): Promise<Readout> {
          const r = await upnp.read();
          const d = r.devices[0];
          if (d) {
            d.ip = input.gateway;
            d.mac ??= gatewayEntry?.mac;
            if (d.vendor === 'onbekend' && gatewayVendor) d.vendor = gatewayVendor;
            d.provider ??= identifyProviderModem({ model: d.model, friendlyName: d.name, vendor: d.vendor })?.provider;
          }
          return r;
        },
      },
      source: { id: 'modem-upnp', kind: 'connector', product: 'upnp', level: '2P', network: 'eigen-netwerk' },
    });
  } else {
    notes.push(
      upnpLocation
        ? 'Het modem gaf een UPnP-adres dat we niet herkennen; model en internetadres zijn daarom niet uitgelezen.'
        : 'Het modem antwoordde niet op UPnP. Dan staat UPnP uit (dat is goed voor de veiligheid), of het modem antwoordt niet aan Docker. Model en internetadres zijn daarom niet uitgelezen.',
    );
  }

  const usedUpnp = connectors.length > 0;
  connectors.push({
    connector: {
      product: 'tabel',
      async read(): Promise<Readout> {
        return {
          product: 'tabel',
          readAt: now.toISOString(),
          // Zonder UPnP kennen we het modem alleen uit de ARP-tabel (MAC-prefix).
          devices:
            !usedUpnp && gatewayEntry
              ? [{ role: 'router', vendor: gatewayVendor ?? 'onbekend', name: 'Modem of router', ip: input.gateway, mac: gatewayEntry.mac, provider: identifyProviderModem({ vendor: gatewayVendor })?.provider }]
              : [],
          clients,
          wanIps: [],
          warnings: clients.length === 0 ? ['De ARP-tabel van je computer bevat nog geen andere apparaten'] : [],
        };
      },
    },
    source: { id: 'arp-tabel', kind: 'connector', product: 'qbicle-connector', level: '2P', network: 'eigen-netwerk' },
  });

  const result = await discover({
    connectors,
    oui: input.oui,
    vulnDb: input.vulnDb ?? new VulnDb(),
    eolDb: input.eolDb,
    now,
    // Een eenmalige sleutel: deze test bewaart geen gastapparaten over runs heen.
    privacy: { ...DEFAULT_PRIVACY, pseudonymKey: randomBytes(32) },
  });
  if (input.oui.size === 0) notes.push('Het register met MAC-fabrikanten ontbreekt, daardoor herkennen we minder apparaten.');
  return {
    ...result,
    gateway: input.gateway,
    upnpLocation: upnpLocation?.href,
    notes,
    evidence: Object.fromEntries(Object.entries(evidence).map(([ip, e]) => [ip, [...e]])),
    macs,
  };
}
