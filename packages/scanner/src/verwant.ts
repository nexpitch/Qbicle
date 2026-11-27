import type { Net } from './net.ts';
import { isPublicIp } from './ip.ts';
import { normalizeDomain, organizationalDomain } from './domain.ts';
import type { CheckResult } from './types.ts';

/**
 * "Hoort dit ook bij jullie?": andere domeinen die aantoonbaar bij dezelfde
 * eigenaar horen als het gescande domein, en waar ook echt iets aan hangt.
 *
 * Regels (Erik, 27-11): liever geen suggestie dan een onzinnige.
 * - Nooit hetzelfde hoofddomein (www.x.nl en x.nl zijn één domein).
 * - Alleen met bewijs dat het van de klant is:
 *   1. de naam staat op hetzelfde, geldige certificaat als de website van de klant
 *      (de uitgever heeft gecontroleerd dat één partij beide namen beheert);
 *   2. de website van de klant verwijst door naar dat domein.
 *   Gedeelde certificaten van hosters en CDN's (veel verschillende domeinen) tellen niet.
 * - Nooit externe diensten (Google, Wix, Cloudflare, CDN's, trackers, sociale media).
 * - Alleen als er iets aan hangt: een website die antwoordt, of anders een mailserver.
 * De klant bevestigt het daarna zelf met domeinbewijs; dit is alleen een voorstel.
 */

export type VerwantBewijs =
  | { soort: 'certificaat'; via: string }
  | { soort: 'doorverwijzing'; via: string }
  | { soort: 'verwijst-terug'; via: string };

export interface VerwantDomein {
  domein: string;
  bewijs: VerwantBewijs[];
  /** Wat we er zagen draaien. */
  dienst: 'website' | 'mail';
}

/** Meer verschillende hoofddomeinen dan dit op één certificaat: een gedeeld certificaat van een hoster of CDN. */
export const MAX_DOMEINEN_OP_CERTIFICAAT = 4;
/** Hooguit zoveel kandidaten per scan nalopen (elk kost een DNS-vraag en één bezoek aan de homepage). */
export const MAX_KANDIDATEN = 5;

/**
 * Hoofddomeinen van diensten die bij veel klanten opduiken, maar nooit van de
 * klant zelf zijn. Een subdomein of klantnaam daaronder (klant.wixsite.com)
 * telt ook als extern.
 */
export const EXTERNE_DIENSTEN = [
  // Zoekmachines, kantoorsoftware, mail
  'google.com', 'google.nl', 'googleapis.com', 'googleusercontent.com', 'gstatic.com', 'gmail.com', 'goo.gl', 'g.page',
  'microsoft.com', 'office.com', 'office365.com', 'outlook.com', 'live.com', 'microsoftonline.com', 'sharepoint.com', 'azurewebsites.net', 'azureedge.net', 'windows.net', 'bing.com',
  'apple.com', 'icloud.com', 'yahoo.com', 'zoho.com', 'zoho.eu',
  // Websitebouwers en hosting
  'wix.com', 'wixsite.com', 'wixdns.net', 'wixstatic.com', 'parastorage.com', 'editorx.io',
  'squarespace.com', 'squarespace-cdn.com', 'shopify.com', 'myshopify.com', 'wordpress.com', 'wp.com', 'wordpress.org', 'wpengine.com', 'wpenginepowered.com',
  'jimdo.com', 'jimdosite.com', 'jimdofree.com', 'webflow.io', 'webflow.com', 'weebly.com', 'strikingly.com', 'lightspeedhq.com', 'mijnwebwinkel.nl', 'ccvshop.nl',
  'netlify.app', 'netlify.com', 'vercel.app', 'vercel.com', 'github.io', 'github.com', 'gitlab.io', 'herokuapp.com', 'pages.dev', 'workers.dev', 'firebaseapp.com', 'web.app',
  'transip.nl', 'transip.eu', 'hostnet.nl', 'antagonist.nl', 'vimexx.nl', 'mijndomein.nl', 'strato.nl', 'strato.de', 'one.com', 'hostinger.com', 'godaddy.com', 'secureserver.net', 'ionos.com', 'ionos.nl', 'versio.nl', 'argeweb.nl', 'yourhosting.nl', 'neostrada.nl',
  // CDN's en beveiliging
  'cloudflare.com', 'cloudflaressl.com', 'cloudflare.net', 'cloudfront.net', 'amazonaws.com', 'amazon.com', 'akamai.net', 'akamaiedge.net', 'akamaihd.net', 'akamaized.net', 'edgekey.net', 'edgesuite.net',
  'fastly.net', 'fastly.com', 'fastlylb.net', 'cdn77.org', 'bunnycdn.com', 'b-cdn.net', 'jsdelivr.net', 'unpkg.com', 'cdnjs.com', 'stackpathdns.com', 'sucuri.net', 'incapdns.net', 'imperva.com',
  // Certificaatuitgevers
  'letsencrypt.org', 'sectigo.com', 'digicert.com', 'globalsign.com', 'zerossl.com',
  // Trackers, toestemming, marketing, chat
  'googletagmanager.com', 'google-analytics.com', 'doubleclick.net', 'hotjar.com', 'facebook.net', 'cookiebot.com', 'cookiecode.nl', 'onetrust.com', 'cookielaw.org', 'usercentrics.eu', 'hubspot.com', 'hs-scripts.com',
  'mailchimp.com', 'list-manage.com', 'brevo.com', 'sendinblue.com', 'mailjet.com', 'sendgrid.net', 'mailgun.org', 'zendesk.com', 'intercom.io', 'tawk.to', 'calendly.com', 'typeform.com', 'trustpilot.com', 'kiyoh.com',
  // Sociale media en betalen
  'facebook.com', 'instagram.com', 'linkedin.com', 'twitter.com', 'x.com', 'youtube.com', 'youtu.be', 'tiktok.com', 'pinterest.com', 'whatsapp.com', 'wa.me',
  'mollie.com', 'stripe.com', 'paypal.com', 'adyen.com', 'ideal.nl', 'buckaroo.nl', 'multisafepay.com',
];

export function isExterneDienst(domein: string): boolean {
  const d = domein.toLowerCase();
  return EXTERNE_DIENSTEN.some((e) => d === e || d.endsWith(`.${e}`));
}

/** Hoofddomein van een hostnaam of URL, of null als het geen bruikbare publieke domeinnaam is. */
export function hoofddomein(hostOrUrl: string): string | null {
  let host = hostOrUrl.trim().toLowerCase();
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(host)) {
    try {
      host = new URL(host).hostname;
    } catch {
      return null;
    }
  }
  host = host.replace(/^\*\./, '').replace(/\.$/, '');
  try {
    host = normalizeDomain(host);
  } catch {
    return null;
  }
  const org = organizationalDomain(host);
  return org.includes('.') ? org : null;
}

interface Kandidaat {
  domein: string;
  bewijs: VerwantBewijs[];
}

/** Haalt kandidaten met bewijs uit de uitkomsten van de checks (geen netwerk). */
export function kandidatenUitChecks(domain: string, checks: CheckResult[]): Kandidaat[] {
  const eigen = organizationalDomain(domain);
  const out = new Map<string, Kandidaat>();
  const add = (naam: string, bewijs: VerwantBewijs) => {
    const d = hoofddomein(naam);
    if (!d || d === eigen || isExterneDienst(d)) return;
    const k = out.get(d) ?? { domein: d, bewijs: [] };
    if (!k.bewijs.some((b) => b.soort === bewijs.soort && b.via === bewijs.via)) k.bewijs.push(bewijs);
    out.set(d, k);
  };

  for (const c of checks) {
    const host = hostnaam(c.asset.value);
    if (c.checkKey === 'tls.certificate') {
      // Alleen een geldig certificaat dat echt bij deze website hoort, en geen gedeeld certificaat.
      const ev = c.evidence as { authorized?: boolean; nameMatches?: boolean; cert?: { altNames?: unknown } | null };
      const names = Array.isArray(ev.cert?.altNames) ? ev.cert!.altNames.filter((n): n is string => typeof n === 'string') : [];
      if (!ev.authorized || !ev.nameMatches || names.length === 0) continue;
      const verschillend = new Set(names.map(hoofddomein).filter(Boolean));
      if (verschillend.size > MAX_DOMEINEN_OP_CERTIFICAAT) continue;
      for (const n of names) add(n, { soort: 'certificaat', via: host });
    }
    // Doorverwijzing naar een ander domein (geen toestemmingspagina: die geeft 'unknown').
    const redirectsTo = (c.evidence as { redirectsTo?: unknown }).redirectsTo;
    if (c.outcome === 'not_applicable' && typeof redirectsTo === 'string') {
      add(redirectsTo, { soort: 'doorverwijzing', via: host });
    }
  }
  return [...out.values()];
}

function hostnaam(value: string): string {
  try {
    return new URL(value).hostname;
  } catch {
    return value;
  }
}

/**
 * Loopt de kandidaten na: hangt er een website of mailserver aan? Alleen DNS en
 * één bezoek aan de homepage, zoals een gewone bezoeker; geen andere tests.
 */
export async function vindVerwanteDomeinen(net: Net, domain: string, checks: CheckResult[]): Promise<VerwantDomein[]> {
  const eigen = organizationalDomain(domain);
  const kandidaten = kandidatenUitChecks(domain, checks).slice(0, MAX_KANDIDATEN);
  const out: VerwantDomein[] = [];
  for (const k of kandidaten) {
    const r = await dienstOp(net, k.domein, eigen).catch(() => null);
    if (!r) continue;
    const bewijs = [...k.bewijs];
    if (r.verwijstTerug) bewijs.push({ soort: 'verwijst-terug', via: r.verwijstTerug });
    out.push({ domein: k.domein, bewijs, dienst: r.dienst });
  }
  return out.sort((a, b) => a.domein.localeCompare(b.domein));
}

async function dienstOp(net: Net, domein: string, eigen: string): Promise<{ dienst: 'website' | 'mail'; verwijstTerug: string | null } | null> {
  for (const host of [domein, `www.${domein}`]) {
    const adressen = await net.resolveAddresses(host).catch(() => [] as string[]);
    if (adressen.length === 0 || !adressen.every(isPublicIp)) continue;
    const res = await net.httpGet(`https://${host}/`).catch(() => null);
    if (!res || res.status >= 400) continue;
    let verwijstTerug: string | null = null;
    if (res.status >= 300 && res.headers.location) {
      try {
        const to = new URL(res.headers.location, res.url).hostname;
        if (organizationalDomain(to) === eigen) verwijstTerug = host;
        else if (organizationalDomain(to) !== domein) continue; // stuurt door naar iets anders: daar hangt niets eigens aan
      } catch {
        continue;
      }
    }
    return { dienst: 'website', verwijstTerug };
  }
  const mx = await net.resolveMx(domein).catch(() => []);
  const echteMx = mx.filter((m) => m.exchange && m.exchange !== '.');
  return echteMx.length ? { dienst: 'mail', verwijstTerug: null } : null;
}
