import type { Asset } from '@qbicle/score';
import type { HttpResponse } from '../net.ts';
import type { Check, CheckContext, FindingDraft } from '../types.ts';
import { isSameOrSubdomain } from '../domain.ts';

const MAX_REDIRECTS = 5;
const HSTS_MIN_SECONDS = 15_552_000; // 180 dagen

export function hostOf(asset: Asset): string {
  return new URL(asset.value).hostname;
}

export interface Chain {
  hops: HttpResponse[];
  final: HttpResponse;
  /**
   * Als de website doorverwijst naar een ander domein, volgen we niet verder:
   * dat domein is niet van de klant (of moet apart gescand worden).
   */
  leftDomainTo: string | null;
}

/**
 * Volgt redirects zoals een browser, maximaal 5 stappen, alleen http(s)
 * en alleen binnen het gescande domein en zijn subdomeinen.
 */
export async function fetchChain(ctx: CheckContext, start: string): Promise<Chain> {
  return ctx.memo(`chain:${start}`, async () => {
    const hops: HttpResponse[] = [];
    let url = start;
    let leftDomainTo: string | null = null;
    const seen = new Set<string>();
    for (let i = 0; i <= MAX_REDIRECTS; i++) {
      if (seen.has(url)) break;
      seen.add(url);
      const res = await ctx.memo(`get:${url}`, () => ctx.net.httpGet(url));
      hops.push(res);
      const loc = res.headers.location;
      if (res.status < 300 || res.status >= 400 || !loc) break;
      let next: URL;
      try {
        next = new URL(loc, url);
      } catch {
        break;
      }
      if (next.protocol !== 'http:' && next.protocol !== 'https:') break;
      if (!isSameOrSubdomain(next.hostname, ctx.domain)) {
        leftDomainTo = next.toString();
        break;
      }
      url = next.toString();
    }
    return { hops, final: hops[hops.length - 1]!, leftDomainTo };
  });
}

/**
 * Stuurt de website door naar een toestemmingspagina (cookiemuur) op een ander
 * domein, zoals myprivacy.dpgmedia.nl? Dan hebben we de echte website niet gezien.
 */
export function isConsentWall(chain: Chain): boolean {
  if (!chain.leftDomainTo) return false;
  const to = new URL(chain.leftDomainTo);
  if (/(^|[.-])(consent|privacy|myprivacy|cookie|cookies|gdpr|cmp)([.-]|$)/i.test(to.hostname)) return true;
  // Toestemmingsplatforms geven het oorspronkelijke adres mee om terug te kunnen sturen.
  const start = new URL(chain.hops[0]!.url).hostname;
  return [...to.searchParams.values()].some((v) => v.includes(start)) && /consent|privacy|cookie/i.test(to.pathname + to.search);
}

function consentWall(chain: Chain) {
  return {
    outcome: 'unknown' as const,
    evidence: { redirectsTo: chain.leftDomainTo },
    message: `De website stuurt eerst door naar een toestemmingspagina (${new URL(chain.leftDomainTo!).hostname}), dus de website zelf is niet beoordeeld.`,
  };
}

export function leftDomain(chain: Chain) {
  if (isConsentWall(chain)) return consentWall(chain);
  const to = new URL(chain.leftDomainTo!).hostname;
  return {
    outcome: 'not_applicable' as const,
    evidence: { redirectsTo: chain.leftDomainTo },
    message: `Deze website stuurt bezoekers door naar ${to}. Is dat ook jouw domein, scan het dan apart.`,
  };
}

/**
 * Een foutcode (403 van botbescherming, 421, 5xx) is niet de echte website.
 * Headers, cookies en versies daarop beoordelen geeft valse bevindingen.
 */
export function notTheRealPage(res: HttpResponse) {
  if (res.status >= 200 && res.status < 400) return null;
  return {
    outcome: 'unknown' as const,
    evidence: { url: res.url, status: res.status },
    message: `De website gaf ons foutcode ${res.status} in plaats van de pagina, dus dit is niet beoordeeld.`,
  };
}

function unreachable(host: string, e: unknown) {
  const code = (e as { code?: string }).code ?? String(e);
  return {
    outcome: 'unknown' as const,
    evidence: { error: code },
    message: `We kregen geen antwoord van https://${host}, dus dit is niet gecontroleerd.`,
  };
}

export const httpsRedirectCheck: Check = {
  key: 'web.https_redirect',
  level: 1,
  group: 'website',
  appliesTo: 'website',
  title: 'Bezoekers gaan automatisch naar https',
  async run(ctx) {
    const host = hostOf(ctx.asset);
    let chain: Chain;
    try {
      chain = await fetchChain(ctx, `http://${host}/`);
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === 'ECONNREFUSED') {
        return { outcome: 'ok', evidence: { error: code }, message: 'De website is niet onbeveiligd (via http) bereikbaar.' };
      }
      return { outcome: 'unknown', evidence: { error: code ?? String(e) }, message: `We kregen geen antwoord van http://${host}.` };
    }
    const evidence = { hops: chain.hops.map((h) => ({ url: h.url, status: h.status, location: h.headers.location })) };
    const finalUrl = new URL(chain.leftDomainTo ?? chain.final.url);
    if (finalUrl.protocol === 'https:') return { outcome: 'ok', evidence };
    const bad = notTheRealPage(chain.final);
    if (bad) return { ...bad, evidence };
    if (chain.final.status >= 300 && chain.final.status < 400) {
      return { outcome: 'unknown', evidence, message: 'De doorverwijzingen eindigen niet op een pagina; dit konden we niet vaststellen.' };
    }
    return {
      outcome: 'finding',
      evidence,
      findings: [
        {
          key: 'web.no_https_redirect',
          certainty: 'vastgesteld',
          title: 'De website is ook onbeveiligd bereikbaar',
          detail: `Wie http://${host} intypt, blijft op een onbeveiligde verbinding en wordt niet doorgestuurd naar https.`,
        },
      ],
    };
  },
};

export const headersCheck: Check = {
  key: 'web.headers',
  level: 1,
  group: 'website',
  appliesTo: 'website',
  title: 'Beveiligingsinstellingen van de website (headers)',
  async run(ctx) {
    const host = hostOf(ctx.asset);
    let chain: Chain;
    try {
      chain = await fetchChain(ctx, `https://${host}/`);
    } catch (e) {
      return unreachable(host, e);
    }
    if (chain.leftDomainTo) return leftDomain(chain);
    const first = chain.hops[0]!;
    const final = chain.final;
    if (final.status >= 300 && final.status < 400) {
      return { outcome: 'unknown', evidence: { status: final.status }, message: 'De website blijft doorverwijzen; headers niet beoordeeld.' };
    }
    const bad = notTheRealPage(final);
    if (bad) return bad;
    const h = final.headers;
    const evidence = {
      url: final.url,
      status: final.status,
      headers: pick(h, [
        'strict-transport-security',
        'content-security-policy',
        'x-content-type-options',
        'x-frame-options',
        'referrer-policy',
      ]),
      firstHsts: first.headers['strict-transport-security'] ?? null,
    };
    const findings: FindingDraft[] = [];

    // HSTS moet op het eigen https-antwoord van de host staan.
    const hsts = first.headers['strict-transport-security'];
    if (!hsts) {
      findings.push({
        key: 'web.hsts_missing',
        certainty: 'vastgesteld',
        title: 'De website dwingt geen beveiligde verbinding af (HSTS)',
        detail: `${host} stuurt geen Strict-Transport-Security mee. Browsers kunnen dan alsnog een onbeveiligde verbinding proberen.`,
      });
    } else {
      const maxAge = Number(hsts.match(/max-age\s*=\s*"?(\d+)/i)?.[1] ?? 0);
      if (maxAge < HSTS_MIN_SECONDS) {
        findings.push({
          key: 'web.hsts_short',
          certainty: 'vastgesteld',
          title: 'De HSTS-instelling geldt maar kort',
          detail: `HSTS staat op ${maxAge} seconden; aanbevolen is minstens een half jaar (${HSTS_MIN_SECONDS}).`,
        });
      }
    }

    const headerCsp = h['content-security-policy'];
    // Een CSP mag ook in de pagina staan (<meta http-equiv>); frame-ancestors werkt daar niet.
    const metaCsp = metaContentSecurityPolicy(final.body);
    const csp = headerCsp ?? metaCsp;
    if (metaCsp && !headerCsp) (evidence as Record<string, unknown>).metaCsp = metaCsp;
    if (!csp) {
      findings.push({
        key: 'web.csp_missing',
        certainty: 'vastgesteld',
        title: 'Geen Content-Security-Policy',
        detail: 'De website vertelt de browser niet welke scripts en bronnen zijn toegestaan. Dat maakt misbruik via ingevoegde scripts makkelijker.',
      });
    }

    // Dubbel meegestuurde headers komen samengevoegd binnen ("nosniff, nosniff"): per waarde beoordelen.
    const xcto = headerValues(h['x-content-type-options']);
    if (!(xcto.length > 0 && xcto.every((v) => v === 'nosniff'))) {
      findings.push({
        key: 'web.xcto_missing',
        certainty: 'vastgesteld',
        title: 'X-Content-Type-Options ontbreekt',
        detail: 'Zonder "nosniff" kan een browser bestanden anders uitvoeren dan bedoeld.',
      });
    }

    const xfo = headerValues(h['x-frame-options']);
    const frameAncestors = /(^|[;,])\s*frame-ancestors\s/i.test(headerCsp ?? '');
    if (!frameAncestors && !(xfo.length > 0 && xfo.every((v) => v === 'deny' || v === 'sameorigin'))) {
      // Misleiden met klikken loont alleen waar een bezoeker iets invult of ingelogd iets doet.
      const formulier = sensitiveForm(final.body);
      if (formulier) (evidence as Record<string, unknown>).formulier = formulier;
      findings.push(
        formulier
          ? {
              key: 'web.framing_login',
              certainty: 'vastgesteld',
              title: 'De pagina met een inlog- of betaalformulier kan in andermans pagina worden ingesloten',
              detail: `Er is geen frame-ancestors of X-Frame-Options ingesteld, en de pagina heeft een ${formulier === 'betalen' ? 'betaalformulier' : 'inlogformulier'}. Een nepsite kan de pagina dan onzichtbaar insluiten en bezoekers laten klikken of invullen zonder dat ze het merken.`,
            }
          : {
              key: 'web.framing_unprotected',
              certainty: 'vastgesteld',
              title: 'De website kan in andermans pagina worden ingesloten',
              detail: 'Er is geen frame-ancestors of X-Frame-Options ingesteld. Op deze pagina zagen we geen inlog- of betaalformulier, dus het risico is klein; met zo\'n formulier kan een nepsite bezoekers laten klikken of invullen zonder dat ze het merken.',
            },
      );
    }

    // Zonder Referrer-Policy sturen browsers sinds 2021 alleen het domein mee naar andere sites;
    // alleen een waarde die meer doorgeeft is een bevinding.
    const referrer = effectiveReferrerPolicy(h['referrer-policy']);
    if (referrer === 'unsafe-url' || referrer === 'no-referrer-when-downgrade') {
      findings.push({
        key: 'web.referrer_unsafe',
        certainty: 'vastgesteld',
        title: 'De website geeft volledige adressen door aan andere websites',
        detail: `De Referrer-Policy staat op "${referrer}". Andere websites zien dan het volledige adres van de pagina die je bezoeker bekeek, inclusief wat erachter staat (zoals zoekwoorden of een ordernummer). Zonder deze instelling doen browsers dat niet.`,
      });
    }

    return { outcome: findings.length ? 'finding' : 'ok', findings, evidence };
  },
};

export const cookiesCheck: Check = {
  key: 'web.cookies',
  level: 1,
  group: 'website',
  appliesTo: 'website',
  title: 'Cookies van de website',
  async run(ctx) {
    const host = hostOf(ctx.asset);
    let chain: Chain;
    try {
      chain = await fetchChain(ctx, `https://${host}/`);
    } catch (e) {
      return unreachable(host, e);
    }
    if (chain.leftDomainTo && chain.hops.every((h) => h.setCookies.length === 0)) return leftDomain(chain);
    const badCookies = chain.leftDomainTo ? null : notTheRealPage(chain.final);
    if (badCookies) return badCookies;
    const cookies = chain.hops
      .filter((hop) => new URL(hop.url).protocol === 'https:')
      .flatMap((hop) => hop.setCookies)
      .map(parseCookie);
    const evidence = { cookies: cookies.map(({ name, secure, httpOnly }) => ({ name, secure, httpOnly })) };
    if (cookies.length === 0) {
      return { outcome: 'ok', evidence, message: 'De homepage zet geen cookies bij het eerste bezoek.' };
    }
    const findings: FindingDraft[] = [];
    // Secure doet ertoe bij sessie- en inlogcookies. Dwingt de site HSTS af, dan gebruikt de
    // browser toch al alleen https; zonder HSTS telt elke cookie zonder Secure.
    const hsts = hstsActive(chain);
    (evidence as Record<string, unknown>).hsts = hsts;
    const insecure = [...new Set(cookies.filter((c) => !c.secure && (!hsts || isSessionCookie(c.name))).map((c) => c.name))];
    // Alleen sessie- en inlogcookies horen HttpOnly te hebben; toestemmings- en
    // analysecookies moeten vaak juist door scripts gelezen worden.
    const noHttpOnly = [...new Set(cookies.filter((c) => !c.httpOnly && isSessionCookie(c.name)).map((c) => c.name))];
    if (insecure.length) {
      findings.push({
        key: 'web.cookie_insecure',
        certainty: 'vastgesteld',
        title: 'Cookies kunnen over een onbeveiligde verbinding worden verstuurd',
        detail: hsts
          ? `Deze sessie- of inlogcookies missen de Secure-vlag: ${insecure.join(', ')}. De website dwingt https af (HSTS), maar bij het allereerste bezoek of na het verlopen daarvan kan zo'n cookie alsnog onbeveiligd worden verstuurd.`
          : `Deze cookies missen de Secure-vlag: ${insecure.join(', ')}. De website dwingt ook geen https af (HSTS), dus de browser kan ze over een onbeveiligde verbinding versturen.`,
      });
    }
    if (noHttpOnly.length) {
      findings.push({
        key: 'web.cookie_no_httponly',
        // Sommige cookies moeten door scripts gelezen kunnen worden; daarom "mogelijk".
        certainty: 'mogelijk',
        title: 'Cookies zijn leesbaar voor scripts op de pagina',
        detail: `Deze sessie- of inlogcookies missen de HttpOnly-vlag: ${noHttpOnly.join(', ')}. Een ingevoegd script kan ze dan stelen en zo een sessie overnemen.`,
      });
    }
    return { outcome: findings.length ? 'finding' : 'ok', findings, evidence };
  },
};

const SESSION_COOKIE = /^(phpsessid|jsessionid|asp\.net_sessionid|aspsessionid\w*|connect\.sid|laravel_session|ci_session|wordpress_logged_in\w*|wordpress_sec\w*|wp-settings\w*)$|sess|(^|[_.-])sid($|[_.-])|auth|token|login/i;

/** CSRF-cookies (XSRF-TOKEN, csrftoken) moeten juist door scripts leesbaar zijn; dat zijn geen inlogcookies. */
const CSRF_COOKIE = /csrf|xsrf/i;

export function isSessionCookie(name: string): boolean {
  return SESSION_COOKIE.test(name) && !CSRF_COOKIE.test(name);
}

/** HSTS met een max-age boven nul op het eerste https-antwoord van de host. */
function hstsActive(chain: Chain): boolean {
  const first = chain.hops.find((h) => new URL(h.url).protocol === 'https:');
  const v = first?.headers['strict-transport-security'];
  return Number(v?.match(/max-age\s*=\s*"?(\d+)/i)?.[1] ?? 0) > 0;
}

const REFERRER_POLICIES = new Set([
  'no-referrer',
  'no-referrer-when-downgrade',
  'origin',
  'origin-when-cross-origin',
  'same-origin',
  'strict-origin',
  'strict-origin-when-cross-origin',
  'unsafe-url',
]);

/** De Referrer-Policy die de browser gebruikt: de laatste geldige waarde in de lijst. */
export function effectiveReferrerPolicy(v: string | undefined): string | null {
  const valid = headerValues(v).filter((x) => REFERRER_POLICIES.has(x));
  return valid.at(-1) ?? null;
}

/**
 * Heeft de pagina een inlog- of betaalformulier? Een wachtwoordveld, of een veld voor
 * een kaartnummer (autocomplete="cc-number"). Alleen wat in de html staat.
 */
export function sensitiveForm(body: string): 'inloggen' | 'betalen' | null {
  for (const m of body.matchAll(/<input\b[^>]*>/gi)) {
    const tag = m[0];
    if (/autocomplete\s*=\s*["']?cc-(number|csc|exp)/i.test(tag)) return 'betalen';
  }
  if (/<input\b[^>]*\btype\s*=\s*["']?password\b/i.test(body)) return 'inloggen';
  return null;
}

/** Waarden van een (mogelijk dubbel meegestuurde) header, in kleine letters. */
export function headerValues(v: string | undefined): string[] {
  return (v ?? '')
    .split(',')
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
}

/** CSP uit een <meta http-equiv="Content-Security-Policy" content="..."> in de pagina. */
export function metaContentSecurityPolicy(body: string): string | null {
  for (const m of body.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/http-equiv\s*=\s*["']?content-security-policy["'\s>]/i.test(tag)) continue;
    const c = tag.match(/content\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
    const v = (c?.[1] ?? c?.[2] ?? '').trim();
    if (v) return v;
  }
  return null;
}

export function parseCookie(header: string) {
  const [pair, ...attrs] = header.split(';');
  const name = (pair ?? '').split('=')[0]!.trim();
  const a = attrs.map((x) => x.trim().toLowerCase());
  return {
    name,
    secure: a.includes('secure'),
    httpOnly: a.includes('httponly'),
  };
}

export interface DisclosedSoftware {
  product: string;
  version: string;
  source: string;
}

/** Leest softwareversies die de website zelf prijsgeeft. Basis voor CVE-matching in fase 4. */
export function detectVersions(res: HttpResponse): DisclosedSoftware[] {
  const out: DisclosedSoftware[] = [];
  const re = /([A-Za-z][A-Za-z0-9._-]*)\/(\d+(?:\.\d+)+[a-z0-9-]*)/g;
  for (const header of ['server', 'x-powered-by', 'x-aspnet-version', 'x-generator']) {
    const v = res.headers[header];
    if (!v) continue;
    if (header === 'x-aspnet-version' && /^\d+(\.\d+)+/.test(v)) {
      out.push({ product: 'ASP.NET', version: v.trim(), source: 'header:x-aspnet-version' });
      continue;
    }
    for (const m of v.matchAll(re)) out.push({ product: m[1]!, version: m[2]!, source: `header:${header}` });
  }
  const gen = res.body.match(/<meta[^>]+name=["']generator["'][^>]*content=["']([^"']+)["']/i)
    ?? res.body.match(/<meta[^>]+content=["']([^"']+)["'][^>]*name=["']generator["']/i);
  if (gen) {
    const m = gen[1]!.match(/^(.*?)\s+v?(\d+(?:\.\d+)+)/);
    if (m) out.push({ product: m[1]!.trim(), version: m[2]!, source: 'html:meta-generator' });
  }
  return out;
}

export const versionDisclosureCheck: Check = {
  key: 'web.version_disclosure',
  level: 1,
  group: 'website',
  appliesTo: 'website',
  title: 'Zichtbare softwareversies',
  async run(ctx) {
    const host = hostOf(ctx.asset);
    let chain: Chain;
    try {
      chain = await fetchChain(ctx, `https://${host}/`);
    } catch (e) {
      return unreachable(host, e);
    }
    if (chain.leftDomainTo && chain.hops.every((h) => detectVersions(h).length === 0)) return leftDomain(chain);
    const software = chain.hops.flatMap(detectVersions);
    const unique = [...new Map(software.map((s) => [`${s.product}/${s.version}`, s])).values()];
    const evidence = { software: unique };
    if (unique.length === 0) return { outcome: 'ok', evidence };
    return {
      outcome: 'finding',
      evidence,
      findings: [
        {
          key: 'web.version_disclosed',
          certainty: 'vastgesteld',
          title: 'De website vertelt welke softwareversie hij gebruikt',
          detail: `We zien: ${unique.map((s) => `${s.product} ${s.version}`).join(', ')}. Of die versies bekende kwetsbaarheden hebben, controleren we in een volgende stap.`,
        },
      ],
    };
  },
};

export const securityTxtCheck: Check = {
  key: 'web.security_txt',
  level: 1,
  group: 'website',
  appliesTo: 'website',
  title: 'security.txt: waar je beveiligingsproblemen kunt melden',
  async run(ctx) {
    const host = hostOf(ctx.asset);
    let chain: Chain;
    try {
      chain = await fetchChain(ctx, `https://${host}/.well-known/security.txt`);
    } catch (e) {
      return unreachable(host, e);
    }
    let res = chain.final;
    let delegated: string | null = null;
    if (chain.leftDomainTo) {
      // Doorverwijzen naar de security.txt van een andere organisatie (bijvoorbeeld
      // rijksoverheid.nl naar ncsc.nl) is toegestaan (RFC 9116, par. 3). Eén bezoek,
      // net als een browser of melder zou doen.
      const to = new URL(chain.leftDomainTo);
      if (to.protocol !== 'https:' || !to.pathname.endsWith('security.txt')) return leftDomain(chain);
      try {
        res = await ctx.memo(`get:${to}`, () => ctx.net.httpGet(to.toString()));
      } catch (e) {
        return unreachable(to.hostname, e);
      }
      delegated = to.toString();
    }
    if (res.status >= 400 && res.status !== 404 && res.status !== 410) {
      const bad = notTheRealPage(res)!;
      return bad;
    }
    const isText = (res.headers['content-type'] ?? '').toLowerCase().startsWith('text/plain');
    const contact = /^contact:\s*\S+/im.test(res.body);
    const evidence = { url: res.url, status: res.status, contentType: res.headers['content-type'] ?? null, delegatedTo: delegated };
    if (res.status === 200 && isText && contact) {
      const exp = res.body.match(/^expires:\s*(.+)$/im)?.[1];
      if (exp && !Number.isNaN(Date.parse(exp)) && new Date(exp) < ctx.now) {
        return {
          outcome: 'finding',
          evidence,
          findings: [
            {
              key: 'web.securitytxt_expired',
              certainty: 'vastgesteld',
              title: 'Het meldpunt voor beveiligingsproblemen is verlopen',
              detail: `security.txt op ${host} heeft als vervaldatum ${exp.trim()}. Melders weten dan niet of de gegevens nog kloppen.`,
            },
          ],
        };
      }
      return { outcome: 'ok', evidence };
    }
    return {
      outcome: 'finding',
      evidence,
      findings: [
        {
          key: 'web.securitytxt_missing',
          certainty: 'vastgesteld',
          title: 'Geen meldpunt voor beveiligingsproblemen (security.txt)',
          detail: `Op https://${host}/.well-known/security.txt staat geen geldig bestand met contactgegevens.`,
        },
      ],
    };
  },
};

function pick(h: Record<string, string>, keys: string[]) {
  return Object.fromEntries(keys.map((k) => [k, h[k] ?? null]));
}
