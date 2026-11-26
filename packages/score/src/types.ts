/**
 * Gedeelde typen tussen scanner en scoremodel.
 *
 * Zekerheidslabels volgen de Brand Guide en het technisch ontwerp:
 * elke bevinding zegt eerlijk hoe zeker we zijn.
 */

/** Hoe zeker is een bevinding. */
export type Certainty = 'vastgesteld' | 'mogelijk' | 'onbekend' | 'opgegeven';

/**
 * Zichtbaarheid van het asset, voor factor z in het scoremodel.
 * - primair: hoofddomein, de website op het hoofddomein of www, en mail
 * - subdomein: overige subdomeinen
 * - alleen-ct: assets die we alleen in certificaattransparantie-logs zien
 */
export type Visibility = 'primair' | 'subdomein' | 'alleen-ct';

export type AssetType =
  | 'domein'
  | 'subdomein'
  | 'host'
  | 'mailserver'
  | 'website'
  | 'certificaat'
  | 'dienst';

export interface Asset {
  type: AssetType;
  /** Bijvoorbeeld "voorbeeld.nl" of "https://www.voorbeeld.nl". */
  value: string;
  /** Waar we het asset vandaan hebben, bijvoorbeeld "opgegeven" of "dns". */
  source: string;
  visibility: Visibility;
}

/** Een kwetsbaarheid die aan een bevinding gekoppeld is (vanaf fase 4 gevuld). */
export interface LinkedVuln {
  cveId: string;
  cvss?: number;
  /** Staat in CISA Known Exploited Vulnerabilities. */
  inKev?: boolean;
  /** EPSS-kans op misbruik in de komende 30 dagen (0..1). */
  epss?: number;
  /** NCSC-advies met kans hoog. */
  ncscHigh?: boolean;
  /** Waarschuwing van het Digital Trust Center. */
  dtcWarning?: boolean;
}

export interface Finding {
  /** Vaste sleutel van het type bevinding, bijvoorbeeld "spf.plus_all". */
  key: string;
  /** De check die de bevinding opleverde. */
  checkKey: string;
  asset: Asset;
  certainty: Certainty;
  /** Korte titel in gewone taal. */
  title: string;
  /** Uitleg in gewone taal, met wat we precies zagen. */
  detail: string;
  /** Zelfde fout op hetzelfde asset = zelfde vingerafdruk, over scans heen. */
  fingerprint: string;
  vulns?: LinkedVuln[];
}

/**
 * Uitkomst van een check.
 * - ok: gecontroleerd en in orde
 * - finding: gecontroleerd, met minstens één bevinding
 * - unknown: we konden het niet vaststellen (nooit impliciet veilig)
 * - error: de check zelf faalde
 * - not_applicable: de check is niet van toepassing (bijv. geen website)
 */
export type Outcome = 'ok' | 'finding' | 'unknown' | 'error' | 'not_applicable';
