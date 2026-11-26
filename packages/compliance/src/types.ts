/**
 * Typen voor de compliance-checks (proof of concept: cookiecheck).
 *
 * We leggen eerst vast wat een gewone bezoeker te zien krijgt (waarnemingen),
 * en beoordelen dat daarna in een losse, pure stap (evaluate.ts). Zo kunnen we
 * de beoordeling testen en aanpassen zonder opnieuw een browser te starten.
 */

/** Drie bezoeken, elk in een schoon browserprofiel. */
export type Scenario = 'geen-keuze' | 'weigeren' | 'accepteren';

/** Soort tracker of cookie. Bepaalt of toestemming nodig is. */
export type Category =
  /** Nodig voor de werking (sessie, winkelmand, opgeslagen cookiekeuze). Geen toestemming nodig. */
  | 'functioneel'
  /**
   * Statistieken. Toestemming is nodig, tenzij de analytics privacyvriendelijk is
   * ingesteld; dat kunnen we van buiten niet zien. [jurist]
   */
  | 'analytisch'
  /** Advertenties, profielen, social media, sessie-opnames. Altijd toestemming nodig. */
  | 'marketing'
  /** Laadt andere scripts maar meet zelf niets (bijv. Google Tag Manager). */
  | 'tagmanager'
  /** Herkennen we niet. Wordt getoond, maar niet als overtreding gerekend. */
  | 'onbekend';

export interface ObservedCookie {
  name: string;
  domain: string;
  path: string;
  /** Unix-tijd in seconden; -1 = sessiecookie. */
  expires: number;
  secure: boolean;
  httpOnly: boolean;
  sameSite: string;
}

export interface ObservedRequest {
  url: string;
  host: string;
  method: string;
  resourceType: string;
  /** Host hoort niet bij het gescande domein. */
  thirdParty: boolean;
  /** Door onze veiligheidsregels tegengehouden (intern adres, ander protocol, limiet). */
  blocked?: string;
}

export type ConsentPlatform = 'cookiebot' | 'onetrust' | 'cookieyes' | 'complianz' | 'algemeen';

export interface BannerInfo {
  found: boolean;
  /** Herkend cookieplatform, of 'algemeen' als we de knoppen op tekst vonden. */
  platform?: ConsentPlatform;
  acceptFound: boolean;
  /** Een weigerknop (of "alleen noodzakelijk") op de eerste laag van de banner. */
  rejectFound: boolean;
  acceptText?: string;
  rejectText?: string;
}

export interface VisitObservation {
  scenario: Scenario;
  url: string;
  /** Uiteindelijke URL na redirects. */
  finalUrl?: string;
  loaded: boolean;
  banner: BannerInfo;
  /** Op welke knop we klikten, en of dat lukte. */
  clicked?: { target: 'accept' | 'reject'; ok: boolean; error?: string };
  cookies: ObservedCookie[];
  requests: ObservedRequest[];
  /** Namen van sleutels in localStorage (geen waarden: die kunnen persoonsgegevens bevatten). */
  storageKeys: string[];
  error?: string;
}

export interface ConsentObservations {
  /** Het domein waarop we de site beoordelen (eerste partij). */
  domain: string;
  url: string;
  visits: Record<Scenario, VisitObservation>;
  startedAt: string;
  durationMs: number;
}
