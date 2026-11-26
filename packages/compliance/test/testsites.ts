
/**
 * Lokale testwereld voor de cookiecheck. Elk verzoek van de browser (ook naar
 * "www.google-analytics.com") wordt hier beantwoord, zodat de tests nooit het
 * echte internet raken. De trackerscripts zijn nagemaakt en
 * doen alleen wat nodig is: een cookie zetten en een meetpixel opvragen.
 */

const GTAG = `
(function () {
  var gcs = window.__gcs || 'G111';
  if (gcs === 'G111') document.cookie = '_ga=GA1.1.123.456; path=/; max-age=63072000';
  new Image().src = 'http://www.google-analytics.com/g/collect?v=2&tid=G-TEST&cid=123.456&gcs=' + gcs;
})();`;

const FBEVENTS = `
document.cookie = '_fbp=fb.1.1700000000.123; path=/; max-age=7776000';
new Image().src = 'http://www.facebook.com/tr?id=999&ev=PageView';`;

function tag(src: string, before = ''): string {
  return `${before}var s=document.createElement('script');s.src='${src}';document.head.appendChild(s);`;
}
const LOAD_GA = (gcs = 'G111') => tag('http://www.googletagmanager.com/gtag/js?id=G-TEST', `window.__gcs='${gcs}';`);
const LOAD_FB = tag('http://connect.facebook.net/en_US/fbevents.js');

interface Site {
  /** Script dat direct bij laden draait. */
  onLoad?: string;
  onAccept?: string;
  onReject?: string;
  /** Banner-HTML; knoppen met data-act="accept" of "reject". Leeg = geen banner. */
  banner?: string;
  headers?: Record<string, string>;
  extraBody?: string;
}

const GENERIC_BANNER = `
<div id="cookiebanner" style="position:fixed;bottom:0;left:0;right:0;padding:16px;background:#fff;border-top:1px solid #ccc">
  <p>Wij gebruiken cookies om onze website te verbeteren.</p>
  <button data-act="accept">Alles accepteren</button>
  <button data-act="reject">Weigeren</button>
</div>`;

export const SITES: Record<string, Site> = {
  // Doet het goed: pas na akkoord Google Analytics en Meta.
  'goed.test': {
    banner: GENERIC_BANNER,
    onAccept: LOAD_GA() + LOAD_FB,
    headers: { 'Set-Cookie': 'sessie=abc; Path=/; HttpOnly' },
  },
  // Doet het fout: trackers direct, en weigeren verandert niets. De server zet ook een Google Ads-cookie.
  'fout.test': {
    banner: GENERIC_BANNER,
    onLoad: LOAD_GA() + LOAD_FB,
    headers: { 'Set-Cookie': '_gcl_au=1.1.123; Path=/; Max-Age=7776000' },
  },
  // Google Consent Mode: GA meet direct, maar zonder cookie en met "geweigerd".
  'consentmode.test': {
    banner: GENERIC_BANNER,
    onLoad: LOAD_GA('G100'),
    onAccept: LOAD_GA('G111'),
  },
  // Alleen "Akkoord" en "Instellingen": geen weigerknop op de eerste laag.
  'alleenakkoord.test': {
    banner: `<div id="cb"><p>Cookies?</p><button data-act="accept">Akkoord</button> <a href="#instellingen">Instellingen</a></div>`,
    onAccept: LOAD_GA(),
  },
  // Geen banner en geen tracking: niets aan de hand.
  'schoon.test': {
    headers: { 'Set-Cookie': 'sessie=xyz; Path=/; HttpOnly; Secure' },
  },
  // Geen banner, wel Meta Pixel.
  'geenbanner.test': { onLoad: LOAD_FB },
  // OneTrust-knoppen, plus een afbeelding van een intern adres die de bewaking moet tegenhouden.
  'onetrust.test': {
    banner: `<div id="onetrust-banner-sdk"><button id="onetrust-accept-btn-handler" data-act="accept">Alle cookies toestaan</button>
      <button id="onetrust-reject-all-handler" data-act="reject">Alles weigeren</button></div>`,
    onAccept: LOAD_GA(),
    extraBody: '<img src="http://intern.test/admin.png" alt="">',
  },
  // Wil de bezoeker doorsturen naar een ander domein; dat volgen we niet.
  'doorsturen.test': { onLoad: `location.href='http://elders.test/';` },
};

function page(host: string, site: Site): string {
  return `<!doctype html><html lang="nl"><head><meta charset="utf-8"><title>${host}</title></head><body>
<h1>Welkom bij ${host}</h1>
${site.banner ?? ''}
${site.extraBody ?? ''}
<script>
  ${site.onLoad ?? ''}
  document.querySelectorAll('[data-act]').forEach(function (b) {
    b.addEventListener('click', function () {
      var act = b.getAttribute('data-act');
      document.cookie = 'qbicle_testkeuze=' + (act === 'accept' ? 'ja' : 'nee') + '; path=/; max-age=31536000';
      var banner = b.closest('div'); if (banner) banner.style.display = 'none';
      if (act === 'accept') { ${site.onAccept ?? ''} }
      if (act === 'reject') { ${site.onReject ?? ''} }
    });
  });
</script>
</body></html>`;
}

const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');

export interface TestResponse {
  status: number;
  headers: Record<string, string>;
  body: string | Buffer;
}

/**
 * Beantwoordt een verzoek uit de testwereld. De tests koppelen dit via
 * prepareContext aan de browser, zodat ook https-verzoeken (Chromium zet
 * bekende trackerdomeinen zelf om naar https) lokaal blijven.
 */
export function respond(url: string, hits: string[]): TestResponse {
  const u = new URL(url);
  hits.push(`${u.hostname}${u.pathname}`);
  const site = SITES[u.hostname];
  if (site && u.pathname === '/') {
    return { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', ...site.headers }, body: page(u.hostname, site) };
  }
  if (u.hostname === 'www.googletagmanager.com') return { status: 200, headers: { 'Content-Type': 'application/javascript' }, body: GTAG };
  if (u.hostname === 'connect.facebook.net') return { status: 200, headers: { 'Content-Type': 'application/javascript' }, body: FBEVENTS };
  if (['www.google-analytics.com', 'www.facebook.com', 'intern.test'].includes(u.hostname)) {
    return { status: 200, headers: { 'Content-Type': 'image/gif' }, body: GIF };
  }
  return { status: 404, headers: { 'Content-Type': 'text/plain' }, body: 'niet gevonden' };
}
