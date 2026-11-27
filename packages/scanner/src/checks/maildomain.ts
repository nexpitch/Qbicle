import type { Net } from '../net.ts';
import type { CheckContext } from '../types.ts';
import { isSpfRecord, parseSpf } from './spf.ts';
import { probeDkim } from './dkim.ts';

/**
 * Op welke naam meten we de mailinstellingen?
 *
 * SPF, DKIM en DMARC horen bij de naam waarmee gemaild wordt. Bij een subdomein
 * (www.voorbeeld.nl, portaal.voorbeeld.nl) is dat bijna altijd het hoofddomein.
 * Een naam met een CNAME kan zelf geen andere records hebben; een TXT-vraag geeft
 * dan de records van het doel (bijvoorbeeld de websitebouwer), en die zeggen niets
 * over jouw mail. Alleen als een subdomein zelf mail ontvangt of een eigen SPF heeft,
 * meten we op het subdomein.
 */
export interface MailTarget {
  /** Naam waarop SPF en DKIM gemeten worden, en waar DMARC eerst gezocht wordt. */
  name: string;
  orgDomain: string;
  reason: 'hoofddomein' | 'eigen-mail' | 'doorverwijzing' | 'subdomein';
  cname: string | null;
}

export function mailTarget(ctx: CheckContext): Promise<MailTarget> {
  return ctx.memo(`mail-target:${ctx.domain}`, async () => {
    const { domain, orgDomain, net } = ctx;
    if (domain === orgDomain) return { name: domain, orgDomain, reason: 'hoofddomein', cname: null };
    const cname = (await net.resolveCname(domain).catch(() => []))[0] ?? null;
    if (cname) return { name: orgDomain, orgDomain, reason: 'doorverwijzing', cname };
    const [txt, mx] = await Promise.all([net.resolveTxt(domain).catch(() => []), net.resolveMx(domain).catch(() => [])]);
    if (txt.some(isSpfRecord) || mx.length > 0) return { name: domain, orgDomain, reason: 'eigen-mail', cname: null };
    return { name: orgDomain, orgDomain, reason: 'subdomein', cname: null };
  });
}

/** Zin voor in de uitleg als we niet op de ingevulde naam meten. */
export function measuredOnNote(domain: string, t: MailTarget): string {
  if (t.name === domain) return '';
  return t.reason === 'doorverwijzing'
    ? ` ${domain} verwijst door naar ${t.cname}; de mailinstellingen horen bij het hoofddomein ${t.name}, dus daar hebben we gekeken.`
    : ` De mailinstellingen van ${domain} horen bij het hoofddomein ${t.name}, dus daar hebben we gekeken.`;
}

export interface MailProfile {
  /** MX-records, of null als de opvraging mislukte. */
  mx: string[] | null;
  /** "Null MX" (RFC 7505): het domein zegt officieel geen mail te ontvangen. */
  nullMx: boolean;
  /** SPF noemt servers die mogen versturen (meer dan alleen "-all"). null = onbekend. */
  spfSenders: boolean | null;
  /** Een DKIM-sleutel gevonden: er wordt vrijwel zeker vanaf gemaild. */
  dkim: boolean;
  /**
   * Zeker dat dit domein geen mail verstuurt of ontvangt: geen MX (of null MX),
   * geen SPF met verzenders en geen DKIM-sleutel. Bij twijfel false.
   */
  noMail: boolean;
}

export function isNullMx(mx: { exchange: string }[]): boolean {
  return mx.length === 1 && (mx[0]!.exchange === '' || mx[0]!.exchange === '.');
}

export function mailProfile(net: Net, name: string, memo: CheckContext['memo']): Promise<MailProfile> {
  return memo(`mail-profile:${name}`, async () => {
    const [mxRecs, txt, dkim] = await Promise.all([
      net.resolveMx(name).catch(() => null),
      net.resolveTxt(name).catch(() => null),
      memo(`dkim:${name}`, () => probeDkim(net, name)),
    ]);
    const nullMx = mxRecs !== null && isNullMx(mxRecs);
    const mx = mxRecs === null ? null : nullMx ? [] : mxRecs.map((m) => m.exchange);
    let spfSenders: boolean | null = null;
    if (txt !== null) {
      const recs = txt.filter(isSpfRecord);
      spfSenders = recs.length === 0 ? false : recs.some((r) => parseSpf(r).terms.some((t) => t.name !== 'all' && t.qualifier !== '-'));
    }
    const hasDkim = dkim.active.length > 0;
    const noMail = mx !== null && mx.length === 0 && spfSenders === false && !hasDkim;
    return { mx, nullMx, spfSenders, dkim: hasDkim, noMail };
  });
}
