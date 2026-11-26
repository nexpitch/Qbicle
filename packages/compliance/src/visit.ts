import { lookup } from 'node:dns/promises';
import { isPublicIp, isSameOrSubdomain, SCANNER_VERSION } from '@qbicle/scanner';
import type { Browser, BrowserContext, LaunchOptions, Page, Route } from 'playwright-core';
import { DETECT_BANNER_JS, MARK_ATTR, type InPageBannerResult } from './banner.ts';
import type {
  BannerInfo,
  ConsentObservations,
  ObservedCookie,
  ObservedRequest,
  Scenario,
  VisitObservation,
} from './types.ts';

/**
 * Bezoekt een website drie keer met een gewone headless browser, elk keer met
 * een schoon profiel: (1) niets klikken, (2) op weigeren klikken, (3) op
 * accepteren klikken. Legt per bezoek vast welke cookies, opslag en verzoeken
 * naar derden er zijn.
 *
 * Wat deze code bewust NIET doet: formulieren invullen, inloggen, andere
 * knoppen dan die van de cookiebanner aanklikken, of iets anders dan GET-
 * en gewone browserverzoeken doen die de site zelf start.
 *
 * Veiligheidsregels (zelfde lijn als de scanner):
 * - alleen http en https;
 * - geen verbindingen met interne of gereserveerde IP-adressen, ook niet voor
 *   scripts of afbeeldingen van derden;
 * - de pagina zelf (hoofdframe) blijft op het opgegeven domein;
 * - vaste User-Agent met uitleglink, tijdslimieten en een maximum aantal verzoeken.
 *
 * Restrisico: Chromium doet zijn eigen DNS-lookup na onze controle (DNS-rebinding).
 * In productie draait de browser daarom achter een uitgaande proxy die dezelfde
 * IP-regels afdwingt. Zie docs/compliance.md.
 */

export interface ConsentCheckOptions {
  /** Domein dat als eerste partij telt; standaard de host van de URL. */
  domain?: string;
  /** Een bestaande browser (tests); anders starten we Chromium zelf. */
  browser?: Browser;
  launchOptions?: LaunchOptions;
  /** Tijdslimiet per pagina in ms. */
  timeoutMs?: number;
  /** Maximale wachttijd na laden en na klikken, zodat scripts hun cookies kunnen zetten. */
  settleMs?: number;
  maxRequests?: number;
  /**
   * Mag dit verzoek doorgaan? Standaard: host moet naar een publiek IP-adres wijzen.
   * Geeft een reden terug als het verzoek geblokkeerd wordt.
   */
  guard?: (url: URL) => Promise<string | undefined>;
  infoUrl?: string;
  /**
   * Alleen voor tests: draait op elk nieuw browserprofiel vóór onze bewaking.
   * Tests beantwoorden hiermee verzoeken lokaal; onze bewaking blijft eerst beslissen.
   */
  prepareContext?: (context: BrowserContext) => Promise<void>;
}

export const DEFAULT_INFO_URL = 'https://qbicle.nl/scanner';

export function userAgent(infoUrl = DEFAULT_INFO_URL): string {
  // Chromium-achtige UA zodat sites hun normale versie tonen, plus een herkenbare Qbicle-markering.
  return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 QbicleComplianceCheck/${SCANNER_VERSION} (+${infoUrl})`;
}

/** Standaardbewaking: alleen http(s) en alleen publieke IP-adressen. */
export function publicNetworkGuard(): (url: URL) => Promise<string | undefined> {
  const cache = new Map<string, Promise<string | undefined>>();
  return (url) => {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return Promise.resolve(undefined);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    let p = cache.get(host);
    if (!p) {
      p = lookup(host, { all: true })
        .then((addrs) =>
          addrs.length > 0 && addrs.every((a) => isPublicIp(a.address)) ? undefined : 'intern of gereserveerd adres',
        )
        .catch(() => 'host niet gevonden');
      cache.set(host, p);
    }
    return p;
  };
}

const SCENARIOS: Scenario[] = ['geen-keuze', 'weigeren', 'accepteren'];

export async function runConsentCheck(url: string, opts: ConsentCheckOptions = {}): Promise<ConsentObservations> {
  const start = Date.now();
  const target = new URL(url);
  const domain = (opts.domain ?? target.hostname).toLowerCase().replace(/^www\./, '');
  const guard = opts.guard ?? publicNetworkGuard();

  let browser = opts.browser;
  let own = false;
  if (!browser) {
    const { chromium } = await import('playwright-core');
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.QBICLE_CHROMIUM_PATH || undefined,
      ...opts.launchOptions,
    });
    own = true;
  }

  try {
    const visits = {} as Record<Scenario, VisitObservation>;
    // Na elkaar, niet parallel: netjes voor de site en makkelijker te volgen in hun logs.
    for (const scenario of SCENARIOS) {
      visits[scenario] = await visit(browser, target, domain, scenario, guard, opts);
    }
    return { domain, url: target.href, visits, startedAt: new Date(start).toISOString(), durationMs: Date.now() - start };
  } finally {
    if (own) await browser.close();
  }
}

async function visit(
  browser: Browser,
  target: URL,
  domain: string,
  scenario: Scenario,
  guard: (url: URL) => Promise<string | undefined>,
  opts: ConsentCheckOptions,
): Promise<VisitObservation> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const settleMs = opts.settleMs ?? 5_000;
  const maxRequests = opts.maxRequests ?? 400;

  const obs: VisitObservation = {
    scenario,
    url: target.href,
    loaded: false,
    banner: { found: false, acceptFound: false, rejectFound: false },
    cookies: [],
    requests: [],
    storageKeys: [],
  };

  const context: BrowserContext = await browser.newContext({
    userAgent: userAgent(opts.infoUrl),
    locale: 'nl-NL',
    timezoneId: 'Europe/Amsterdam',
    viewport: { width: 1280, height: 900 },
    serviceWorkers: 'block',
    acceptDownloads: false,
  });
  context.setDefaultTimeout(timeoutMs);
  const activity = trackActivity(context);
  if (opts.prepareContext) await opts.prepareContext(context);

  await context.route('**/*', async (route: Route) => {
    const req = route.request();
    let u: URL;
    try {
      u = new URL(req.url());
    } catch {
      return route.abort();
    }
    // fallback = doorgaan naar het netwerk (of naar een eerder geregistreerde handler in tests).
    if (u.protocol === 'data:' || u.protocol === 'blob:') return route.fallback();
    const entry: ObservedRequest = {
      url: stripQueryValues(u),
      host: u.hostname.toLowerCase(),
      method: req.method(),
      resourceType: req.resourceType(),
      thirdParty: !isSameOrSubdomain(u.hostname.toLowerCase(), domain),
    };
    let reason: string | undefined;
    if (u.protocol !== 'http:' && u.protocol !== 'https:') reason = 'protocol niet toegestaan';
    else if (obs.requests.length >= maxRequests) reason = 'maximum aantal verzoeken bereikt';
    else if (entry.thirdParty && isMainFrameNavigation(req))
      reason = 'pagina wil naar een ander domein; dat volgen we niet';
    else reason = await guard(u);
    if (obs.requests.length < maxRequests) obs.requests.push(reason ? { ...entry, blocked: reason } : entry);
    return reason ? route.abort('blockedbyclient') : route.fallback();
  });

  try {
    const page = await context.newPage();
    const resp = await page.goto(target.href, { waitUntil: 'load', timeout: timeoutMs });
    obs.loaded = !!resp && resp.status() < 400;
    obs.finalUrl = page.url();
    if (!obs.loaded) obs.error = `De pagina gaf status ${resp?.status() ?? 'onbekend'}.`;
    await settle(page, activity, settleMs);

    obs.banner = await findBanner(page);

    if (scenario !== 'geen-keuze') {
      const which = scenario === 'accepteren' ? 'accept' : 'reject';
      const available = which === 'accept' ? obs.banner.acceptFound : obs.banner.rejectFound;
      if (available) {
        obs.clicked = await clickMarked(page, which, timeoutMs);
        await settle(page, activity, settleMs);
      }
    }

    obs.cookies = (await context.cookies()).map(
      (c): ObservedCookie => ({
        name: c.name,
        domain: c.domain,
        path: c.path,
        expires: c.expires,
        secure: c.secure,
        httpOnly: c.httpOnly,
        sameSite: c.sameSite,
      }),
    );
    obs.storageKeys = await page
      .evaluate(() => {
        try {
          return Object.keys(localStorage);
        } catch {
          return [] as string[];
        }
      })
      .catch(() => []);
  } catch (e) {
    obs.error = e instanceof Error ? e.message.split('\n')[0] : String(e);
  } finally {
    await context.close();
  }
  return obs;
}

function isMainFrameNavigation(req: ReturnType<Route['request']>): boolean {
  if (!req.isNavigationRequest()) return false;
  try {
    const frame = req.frame();
    return frame === frame.page().mainFrame();
  } catch {
    return true; // Bij twijfel behandelen als hoofdpagina: liever te streng.
  }
}

/** Houdt bij hoeveel verzoeken er lopen, zodat we kunnen wachten tot het stil is. */
function trackActivity(context: BrowserContext) {
  let inflight = 0;
  let last = Date.now();
  const up = () => {
    inflight++;
    last = Date.now();
  };
  const down = () => {
    inflight = Math.max(0, inflight - 1);
    last = Date.now();
  };
  context.on('request', up);
  context.on('requestfinished', down);
  context.on('requestfailed', down);
  return { quietFor: () => (inflight === 0 ? Date.now() - last : 0) };
}

/**
 * Wacht tot er 500 ms geen verzoeken meer lopen, maar nooit langer dan ms.
 * (Playwrights "networkidle" helpt na een klik niet: die status blijft staan van het laden.)
 */
async function settle(page: Page, activity: ReturnType<typeof trackActivity>, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  const quiet = Math.min(500, ms);
  await page.waitForTimeout(100);
  while (Date.now() < deadline && activity.quietFor() < quiet) await page.waitForTimeout(50);
}

async function findBanner(page: Page): Promise<BannerInfo> {
  // Hoofdframe eerst, daarna iframes (sommige cookieplatforms tonen hun banner in een iframe).
  for (const frame of [page.mainFrame(), ...page.frames().filter((f) => f !== page.mainFrame())]) {
    const r = (await frame
      .evaluate(`(${DETECT_BANNER_JS})(${JSON.stringify(MARK_ATTR)})`)
      .catch(() => ({}))) as InPageBannerResult;
    if (r.platform) {
      return {
        found: true,
        platform: r.platform,
        acceptFound: !!r.acceptText,
        rejectFound: !!r.rejectText,
        acceptText: r.acceptText,
        rejectText: r.rejectText,
      };
    }
  }
  return { found: false, acceptFound: false, rejectFound: false };
}

async function clickMarked(
  page: Page,
  which: 'accept' | 'reject',
  timeoutMs: number,
): Promise<NonNullable<VisitObservation['clicked']>> {
  for (const frame of page.frames()) {
    const loc = frame.locator(`[${MARK_ATTR}="${which}"]`).first();
    if ((await loc.count()) === 0) continue;
    try {
      await loc.click({ timeout: Math.min(timeoutMs, 5_000) });
      return { target: which, ok: true };
    } catch (e) {
      return { target: which, ok: false, error: e instanceof Error ? e.message.split('\n')[0] : String(e) };
    }
  }
  return { target: which, ok: false, error: 'knop niet meer gevonden' };
}

/**
 * Bewaart een URL zonder de waarden van query-parameters: die kunnen
 * persoonsgegevens of id's bevatten. De namen bewaren we wel, omdat die
 * bewijs zijn (bijvoorbeeld de Consent Mode-parameter gcs van Google).
 */
export function stripQueryValues(u: URL): string {
  const keep = new Set(['gcs', 'gcd']); // Consent Mode-signalen: geen persoonsgegevens, wel bewijs.
  const params = [...u.searchParams.keys()].map((k) => (keep.has(k) ? `${k}=${u.searchParams.get(k)}` : k));
  return `${u.protocol}//${u.host}${u.pathname}${params.length ? `?${[...new Set(params)].join('&')}` : ''}`;
}
