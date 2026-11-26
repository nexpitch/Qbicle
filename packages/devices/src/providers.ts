/**
 * Providermodems herkennen (KPN, Ziggo, Odido en anderen).
 *
 * Dit is bij veel MKB-bedrijven en thuiswerkers de eerste router: het modem dat
 * de provider levert. De beheerdersgegevens heeft de klant meestal niet, en de
 * provider beheert de firmware op afstand. Wat we zonder providerlogin wel kunnen:
 *
 * - herkennen welk modem het is: UPnP-beschrijving (fabrikant, model), MAC-prefix
 *   van de gateway en de netwerkeigenaar (ASN) van het WAN-adres;
 * - het WAN-adres en de poorten die apparaten via UPnP hebben opengezet;
 * - de apparaten erachter via de generieke laag (ARP, DHCP, mDNS) van de connector;
 * - de buitenkant (stap 2, na akkoord) voor wat er echt openstaat.
 *
 * De tabellen hieronder zijn een startpunt en moeten worden gecontroleerd en
 * aangevuld met echte apparaten (zie docs/apparaatherkenning.md).
 */
export interface ProviderHint {
  provider: string;
  /** Model- of naampatronen zoals ze in de UPnP-beschrijving of hostnaam staan. */
  model: RegExp;
}

export const PROVIDER_MODELS: ProviderHint[] = [
  { provider: 'KPN', model: /experia\s*box|kpn\s*box/i },
  { provider: 'Ziggo', model: /connect\s*box|smartwifi|ziggo/i },
  { provider: 'Odido', model: /odido|t-mobile\s*thuis|tmobile/i },
  { provider: 'Delta / Caiway', model: /\bdelta\b|caiway/i },
];

/** Fabrikanten die vooral modems voor providers maken (uit het IEEE-register). */
export const PROVIDER_MODEM_VENDORS = /arcadyan|sagemcom|compal broadband|technicolor|vantiva|askey|commscope|arris|zte corporation|huawei technologies|sercomm|genexis|nokia solutions/i;

/**
 * Netwerkeigenaar van het WAN-adres (ASN, uit RIPE). Alleen nummers die we zeker
 * weten; aanvullen en controleren via RIPEstat voordat dit live gaat.
 */
export const PROVIDER_ASNS: Record<number, string> = {
  1136: 'KPN',
  33915: 'Ziggo',
};

export interface ProviderModemGuess {
  provider?: string;
  /** Hoe zeker: model genoemd = vastgesteld; alleen fabrikant of ASN = mogelijk. */
  certainty: 'vastgesteld' | 'mogelijk';
  reasons: string[];
}

export function identifyProviderModem(input: { model?: string; friendlyName?: string; vendor?: string; wanAsn?: number }): ProviderModemGuess | undefined {
  const reasons: string[] = [];
  const text = [input.model, input.friendlyName].filter(Boolean).join(' ');
  const byModel = PROVIDER_MODELS.find((p) => p.model.test(text));
  if (byModel) return { provider: byModel.provider, certainty: 'vastgesteld', reasons: [`model "${text}" is een modem van ${byModel.provider}`] };
  const byAsn = input.wanAsn !== undefined ? PROVIDER_ASNS[input.wanAsn] : undefined;
  if (byAsn) reasons.push(`internetadres hoort bij ${byAsn} (AS${input.wanAsn})`);
  const vendorHit = input.vendor && PROVIDER_MODEM_VENDORS.test(input.vendor);
  if (vendorHit) reasons.push(`fabrikant ${input.vendor} maakt vooral modems voor providers`);
  if (!byAsn && !vendorHit) return undefined;
  return { provider: byAsn, certainty: 'mogelijk', reasons };
}
