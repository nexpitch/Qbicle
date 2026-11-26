import type { Category, ObservedCookie, ObservedRequest } from './types.ts';

/**
 * Bekende trackers en cookies. Bewust klein en handmatig bijgehouden: elke
 * regel moet uit te leggen zijn aan een klant. Later aan te vullen met een
 * open lijst (bijvoorbeeld de Open Cookie Database), met bronvermelding.
 */
export interface TrackerDef {
  id: string;
  /** Naam zoals de klant hem kent. */
  name: string;
  vendor: string;
  category: Category;
  /** Hostnamen (en hun subdomeinen) waar de tracker vandaan laadt of naartoe meldt. */
  hosts: string[];
  /** Alleen verzoeken met dit pad tellen (bijv. het meetpixel van Facebook op facebook.com/tr). */
  pathPrefix?: string;
  /** Cookienamen die bij deze tracker horen. */
  cookies: RegExp[];
}

export const TRACKERS: TrackerDef[] = [
  {
    id: 'google-analytics',
    name: 'Google Analytics',
    vendor: 'Google',
    category: 'analytisch',
    hosts: ['google-analytics.com', 'analytics.google.com'],
    cookies: [/^_ga$/, /^_ga_[A-Z0-9]+$/, /^_gid$/, /^_gat(_.*)?$/, /^__utm[abcz]$/],
  },
  {
    id: 'google-tag-manager',
    name: 'Google Tag Manager',
    vendor: 'Google',
    category: 'tagmanager',
    hosts: ['googletagmanager.com'],
    cookies: [],
  },
  {
    id: 'google-ads',
    name: 'Google Ads en DoubleClick',
    vendor: 'Google',
    category: 'marketing',
    hosts: ['doubleclick.net', 'googleadservices.com', 'googlesyndication.com', 'google-ads.com'],
    cookies: [/^_gcl_(au|aw|dc|gb)$/, /^IDE$/, /^test_cookie$/, /^DSID$/],
  },
  {
    id: 'meta-pixel',
    name: 'Meta (Facebook) Pixel',
    vendor: 'Meta',
    category: 'marketing',
    hosts: ['connect.facebook.net'],
    cookies: [/^_fbp$/, /^_fbc$/, /^fr$/],
  },
  {
    id: 'meta-pixel-beacon',
    name: 'Meta (Facebook) Pixel',
    vendor: 'Meta',
    category: 'marketing',
    hosts: ['facebook.com'],
    pathPrefix: '/tr',
    cookies: [],
  },
  {
    id: 'linkedin-insight',
    name: 'LinkedIn Insight Tag',
    vendor: 'LinkedIn',
    category: 'marketing',
    hosts: ['snap.licdn.com', 'px.ads.linkedin.com'],
    cookies: [/^li_fat_id$/, /^bcookie$/, /^lidc$/, /^li_sugr$/, /^UserMatchHistory$/, /^AnalyticsSyncHistory$/],
  },
  {
    id: 'hotjar',
    name: 'Hotjar',
    vendor: 'Hotjar (Contentsquare)',
    category: 'marketing',
    hosts: ['hotjar.com', 'hotjar.io'],
    cookies: [/^_hj/],
  },
  {
    id: 'microsoft-clarity',
    name: 'Microsoft Clarity',
    vendor: 'Microsoft',
    category: 'marketing',
    hosts: ['clarity.ms'],
    cookies: [/^_clck$/, /^_clsk$/, /^CLID$/, /^MUID$/],
  },
  {
    id: 'microsoft-ads',
    name: 'Microsoft Advertising (Bing)',
    vendor: 'Microsoft',
    category: 'marketing',
    hosts: ['bat.bing.com'],
    cookies: [/^_uetsid$/, /^_uetvid$/],
  },
  {
    id: 'tiktok-pixel',
    name: 'TikTok Pixel',
    vendor: 'TikTok',
    category: 'marketing',
    hosts: ['analytics.tiktok.com'],
    cookies: [/^_ttp$/, /^_tt_enable_cookie$/],
  },
  {
    id: 'youtube',
    name: 'YouTube (ingesloten video)',
    vendor: 'Google',
    category: 'marketing',
    hosts: ['youtube.com'],
    cookies: [/^VISITOR_INFO1_LIVE$/, /^YSC$/, /^VISITOR_PRIVACY_METADATA$/],
  },
  {
    id: 'matomo',
    name: 'Matomo',
    vendor: 'Matomo (vaak zelf gehost)',
    category: 'analytisch',
    hosts: ['matomo.cloud'],
    cookies: [/^_pk_(id|ses|ref)/],
  },
];

/**
 * Cookies van cookiebanners zelf: die slaan alleen de keuze van de bezoeker op
 * en zijn functioneel.
 */
const CONSENT_COOKIES: RegExp[] = [
  /^CookieConsent$/, // Cookiebot
  /^OptanonConsent$/, // OneTrust
  /^OptanonAlertBoxClosed$/,
  /^eupubconsent(-v2)?$/, // IAB TCF
  /^cookieyes-consent$/,
  /^cmplz_/, // Complianz
  /^qbicle_testkeuze$/, // alleen in onze testpagina's
];

export function isConsentCookie(name: string): boolean {
  return CONSENT_COOKIES.some((r) => r.test(name));
}

export function hostMatches(host: string, base: string): boolean {
  const h = host.toLowerCase();
  return h === base || h.endsWith(`.${base}`);
}

export function trackerForCookie(cookie: Pick<ObservedCookie, 'name'>): TrackerDef | undefined {
  return TRACKERS.find((t) => t.cookies.some((r) => r.test(cookie.name)));
}

export function trackerForRequest(req: Pick<ObservedRequest, 'url' | 'host'>): TrackerDef | undefined {
  let path = '/';
  try {
    path = new URL(req.url).pathname;
  } catch {
    // Ongeldige URL: alleen op host vergelijken.
  }
  return TRACKERS.find(
    (t) => t.hosts.some((h) => hostMatches(req.host, h)) && (!t.pathPrefix || path.startsWith(t.pathPrefix)),
  );
}

/** Of een tracker of cookie in deze categorie toestemming vraagt. */
export function needsConsent(category: Category): boolean {
  return category === 'analytisch' || category === 'marketing';
}
