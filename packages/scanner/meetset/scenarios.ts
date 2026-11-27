/**
 * Vaste meetset voor de kwaliteit van de scanner: kleine, nagebootste domeinen
 * met per domein de uitkomst die een securityspecialist zou verwachten.
 *
 * Elk scenario komt uit een les van de echte testset (26-11-2026, 22 domeinen) of
 * uit een geval dat een MKB-klant vaak heeft. Draait zonder internet, dus elke
 * wijziging aan scanner of scoremodel is direct meetbaar: `npm run meetset`.
 *
 * Voeg een scenario toe als je een fout-positief of gemiste bevinding vindt.
 * Pas een verwachting alleen aan als die zelf fout blijkt, nooit om de scanner te laten slagen.
 */
import type { BandKey } from './types.ts';
import { GOOD_HEADERS, fakeNet, goodTls, healthyConfig, type FakeNetConfig } from '../test/fake-net.ts';

export interface Expect {
  /** Toegestane banden. */
  band: BandKey[];
  /** Bevindingen die er moeten zijn; met zekerheid als die ertoe doet. */
  moet?: Array<string | { key: string; zekerheid: 'vastgesteld' | 'mogelijk' }>;
  /** Bevindingen die er niet mogen zijn (fout-positieven uit de testset). */
  magNiet?: string[];
  /** Geen enkele andere bevinding dan die in `moet`. */
  verderSchoon?: boolean;
  /** Moet het rapport waarschuwen voor lage dekking? */
  dekkingWaarschuwing?: boolean;
  /** Uitkomst van een check (op het eerste asset waar hij draait). */
  uitkomst?: Record<string, 'ok' | 'finding' | 'unknown' | 'not_applicable'>;
  /** Assets die niet gescand mogen worden. */
  assetsNiet?: string[];
  /** Hoogste toegestane urgentie. */
  maxUrgentie?: number;
}

export interface Scenario {
  id: string;
  /** Waar dit scenario vandaan komt. */
  waarom: string;
  domein: string;
  net: () => ReturnType<typeof fakeNet>;
  verwacht: Expect;
}

const D = 'voorbeeld.nl';
const W = `www.${D}`;
const make = (domain: string, edit: (c: FakeNetConfig) => void) => () => {
  const c = healthyConfig(domain);
  edit(c);
  return fakeNet(c);
};
const site = (c: FakeNetConfig, patch: Record<string, unknown>) => {
  c.http![`https://${D}/`] = { ...(c.http![`https://${D}/`] as object), ...patch };
};
const daysFromNow = (d: number) => new Date(Date.parse('2026-11-26T12:00:00Z') + d * 86400_000).toISOString();

export const SCENARIOS: Scenario[] = [
  {
    id: 'gezond',
    waarom: 'Alles goed ingericht: geen enkele melding.',
    domein: D,
    net: make(D, () => {}),
    verwacht: { band: ['weinig'], verderSchoon: true, dekkingWaarschuwing: false },
  },
  {
    id: 'alleen-dmarc-ontbreekt',
    waarom: 'Eén echt probleem (testset-advies 4): hoort in Aandacht nodig.',
    domein: D,
    net: make(D, (c) => (c.txt![`_dmarc.${D}`] = [])),
    verwacht: { band: ['aandacht'], moet: ['dmarc.missing'], verderSchoon: true },
  },
  {
    id: 'dmarc-none-plus-headers',
    waarom: 'Zoals nlnetlabs.nl en bitsoffreedom.nl: p=none en wat headers. Aandacht nodig, niet hoger.',
    domein: D,
    net: make(D, (c) => {
      c.txt![`_dmarc.${D}`] = [`v=DMARC1; p=none; rua=mailto:d@${D}`];
      site(c, { headers: { 'strict-transport-security': 'max-age=31536000' } });
    }),
    verwacht: { band: ['aandacht'], moet: ['dmarc.p_none', 'web.csp_missing'] },
  },
  {
    id: 'apex-en-www-zonder-headers',
    waarom: 'Zoals google.com: dezelfde hygiënepunten op apex en www mogen niet optellen tot Hoge urgentie.',
    domein: D,
    net: make(D, (c) => {
      c.addresses![W] = ['203.0.114.11'];
      c.tls![W] = goodTls(W);
      for (const h of [D, W]) {
        c.http![`http://${h}/`] = { status: 200, headers: {} };
        c.http![`https://${h}/`] = { status: 200, headers: {} };
        c.http![`https://${h}/.well-known/security.txt`] = { status: 404 };
      }
    }),
    verwacht: { band: ['weinig', 'aandacht'], moet: ['web.no_https_redirect', 'web.hsts_missing'] },
  },
  {
    id: 'botbescherming-403',
    waarom: 'Zoals bol.com: de scanner krijgt 403. Geen headeroordeel op een foutpagina, wel een dekkingswaarschuwing.',
    domein: D,
    net: make(D, (c) => {
      c.http![`http://${D}/`] = { status: 403, headers: {} };
      c.http![`https://${D}/`] = { status: 403, headers: { server: 'Apache/2.4.49' } };
      c.http![`https://${D}/.well-known/security.txt`] = { status: 403 };
    }),
    verwacht: {
      band: ['weinig'],
      magNiet: ['web.hsts_missing', 'web.csp_missing', 'web.no_https_redirect', 'web.server_kwetsbaar'],
      dekkingWaarschuwing: true,
      uitkomst: { 'web.headers': 'unknown' },
    },
  },
  {
    id: 'verlopen-certificaat',
    waarom: 'Bezoekers krijgen een blokkerende waarschuwing: minimaal Hoge urgentie.',
    domein: D,
    net: make(D, (c) => {
      c.tls![D] = { ...goodTls(D, daysFromNow(-3)), authorized: false, authorizationError: 'CERT_HAS_EXPIRED' };
    }),
    verwacht: { band: ['hoog', 'direct'], moet: ['cert.expired'], verderSchoon: true },
  },
  {
    id: 'certificaat-verkeerde-naam',
    waarom: 'Zoals wrong.host.badssl.com: één kapot certificaat, niet dubbel tellen, wel Hoge urgentie.',
    domein: D,
    net: make(D, (c) => {
      c.tls![D] = { ...goodTls(D), authorized: false, authorizationError: 'ERR_TLS_CERT_ALTNAME_INVALID', nameMatches: false };
    }),
    verwacht: { band: ['hoog', 'direct'], moet: ['cert.name_mismatch'] },
  },
  {
    id: 'onbekende-uitgever',
    waarom: 'Zoals untrusted-root.badssl.com: niet "zelfgemaakt" noemen.',
    domein: D,
    net: make(D, (c) => {
      c.tls![D] = { ...goodTls(D), authorized: false, authorizationError: 'SELF_SIGNED_CERT_IN_CHAIN' };
    }),
    verwacht: { band: ['hoog', 'direct'], moet: ['cert.untrusted_ca'], magNiet: ['cert.self_signed'] },
  },
  {
    id: 'lets-encrypt-26-dagen',
    waarom: "Zoals www.bol.com: 90-dagencertificaat met nog 26 dagen is normaal, geen melding.",
    domein: D,
    net: make(D, (c) => {
      c.tls![D] = { ...goodTls(D, daysFromNow(26)), cert: { ...goodTls(D).cert!, validFrom: daysFromNow(-64), validTo: daysFromNow(26) } };
    }),
    verwacht: { band: ['weinig'], magNiet: ['cert.expires_30d', 'cert.expires_14d'], verderSchoon: true },
  },
  {
    id: 'jaarcertificaat-20-dagen',
    waarom: 'Een jaarcertificaat dat over 20 dagen verloopt wordt vaak met de hand verlengd: wel melden.',
    domein: D,
    net: make(D, (c) => {
      c.tls![D] = { ...goodTls(D), cert: { ...goodTls(D).cert!, validFrom: daysFromNow(-345), validTo: daysFromNow(20) } };
    }),
    verwacht: { band: ['weinig'], moet: ['cert.expires_30d'], verderSchoon: true },
  },
  {
    id: 'subdomein-met-wildcard',
    waarom: 'Zoals expired.badssl.com: www bestaat alleen via een wildcard en hoort niet in de scan.',
    domein: `shop.${D}`,
    net: () => {
      const S = `shop.${D}`;
      const c = healthyConfig(S);
      const net = fakeNet(c);
      const base = net.resolveAddresses;
      net.resolveAddresses = (n) => (n.endsWith(`.${S}`) ? Promise.resolve(['203.0.114.99']) : base(n));
      return net;
    },
    verwacht: { band: ['weinig'], assetsNiet: [`https://www.shop.${D}`] },
  },
  {
    id: 'dnssec-kapot',
    waarom: 'Zoals dnssec-failed.org: geen "bestaat niet", wel dnssec.invalid met Hoge urgentie.',
    domein: D,
    net: make(D, (c) => (c.dnssec = { [D]: { hasDs: true, validated: false, bogus: true } })),
    verwacht: { band: ['hoog', 'direct'], moet: ['dnssec.invalid'] },
  },
  {
    id: 'toestemmingscookies-zonder-httponly',
    waarom: 'Zoals nu.nl en github.com: consent- en analysecookies horen leesbaar te zijn voor scripts.',
    domein: D,
    net: make(D, (c) => site(c, { setCookies: ['_ga=GA1.1; Secure; Path=/', 'CookieConsent=ja; Secure', 'OptanonConsent=x; Secure'] })),
    verwacht: { band: ['weinig'], magNiet: ['web.cookie_no_httponly'], verderSchoon: true },
  },
  {
    id: 'sessiecookie-zonder-httponly',
    waarom: 'Een inlogsessie die scripts kunnen lezen is wel een risico.',
    domein: D,
    net: make(D, (c) => site(c, { setCookies: ['PHPSESSID=abc; Secure; Path=/'] })),
    verwacht: { band: ['weinig'], moet: ['web.cookie_no_httponly'], verderSchoon: true },
  },
  {
    id: 'cookiemuur',
    waarom: 'Zoals nu.nl en tweakers.net: doorsturen naar een toestemmingspagina betekent dat de website niet beoordeeld is.',
    domein: D,
    net: make(D, (c) => {
      c.http![`https://${D}/`] = { status: 303, headers: { location: `https://myprivacy.uitgever.nl/consent?redirectUri=https%3A%2F%2F${D}%2F` } };
    }),
    verwacht: { band: ['weinig'], magNiet: ['web.csp_missing'], uitkomst: { 'web.headers': 'unknown' } },
  },
  {
    id: 'securitytxt-doorverwijzing',
    waarom: 'Zoals rijksoverheid.nl: doorverwijzen naar de security.txt van een andere organisatie is in orde.',
    domein: D,
    net: make(D, (c) => {
      c.http![`https://${D}/.well-known/security.txt`] = { status: 301, headers: { location: 'https://www.ncsc.nl/.well-known/security.txt' } };
      c.http!['https://www.ncsc.nl/.well-known/security.txt'] = {
        headers: { 'content-type': 'text/plain' },
        body: 'Contact: https://www.ncsc.nl/contact\nExpires: 2027-06-01T00:00:00Z\n',
      };
    }),
    verwacht: { band: ['weinig'], verderSchoon: true, uitkomst: { 'web.security_txt': 'ok' } },
  },
  {
    id: 'domein-zonder-mail',
    waarom: 'Zoals neverssl.com: geen MX. Advies "dichtzetten", niet "leg vast wie mag mailen".',
    domein: D,
    net: make(D, (c) => {
      c.mx = {};
      c.txt![D] = [];
      c.txt![`_dmarc.${D}`] = [];
    }),
    verwacht: { band: ['aandacht'], moet: ['spf.missing_no_mail', 'dmarc.missing_no_mail'], magNiet: ['spf.missing', 'dmarc.missing'] },
  },
  {
    id: 'geen-mail-plus-hygiene',
    waarom: 'Zoals neverssl.com: geen mail, geen headers, versie zichtbaar. Aandacht nodig, geen Hoge urgentie.',
    domein: D,
    net: make(D, (c) => {
      c.mx = {};
      c.txt![D] = [];
      c.txt![`_dmarc.${D}`] = [];
      c.caa = {};
      c.dnssec = { [D]: { hasDs: false, validated: false, bogus: false } };
      site(c, { headers: { server: 'Apache/2.4.68' } });
      c.http![`https://${D}/.well-known/security.txt`] = { status: 404 };
    }),
    verwacht: { band: ['aandacht'], moet: ['spf.missing_no_mail', 'dmarc.missing_no_mail', 'web.hsts_missing', 'web.version_disclosed'] },
  },
  {
    id: 'spf-plus-all',
    waarom: 'Iedereen mag namens het domein mailen: een echt probleem.',
    domein: D,
    net: make(D, (c) => (c.txt![D] = ['v=spf1 +all'])),
    verwacht: { band: ['aandacht', 'hoog'], moet: ['spf.plus_all'] },
  },
  {
    id: 'apache-2.4.49-actief-misbruikt',
    waarom: 'Versie met een lek op de KEV-lijst: minimaal Hoge urgentie, vastgesteld, met CVE en bron.',
    domein: D,
    net: make(D, (c) => site(c, { headers: { ...GOOD_HEADERS, server: 'Apache/2.4.49 (Unix)' } })),
    verwacht: {
      band: ['hoog', 'direct'],
      moet: [{ key: 'web.server_kwetsbaar', zekerheid: 'vastgesteld' }, 'web.version_disclosed'],
    },
  },
  {
    id: 'ubuntu-met-oude-versies',
    waarom: 'Ubuntu zet fixes terug: einde ondersteuning hooguit "mogelijk", geen Hoge urgentie.',
    domein: D,
    net: make(D, (c) =>
      site(c, { headers: { ...GOOD_HEADERS, server: 'Apache/2.4.41 (Ubuntu)', 'x-powered-by': 'PHP/7.4.3-4ubuntu2.18' } }),
    ),
    verwacht: {
      band: ['weinig', 'aandacht'],
      moet: [{ key: 'web.server_einde_distro', zekerheid: 'mogelijk' }, 'web.version_disclosed'],
      magNiet: ['web.server_kwetsbaar', 'web.server_einde_ondersteuning'],
    },
  },
  {
    id: 'ubuntu-nginx-door-distributie-ondersteund',
    waarom: 'Zoals bitsoffreedom.nl: nginx 1.24 op Ubuntu 24.04 krijgt tot 2029 updates. Tonen, maar niet meetellen.',
    domein: D,
    net: make(D, (c) => site(c, { headers: { ...GOOD_HEADERS, server: 'nginx/1.24.0 (Ubuntu)' } })),
    verwacht: {
      band: ['weinig'],
      moet: [{ key: 'web.server_einde_distro', zekerheid: 'mogelijk' }, 'web.version_disclosed'],
      verderSchoon: true,
      maxUrgentie: 5,
    },
  },
  {
    id: 'php-7.4-zonder-distributie',
    waarom: 'PHP 7.4 krijgt sinds november 2022 geen updates meer: vastgesteld en Aandacht nodig.',
    domein: D,
    net: make(D, (c) => site(c, { headers: { ...GOOD_HEADERS, 'x-powered-by': 'PHP/7.4.33' } })),
    verwacht: { band: ['aandacht'], moet: [{ key: 'web.server_einde_ondersteuning', zekerheid: 'vastgesteld' }] },
  },
  {
    id: 'iis-8.5-windows-2012',
    waarom: 'IIS 8.5 hoort bij Windows Server 2012 R2, sinds oktober 2023 zonder updates.',
    domein: D,
    net: make(D, (c) => site(c, { headers: { ...GOOD_HEADERS, server: 'Microsoft-IIS/8.5', 'x-powered-by': 'ASP.NET' } })),
    verwacht: { band: ['aandacht'], moet: [{ key: 'web.server_einde_ondersteuning', zekerheid: 'vastgesteld' }] },
  },
  {
    id: 'versie-zonder-bekend-probleem',
    waarom: 'Een actuele versie tonen is hygiëne, geen lek: alleen de lichte melding.',
    domein: D,
    net: make(D, (c) => site(c, { headers: { ...GOOD_HEADERS, server: 'nginx/1.30.8' } })),
    verwacht: { band: ['weinig'], moet: ['web.version_disclosed'], verderSchoon: true },
  },
  {
    id: 'https-onbereikbaar',
    waarom: 'Zoals neverssl.com: alleen http. Melden dat https ontbreekt en waarschuwen dat veel niet gecontroleerd is.',
    domein: D,
    net: make(D, (c) => {
      delete c.tls![D];
      c.http![`http://${D}/`] = { status: 200, headers: {} };
      delete c.http![`https://${D}/`];
      delete c.http![`https://${D}/.well-known/security.txt`];
    }),
    verwacht: { band: ['weinig', 'aandacht'], moet: ['web.no_https_redirect'], dekkingWaarschuwing: true },
  },
  {
    id: 'wordpress-achter-met-plugins',
    waarom: 'WordPress 6.8.2 terwijl 6.8.13 er is (versie afgeleid uit ?ver=): mogelijk, voor de webbouwer, geen Hoge urgentie.',
    domein: D,
    net: make(D, (c) =>
      site(c, {
        headers: { ...GOOD_HEADERS, server: 'nginx' },
        body: '<link rel="stylesheet" href="/wp-includes/css/dist/block-library/style.min.css?ver=6.8.2"><link rel="stylesheet" href="/wp-content/plugins/woocommerce/assets/css/woocommerce.css?ver=9.8.5">',
      }),
    ),
    verwacht: { band: ['weinig'], moet: [{ key: 'web.software_update_achter', zekerheid: 'mogelijk' }], verderSchoon: true },
  },
  {
    id: 'joomla-3-einde',
    waarom: 'Joomla 3 (herkend aan /media/jui/) krijgt sinds augustus 2023 geen updates; versie afgeleid, dus mogelijk.',
    domein: D,
    net: make(D, (c) =>
      site(c, {
        headers: { ...GOOD_HEADERS },
        body: '<meta name="generator" content="Joomla! - Open Source Content Management" /><script src="/media/jui/js/jquery.min.js"></script>',
      }),
    ),
    verwacht: { band: ['weinig', 'aandacht'], moet: [{ key: 'web.software_einde_ondersteuning', zekerheid: 'mogelijk' }], verderSchoon: true },
  },
  {
    id: 'shopify-beheerd',
    waarom: 'Een webwinkel op Shopify: de leverancier werkt bij, dus geen softwaremeldingen.',
    domein: D,
    net: make(D, (c) => site(c, { headers: { ...GOOD_HEADERS, 'x-shopid': '1' }, body: '<script src="https://cdn.shopify.com/s/x.js"></script>' })),
    verwacht: { band: ['weinig'], verderSchoon: true },
  },
];
