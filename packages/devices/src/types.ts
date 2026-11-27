/**
 * Apparaatherkenning via routers en netwerkapparatuur (stap 1 uit het bouwplan Infra & Devices).
 *
 * Een connector leest alleen wat het netwerkapparaat zelf al weet: zijn eigen
 * model en firmware, het WAN-adres en de lijst met verbonden apparaten
 * (DHCP-leases, ARP-tabel, clientlijst). Hij stuurt zelf geen verkeer naar die
 * apparaten: geen ping, geen poortscan, geen bannergrab. Dat is niveau 1C.
 */

import type { Secret } from './secrets.ts';

/** Merken met een eigen API-connector. */
export type RouterProduct = 'unifi' | 'fritzbox' | 'mikrotik' | 'meraki';

/**
 * Alle soorten connectors. Naast de merk-API's een generieke route voor oudere of
 * onbekende apparatuur: SNMP (standaard-MIB's die bijna elke router en switch kent)
 * en "tabel" (ARP- en DHCP-tabellen die de lokale connector of een beheerder aanlevert).
 */
export type ConnectorProduct = RouterProduct | 'snmp' | 'tabel' | 'upnp';

/** Het netwerkapparaat zelf (router, firewall, accesspoint, switch). */
export interface NetworkDevice {
  /** Rol van het apparaat in het netwerk. */
  role: 'router' | 'firewall' | 'accesspoint' | 'switch' | 'gateway';
  vendor: string;
  model?: string;
  name?: string;
  mac?: string;
  serial?: string;
  ip?: string;
  /** Firmware- of OS-versie zoals het apparaat die meldt, ruw. */
  firmware?: string;
  /** Productnaam van de firmware, bijvoorbeeld "RouterOS" of "FRITZ!OS". */
  firmwareProduct?: string;
  /** Het apparaat meldt zelf dat er een nieuwere firmware is. */
  updateAvailable?: boolean;
  /** Providermodem: de provider (KPN, Ziggo, Odido, ...) beheert dit apparaat en zijn firmware. */
  provider?: string;
}

/**
 * Een poort die de router doorzet van internet naar een apparaat binnen.
 * Dit lezen we uit de router (UPnP-portmappings, NAT-regels); we scannen er niet voor.
 */
export interface PortForward {
  protocol: 'tcp' | 'udp';
  externalPort: number;
  internalIp: string;
  internalPort: number;
  description?: string;
  enabled: boolean;
  /** upnp: een apparaat heeft de poort zelf geopend; regel: door een beheerder ingesteld. */
  origin: 'upnp' | 'regel';
  /**
   * Alleen bereikbaar vanaf deze adressen (zoals de router het meldt). Leeg of
   * ontbrekend = vanaf heel internet.
   */
  allowedFrom?: string[];
  /** Het apparaat staat met álle poorten open naar internet (1:1 NAT of DMZ). */
  allPorts?: boolean;
}

/** Een apparaat dat de router kent (client). */
export interface ClientDevice {
  mac?: string;
  ip?: string;
  hostname?: string;
  /** Fabrikant zoals de router die meldt (sommige routers zoeken de MAC-prefix zelf op). */
  vendor?: string;
  /** Apparaattype of model zoals de router het meldt, ruw. */
  model?: string;
  /** "wired" of "wireless", als de router het weet. */
  connection?: 'bekabeld' | 'draadloos';
  /** Op het gastnetwerk volgens de router. */
  guest?: boolean;
  /** Nu verbonden (true) of alleen nog in de tabel (false). */
  active?: boolean;
  /** Laatste keer gezien volgens de router (ISO), als die dat meldt. */
  lastSeen?: string;
  /** mDNS/SSDP-diensten, als de router die doorgeeft (komt vooral van de connector). */
  services?: string[];
}

/** Alles wat één uitlezing van één router opleverde. */
export interface Readout {
  product: ConnectorProduct;
  /** ISO-tijdstip van de uitlezing. */
  readAt: string;
  /** Het apparaat zelf, plus bij UniFi ook de accesspoints en switches. */
  devices: NetworkDevice[];
  clients: ClientDevice[];
  /** Publieke IP-adressen van de internetaansluiting, als de router die meldt. */
  wanIps: string[];
  /** Poorten die vanaf internet naar binnen worden doorgezet, als de router dat meldt. */
  portForwards?: PortForward[];
  /**
   * De lijst met doorgezette poorten is volledig uitgelezen (ook als hij leeg is).
   * Ontbreekt dit of is het false, dan weten we het niet: "niet gecontroleerd",
   * nooit "geen open poorten".
   */
  portForwardsRead?: boolean;
  /**
   * WAN-adres van de router zelf als dat een privé-adres is: dan staat deze router
   * achter een andere router, meestal het modem van de provider (dubbele NAT).
   */
  privateWanIp?: string;
  /** UPnP staat aan op dit apparaat (apparaten kunnen zelf poorten openzetten). */
  upnpEnabled?: boolean;
  /** Wat niet gelukt is (deel van de uitlezing), in gewone taal. Nooit met wachtwoorden of tokens. */
  warnings: string[];
}

/** Inloggegevens voor een router. Altijd verpakt in Secret, zodat ze nooit in logs belanden. */
export type RouterCredentials =
  | { kind: 'api-key'; apiKey: Secret }
  | { kind: 'wachtwoord'; username: string; password: Secret };

export interface TlsSettings {
  /**
   * systeem: normaal certificaat (bijvoorbeeld UniFi Site Manager in de cloud).
   * vastgepind: zelfondertekend certificaat van de router, vastgelegd bij het koppelen.
   * Er is bewust geen optie "certificaat niet controleren".
   */
  mode: 'systeem' | 'vastgepind';
  /** PEM van het vastgepinde certificaat. */
  certPem?: string;
  /** Optioneel extra: SHA-256-vingerafdruk ("AA:BB:..."), zoals Node die geeft. */
  fingerprint256?: string;
}

export interface ConnectorConfig {
  product: RouterProduct;
  /** Basis-URL van de router of controller, bijvoorbeeld "https://192.168.1.1". */
  baseUrl: string;
  credentials: RouterCredentials;
  tls: TlsSettings;
  /** UniFi: site-id of -naam; Meraki: organisatie-id. Standaard alle. */
  site?: string;
  /** Time-out per verzoek in ms. Standaard 10 seconden. */
  timeoutMs?: number;
}

export interface RouterConnector {
  readonly product: ConnectorProduct;
  /** Leest het netwerkapparaat en zijn clients uit. Alleen lezen. */
  read(): Promise<Readout>;
}
