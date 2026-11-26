/**
 * Scoremodel Qbicle Light, versie light-2026.11-v0.2.
 *
 * Gewichten (b) komen uit het technisch ontwerp waar ze daar genoemd zijn.
 * Gewichten met `voorlopig: true` staan niet in het ontwerp en zijn een eerste
 * inschatting; ze worden in de pilot gekalibreerd met een securityspecialist.
 *
 * Wijzig je een gewicht, verhoog dan MODEL_VERSION. Elke score-snapshot bewaart
 * de versie, zodat oude rapporten niet veranderen.
 */

export const MODEL_VERSION = 'light-2026.11-v0.2';

/**
 * v0.2, na de eerste testset (22 domeinen, 26-11-2026):
 * - dezelfde bevindingssleutel op meerdere assets (apex en www) telt één keer
 *   volledig en daarna met REPEAT_FACTOR;
 * - per asset telt alleen de zwaarste "kapot certificaat"-bevinding (CERT_BROKEN_KEYS);
 * - per actie een plafond (ACTION_CAP), zodat hygiëne niet optelt tot hoge urgentie.
 */
export const REPEAT_FACTOR = 0.25;

/** Bevindingen die samen één probleem zijn: een certificaat dat browsers weigeren. */
export const CERT_BROKEN_KEYS = new Set([
  'cert.expired',
  'cert.invalid',
  'cert.chain_incomplete',
  'cert.self_signed',
  'cert.untrusted_ca',
  'cert.name_mismatch',
]);

/** Maximaal gewicht per actie (voorlopig). */
export const ACTION_CAP: Record<string, number> = {
  'website-headers': 10,
  'cookies-beveiligen': 5,
  'versies-verbergen': 5,
};

/** Deler in de afvlakking 100 × (1 − e^(−som/DIVISOR)). */
export const DIVISOR = 60;

export type ForWho = 'zelf' | 'it-partner' | 'webbouwer';

export interface ActionDef {
  title: string;
  why: string;
  forWho: ForWho;
}

export interface WeightDef {
  b: number;
  action: string;
  voorlopig?: boolean;
}

export const ACTIONS: Record<string, ActionDef> = {
  'cert-vernieuwen': {
    title: 'Laat het certificaat van je website vernieuwen of repareren',
    why: 'Bezoekers krijgen een waarschuwing of de verbinding is niet te vertrouwen. Dat kost klanten en vertrouwen.',
    forWho: 'webbouwer',
  },
  'cert-automatisch': {
    title: 'Zorg dat het websitecertificaat automatisch wordt verlengd',
    why: 'Het certificaat verloopt binnenkort. Verloopt het, dan krijgen bezoekers een waarschuwing.',
    forWho: 'webbouwer',
  },
  'spf-instellen': {
    title: 'Leg vast welke servers namens jou mogen mailen (SPF)',
    why: 'Zonder deze instelling kan iedereen makkelijker mail versturen die van jouw domein lijkt te komen.',
    forWho: 'it-partner',
  },
  'spf-repareren': {
    title: 'Laat de SPF-instelling van je mail repareren',
    why: 'De instelling bevat een fout, waardoor ontvangers hem negeren of iedereen namens jou laten mailen.',
    forWho: 'it-partner',
  },
  'dmarc-instellen': {
    title: 'Zet DMARC aan, zodat anderen niet uit jouw naam kunnen mailen',
    why: 'DMARC vertelt ontvangers wat ze moeten doen met nepmail uit jouw naam. Nu staat het niet aan.',
    forWho: 'it-partner',
  },
  'dmarc-aanscherpen': {
    title: 'Laat DMARC stap voor stap strenger zetten',
    why: 'DMARC staat aan, maar nepmail uit jouw naam wordt nog gewoon afgeleverd.',
    forWho: 'it-partner',
  },
  'https-afdwingen': {
    title: 'Stuur alle bezoekers automatisch naar de beveiligde website (https)',
    why: 'Een deel van de bezoekers komt nu op een onbeveiligde verbinding terecht.',
    forWho: 'webbouwer',
  },
  'website-headers': {
    title: 'Laat de standaard beveiligingsinstellingen van je website aanzetten',
    why: 'Browsers kunnen je bezoekers extra beschermen, maar alleen als de website daarom vraagt.',
    forWho: 'webbouwer',
  },
  'cookies-beveiligen': {
    title: 'Laat cookies van je website beter beveiligen',
    why: 'Sommige cookies kunnen worden meegelezen of door scripts worden gestolen.',
    forWho: 'webbouwer',
  },
  'versies-verbergen': {
    title: 'Laat de website niet meer vertellen welke softwareversie hij gebruikt',
    why: 'Aanvallers zoeken gericht naar websites met een bekende, kwetsbare versie.',
    forWho: 'webbouwer',
  },
  'dnssec-aanzetten': {
    title: 'Vraag je domeinbeheerder om DNSSEC aan te zetten',
    why: 'DNSSEC voorkomt dat bezoekers en mail via vervalste antwoorden naar een verkeerde server gaan.',
    forWho: 'it-partner',
  },
  'dnssec-repareren': {
    title: 'Laat de DNSSEC-instelling van je domein direct repareren',
    why: 'DNSSEC staat aan maar klopt niet. Daardoor kan je domein voor een deel van internet onbereikbaar zijn.',
    forWho: 'it-partner',
  },
  'caa-instellen': {
    title: 'Leg vast welke partijen certificaten voor je domein mogen uitgeven (CAA)',
    why: 'Zo wordt het moeilijker om ongemerkt een certificaat voor jouw domein te laten maken.',
    forWho: 'it-partner',
  },
  'securitytxt-plaatsen': {
    title: 'Zet op je website hoe mensen beveiligingsproblemen kunnen melden',
    why: 'Wie een lek vindt, weet dan waar het gemeld kan worden, in plaats van het te laten liggen.',
    forWho: 'webbouwer',
  },
  // Infra-inventaris (routers en netwerkapparatuur). Alle teksten en gewichten voorlopig.
  'firmware-bijwerken': {
    title: 'Laat de software van je router en netwerkapparaten bijwerken',
    why: 'Er is een update of er zijn bekende lekken. Aanvallers zoeken juist naar routers en camera\'s die niet zijn bijgewerkt.',
    forWho: 'it-partner',
  },
  'apparaat-vervangen-of-bijwerken': {
    title: 'Werk apparaten met bekende lekken bij, of vervang ze',
    why: 'Op je netwerk hangt een apparaat met een bekende kwetsbaarheid. Via zo\'n apparaat kan een aanvaller verder je netwerk in.',
    forWho: 'it-partner',
  },
  'apparaat-in-beheer': {
    title: 'Neem laptops en telefoons op in je beheertool',
    why: 'Van apparaten die niet in beheer zijn weet niemand of ze updates krijgen.',
    forWho: 'it-partner',
  },
  'updates-installeren': {
    title: 'Installeer de achterstallige updates',
    why: 'Updates dichten lekken die al bekend zijn bij aanvallers.',
    forWho: 'it-partner',
  },
  'apparaat-vervangen': {
    title: 'Vervang apparaten die geen beveiligingsupdates meer krijgen',
    why: 'De fabrikant dicht nieuwe lekken in deze apparaten niet meer. Vooral bij een router is dat een open deur.',
    forWho: 'it-partner',
  },
  'poort-sluiten': {
    title: 'Sluit poorten die vanaf internet naar binnen open staan',
    why: 'Via een open poort kan iedereen op internet je apparaat proberen. Gebruik voor toegang op afstand een VPN.',
    forWho: 'it-partner',
  },
  'upnp-uitzetten': {
    title: 'Zet UPnP uit op je router',
    why: 'Met UPnP kunnen apparaten en malware zelf ongemerkt een opening naar internet maken.',
    forWho: 'it-partner',
  },
  'mfa-aanzetten': {
    title: 'Zet tweestapsverificatie aan voor beheerders',
    why: 'Met alleen een gestolen wachtwoord kan iemand anders alles overnemen.',
    forWho: 'it-partner',
  },
};

export const WEIGHTS: Record<string, WeightDef> = {
  // Certificaat
  'cert.expired': { b: 40, action: 'cert-vernieuwen' },
  'cert.invalid': { b: 40, action: 'cert-vernieuwen' },
  'cert.chain_incomplete': { b: 40, action: 'cert-vernieuwen' },
  'cert.self_signed': { b: 40, action: 'cert-vernieuwen' },
  'cert.untrusted_ca': { b: 40, action: 'cert-vernieuwen', voorlopig: true },
  'cert.name_mismatch': { b: 40, action: 'cert-vernieuwen' },
  'cert.expires_14d': { b: 20, action: 'cert-automatisch' },
  'cert.expires_30d': { b: 10, action: 'cert-automatisch', voorlopig: true },

  // E-mail: SPF
  'spf.plus_all': { b: 30, action: 'spf-repareren' },
  'spf.missing': { b: 15, action: 'spf-instellen' },
  'spf.multiple': { b: 15, action: 'spf-repareren', voorlopig: true },
  'spf.syntax': { b: 15, action: 'spf-repareren', voorlopig: true },
  'spf.too_many_lookups': { b: 15, action: 'spf-repareren', voorlopig: true },
  'spf.include_broken': { b: 15, action: 'spf-repareren', voorlopig: true },
  'spf.neutral_all': { b: 10, action: 'spf-repareren', voorlopig: true },
  'spf.no_all': { b: 5, action: 'spf-repareren', voorlopig: true },

  // E-mail: DMARC
  'dmarc.missing': { b: 20, action: 'dmarc-instellen' },
  'dmarc.multiple': { b: 20, action: 'dmarc-instellen', voorlopig: true },
  'dmarc.syntax': { b: 20, action: 'dmarc-instellen', voorlopig: true },
  'dmarc.p_none': { b: 10, action: 'dmarc-aanscherpen' },
  'dmarc.partial': { b: 5, action: 'dmarc-aanscherpen', voorlopig: true },
  'dmarc.sp_none': { b: 5, action: 'dmarc-aanscherpen', voorlopig: true },
  'dmarc.no_rua': { b: 2, action: 'dmarc-aanscherpen', voorlopig: true },

  // Domein
  'dnssec.missing': { b: 3, action: 'dnssec-aanzetten' },
  'dnssec.invalid': { b: 45, action: 'dnssec-repareren', voorlopig: true },
  'caa.missing': { b: 2, action: 'caa-instellen', voorlopig: true },

  // Website
  'web.no_https_redirect': { b: 10, action: 'https-afdwingen', voorlopig: true },
  'web.hsts_missing': { b: 5, action: 'website-headers' },
  'web.hsts_short': { b: 2, action: 'website-headers', voorlopig: true },
  'web.csp_missing': { b: 3, action: 'website-headers' },
  'web.framing_unprotected': { b: 3, action: 'website-headers', voorlopig: true },
  'web.xcto_missing': { b: 2, action: 'website-headers', voorlopig: true },
  'web.referrer_missing': { b: 1, action: 'website-headers', voorlopig: true },
  'web.cookie_insecure': { b: 5, action: 'cookies-beveiligen', voorlopig: true },
  'web.cookie_no_httponly': { b: 2, action: 'cookies-beveiligen', voorlopig: true },
  'web.version_disclosed': { b: 3, action: 'versies-verbergen', voorlopig: true },
  'web.securitytxt_missing': { b: 3, action: 'securitytxt-plaatsen' },
  'web.securitytxt_expired': { b: 2, action: 'securitytxt-plaatsen', voorlopig: true },

  // Infra-inventaris. Tellen alleen mee als de inventaris bevindingen aanlevert;
  // Light-rapporten veranderen er niet door. Kalibratie in de pilot, daarna eigen modelversie (infra-2027.x).
  'netwerkapparaat.kwetsbaarheid': { b: 30, action: 'firmware-bijwerken', voorlopig: true },
  'netwerkapparaat.update_beschikbaar': { b: 8, action: 'firmware-bijwerken', voorlopig: true },
  'apparaat.kwetsbaarheid': { b: 20, action: 'apparaat-vervangen-of-bijwerken', voorlopig: true },
  'netwerkapparaat.einde_ondersteuning': { b: 25, action: 'apparaat-vervangen', voorlopig: true },
  'netwerkapparaat.einde_ondersteuning_binnenkort': { b: 5, action: 'apparaat-vervangen', voorlopig: true },
  'apparaat.einde_ondersteuning': { b: 10, action: 'apparaat-vervangen', voorlopig: true },
  'apparaat.einde_ondersteuning_binnenkort': { b: 2, action: 'apparaat-vervangen', voorlopig: true },
  'apparaat.beheerpoort_open_naar_internet': { b: 30, action: 'poort-sluiten', voorlopig: true },
  'apparaat.poort_open_naar_internet': { b: 10, action: 'poort-sluiten', voorlopig: true },
  'netwerkapparaat.upnp_aan': { b: 3, action: 'upnp-uitzetten', voorlopig: true },
  'apparaat.onbeheerd': { b: 5, action: 'apparaat-in-beheer', voorlopig: true },
  'apparaat.updates_achter': { b: 10, action: 'updates-installeren', voorlopig: true },
  'account.admin_zonder_mfa': { b: 30, action: 'mfa-aanzetten', voorlopig: true },
};

/** Gewicht voor een onbekende sleutel: liever zichtbaar meetellen dan wegvallen. */
export const FALLBACK_WEIGHT: WeightDef = { b: 10, action: 'onbekend', voorlopig: true };

export interface Band {
  key: 'weinig' | 'aandacht' | 'hoog' | 'direct';
  label: string;
  min: number;
}

/** Banden uit het ontwerp, oplopend. */
export const BANDS: Band[] = [
  { key: 'weinig', label: 'Weinig urgent', min: 0 },
  { key: 'aandacht', label: 'Aandacht nodig', min: 25 },
  { key: 'hoog', label: 'Hoge urgentie', min: 50 },
  { key: 'direct', label: 'Direct oppakken', min: 75 },
];

export const VISIBILITY_FACTOR = {
  primair: 1.0,
  subdomein: 0.7,
  'alleen-ct': 0.5,
} as const;

export const CERTAINTY_FACTOR = {
  vastgesteld: 1.0,
  mogelijk: 0.5,
  onbekend: 0,
  // "Door jou opgegeven" is een feit van de klant zelf; telt als vastgesteld.
  opgegeven: 1.0,
} as const;

/** Maximaal aantal acties in het rapport. */
export const MAX_ACTIONS = 3;
