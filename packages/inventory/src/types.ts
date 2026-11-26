/**
 * Assetmodel voor de infra- en device-inventaris (proof of concept).
 *
 * Kernidee: we scheiden wat een bron zag (Observation) van wat Qbicle
 * daaruit concludeert (InventoryAsset). Waarnemingen uit verschillende
 * bronnen over hetzelfde ding worden samengevoegd; per kenmerk onthouden
 * we welke bron het leverde en wanneer.
 *
 * Dit pakket doet zelf geen netwerkverkeer. Het verwerkt alleen
 * waarnemingen die koppelingen, de connector of de scanner aanleveren.
 */

import type { Certainty } from '@qbicle/score';

/**
 * Scanniveau van de bron (zie ontwerp, hoofdstuk Uitgangspunten).
 * 0 openbaar, 1 bezoek, 1C koppeling via API, 2P passief lokaal, 2A actief.
 * Niveau 3 (kwetsbaarheden uitproberen) bestaat bewust niet.
 */
export type Level = '0' | '1' | '1C' | '2P' | '2A';

export type SourceKind =
  | 'scanner' // bestaande buitenkant-scanner (domein, website, mail)
  | 'mdm' // Intune, Defender for Business
  | 'rmm' // NinjaOne, Datto RMM, N-able
  | 'identity' // Entra ID, Google Workspace
  | 'cloud' // AWS, Azure
  | 'netwerk' // router, firewall, wifi-controller via API
  | 'connector' // lokale connector (ARP, DHCP, mDNS)
  | 'internetdata' // Shodan, Censys, Shadowserver
  | 'opgegeven' // door klant of IT-partner ingevuld
  | 'afleiding'; // Qbicle leidt het zelf af (MAC-prefix, hostnaam, diensten); altijd "mogelijk"

export interface Source {
  /** Unieke id van de koppeling binnen de organisatie. */
  id: string;
  kind: SourceKind;
  /** Productnaam, bijvoorbeeld "intune" of "unifi". */
  product: string;
  level: Level;
  /** Netwerk waar deze bron in kijkt (voor lokale bronnen), bijvoorbeeld "kantoor-utrecht". */
  network?: string;
}

export type AssetKind =
  | 'apparaat'
  | 'netwerkapparaat'
  | 'ip-adres'
  | 'ip-blok'
  | 'dienst'
  | 'domein'
  | 'subdomein'
  | 'website'
  | 'mailserver'
  | 'certificaat'
  | 'account'
  | 'cloudresource';

/** Categorie zoals de klant die ziet. */
export type Category =
  | 'laptop'
  | 'desktop'
  | 'telefoon'
  | 'tablet'
  | 'server'
  | 'printer'
  | 'camera'
  | 'nas'
  | 'router'
  | 'firewall'
  | 'accesspoint'
  | 'switch'
  | 'iot'
  | 'tv-media'
  | 'slimme-speaker'
  | 'alarmsysteem'
  | 'zonnepanelen'
  | 'laadpaal'
  | 'onbekend';

/** Waar het asset bereikbaar is. Wordt een factor in het scoremodel. */
export type Exposure = 'internet' | 'cloud' | 'intern' | 'onbekend';

export type Managed = 'ja' | 'nee' | 'onbekend';

export type IdentifierType =
  | 'serial' // serienummer van de fabrikant
  | 'cloud-id' // Entra device-ID, Intune-ID, AWS instance-ID, ...
  | 'mac'
  /** Gepseudonimiseerd MAC-adres (HMAC per organisatie), voor gastapparaten (AVG). */
  | 'mac-hash'
  | 'hostname'
  | 'ip'
  | 'fqdn'
  | 'url'
  | 'cert' // SHA-256 van een certificaat
  | 'upn'; // gebruikersaccount

/** Sterk: genoeg om op samen te voegen. Zwak: alleen in combinatie. */
export type Strength = 'sterk' | 'zwak';

export interface Identifier {
  type: IdentifierType;
  value: string;
}

/** Kenmerken die een bron over een ding kan melden. */
export interface Attributes {
  name?: string;
  kind?: AssetKind;
  category?: Category;
  exposure?: Exposure;
  managed?: Managed;
  vendor?: string;
  model?: string;
  os?: string;
  osVersion?: string;
  firmware?: string;
  /** Datum van de laatste update of patch volgens de bron (ISO). */
  lastPatched?: string;
  mfa?: boolean;
  admin?: boolean;
  /** mDNS/SSDP-diensttypen die het apparaat aankondigt, bijvoorbeeld "_ipp._tcp". */
  services?: string[];
  /** Apparaat zit op het gastnetwerk volgens de router. */
  guest?: boolean;
  /** De bron meldt dat er een firmware-update klaarstaat. */
  updateAvailable?: boolean;
}

export type AttributeKey = keyof Attributes;

/** Wat één bron op één moment over één ding meldde. */
export interface Observation {
  source: Source;
  /** ISO-tijdstip van de waarneming. */
  observedAt: string;
  identifiers: Identifier[];
  attributes: Attributes;
  /** Hoe zeker de bron is; standaard "vastgesteld" voor API-bronnen. */
  certainty?: Certainty;
  /**
   * Wat Qbicle zelf uit deze waarneming afleidde (categorie uit hostnaam, fabrikant
   * uit MAC-prefix, ...). Telt als bron "afleiding" met zekerheid "mogelijk", zodat
   * zichtbaar blijft wat de bron meldde en wat wij concludeerden.
   */
  inferred?: Attributes;
}

/** Eén kenmerkwaarde met herkomst. */
export interface Provenanced<T> {
  value: T;
  sourceId: string;
  sourceKind: SourceKind;
  observedAt: string;
  certainty: Certainty;
}

export type ProvenancedAttributes = {
  [K in AttributeKey]?: Provenanced<NonNullable<Attributes[K]>>;
};

export type AssetStatus = 'actief' | 'verdwenen';

/** Het samengevoegde asset. */
export interface InventoryAsset {
  /** Stabiele sleutel binnen deze berekening: de sterkste identifier. */
  key: string;
  kind: AssetKind;
  category: Category;
  exposure: Exposure;
  managed: Managed;
  identifiers: Identifier[];
  attributes: ProvenancedAttributes;
  /** Alle waarden die een bron meldde maar die het niet werden (voor uitleg en audit). */
  conflicts: Array<{ key: AttributeKey; losing: Provenanced<unknown> }>;
  sourceIds: string[];
  firstSeen: string;
  lastSeen: string;
  status: AssetStatus;
}
