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

function leftDomain(chain: Chain) {
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

    const csp = h['content-security-policy'];
    if (!csp) {
      findings.push({
        key: 'web.csp_missing',
        certainty: 'vastgesteld',
        title: 'Geen Content-Security-Policy',
        detail: 'De website vertelt de browser niet welke scripts en bronnen zijn toegestaan. Dat maakt misbruik via ingevoegde scripts makkelijker.',
      });
    }

    if ((h['x-content-type-options'] ?? '').toLowerCase().trim() !== 'nosniff') {
      findings.push({
        key: 'web.xcto_missing',
        certainty: 'vastgesteld',
        title: 'X-Content-Type-Options ontbreekt',
        detail: 'Zonder "nosniff" kan een browser bestanden anders uitvoeren dan bedoeld.',
      });
    }

    const xfo = (h['x-frame-options'] ?? '').toLowerCase();
    const frameAncestors = /(^|;)\s*frame-ancestors\s/i.test(csp ?? '');
    if (!frameAncestors && !['deny', 'sameorigin'].includes(xfo.trim())) {
      findings.push({
        key: 'web.framing_unprotected',
        certainty: 'vastgesteld',
        title: 'De website kan in andermans pagina worden ingesloten',
        detail: 'Er is geen frame-ancestors of X-Frame-Options ingesteld. Een nepsite kan je pagina dan onzichtbaar insluiten om klikken te misleiden.',
      });
    }

    if (!h['referrer-policy']) {
      findings.push({
        key: 'web.referrer_missing',
        certainty: 'vastgesteld',
        title: 'Geen Referrer-Policy ingesteld',
        detail: 'De website legt niet vast welke adresgegevens naar andere sites mogen worden meegestuurd.',
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
    const insecure = [...new Set(cookies.filter((c) => !c.secure).map((c) => c.name))];
    const noHttpOnly = [...new Set(cookies.filter((c) => !c.httpOnly).map((c) => c.name))];
    if (insecure.length) {
      findings.push({
        key: 'web.cookie_insecure',
        certainty: 'vastgesteld',
        title: 'Cookies kunnen over een onbeveiligde verbinding worden verstuurd',
        detail: `Deze cookies missen de Secure-vlag: ${insecure.join(', ')}.`,
      });
    }
    if (noHttpOnly.length) {
      findings.push({
        key: 'web.cookie_no_httponly',
        // Sommige cookies moeten door scripts gelezen kunnen worden; daarom "mogelijk".
        certainty: 'mogelijk',
        title: 'Cookies zijn leesbaar voor scripts op de pagina',
        detail: `Deze cookies missen de HttpOnly-vlag: ${noHttpOnly.join(', ')}. Voor inlog- of sessiecookies is dat een risico.`,
      });
    }
    return { outcome: findings.length ? 'finding' : 'ok', findings, evidence };
  },
};

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
    if (chain.leftDomainTo) return leftDomain(chain);
    const res = chain.final;
    if (res.status >= 400 && res.status !== 404 && res.status !== 410) {
      const bad = notTheRealPage(res)!;
      return bad;
    }
    const isText = (res.headers['content-type'] ?? '').toLowerCase().startsWith('text/plain');
    const contact = /^contact:\s*\S+/im.test(res.body);
    const evidence = { url: res.url, status: res.status, contentType: res.headers['content-type'] ?? null };
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
