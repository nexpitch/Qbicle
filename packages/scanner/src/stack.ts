import type { HttpResponse } from './net.ts';

/**
 * Herkenning van CMS, webwinkel, plug-ins, thema's, bibliotheken en besturingssysteem
 * uit de voorpagina zoals elke bezoeker hem krijgt: headers, cookienamen, de
 * generator-tag en de adressen van scripts en stylesheets in de HTML.
 *
 * Grenzen (bewust):
 * - We vragen geen extra pagina's of bestanden op (geen /wp-login.php, geen readme.html,
 *   geen /CHANGELOG.txt). Alles komt uit hetzelfde ene bezoek als de andere webchecks.
 * - Een product heet "zeker" als de website het zelf zegt (header, generator-tag,
 *   een header die alleen dat product zet). Afgeleid uit paden is het "waarschijnlijk".
 * - Een versie heet "zeker" als de website hem zelf noemt; uit een ?ver= of een
 *   bestandsnaam is hij "waarschijnlijk". Zien we geen versie, dan is hij "verborgen":
 *   dat is goed, en dan zeggen we niets over updates.
 */

export type Categorie =
  | 'cms'
  | 'webwinkel'
  | 'platform'
  | 'taal'
  | 'webserver'
  | 'besturingssysteem'
  | 'tls-bibliotheek'
  | 'cdn'
  | 'plugin'
  | 'thema'
  | 'js-bibliotheek';

export type Zekerheid = 'zeker' | 'waarschijnlijk';

export interface StackHit {
  /** Sleutel van het product in de kennisbank (PRODUCTS), of "plugin:<slug>" / "thema:<slug>". */
  key: string;
  naam: string;
  categorie: Categorie;
  /** Lege string als de versie niet zichtbaar is. */
  versie: string;
  productZekerheid: Zekerheid;
  versieZekerheid: Zekerheid | 'verborgen';
  /** Waar we het aan zien, in gewone taal. */
  bron: string;
}

const attrUrls = (body: string): string[] =>
  [...body.matchAll(/\b(?:src|href)\s*=\s*["']([^"']{1,500})["']/gi)].map((m) => m[1]!.replace(/&amp;/g, '&'));

/** Meest voorkomende waarde (bij gelijkspel de hoogste), of undefined. */
function mostCommon(values: string[]): string | undefined {
  const n = new Map<string, number>();
  for (const v of values) n.set(v, (n.get(v) ?? 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1] || b[0].localeCompare(a[0], undefined, { numeric: true }))[0]?.[0];
}

function generator(body: string): string | undefined {
  const all = [
    ...body.matchAll(/<meta[^>]+name=["']generator["'][^>]*content=["']([^"']+)["']/gi),
    ...body.matchAll(/<meta[^>]+content=["']([^"']+)["'][^>]*name=["']generator["']/gi),
  ].map((m) => m[1]!);
  return all.join(' | ') || undefined;
}

const cookieNames = (res: HttpResponse) => res.setCookies.map((c) => c.split('=')[0]!.trim());

const PLUGIN_NAMES: Record<string, string> = {
  woocommerce: 'WooCommerce',
  'contact-form-7': 'Contact Form 7',
  elementor: 'Elementor',
  'elementor-pro': 'Elementor Pro',
  'wordpress-seo': 'Yoast SEO',
  'js_composer': 'WPBakery Page Builder',
  revslider: 'Slider Revolution',
  'gravityforms': 'Gravity Forms',
  'wp-rocket': 'WP Rocket',
  'complianz-gdpr': 'Complianz',
  'cookie-law-info': 'CookieYes',
  'wpforms-lite': 'WPForms',
  'jetpack': 'Jetpack',
  'litespeed-cache': 'LiteSpeed Cache',
  'sitepress-multilingual-cms': 'WPML',
  'wp-super-cache': 'WP Super Cache',
  'w3-total-cache': 'W3 Total Cache',
  'all-in-one-seo-pack': 'All in One SEO',
  'really-simple-ssl': 'Really Simple SSL',
  'wordfence': 'Wordfence',
};

export function detectStack(res: HttpResponse): StackHit[] {
  const out: StackHit[] = [];
  const h = res.headers;
  const body = res.body;
  const urls = attrUrls(body);
  const gen = generator(body) ?? '';
  const xgen = h['x-generator'] ?? '';
  const cookies = cookieNames(res);
  const add = (hit: StackHit) => out.push(hit);

  // WordPress ------------------------------------------------------------------------------
  const wpPaths = urls.filter((u) => /\/wp-(?:content|includes)\//.test(u));
  const wpGen = gen.match(/WordPress\s*(\d+(?:\.\d+)+)?/i);
  const wpApi = /api\.w\.org/.test(h.link ?? '') || /api\.w\.org/.test(body);
  if (wpGen || wpApi || wpPaths.length >= 2) {
    // Kernbestanden krijgen de WordPress-versie als ?ver=; scripts van bibliotheken (jQuery) niet.
    const coreVers = urls
      .filter((u) => /\/wp-includes\/(?:css\/|js\/wp-emoji|js\/dist\/)/.test(u))
      .map((u) => u.match(/[?&]ver=(\d+\.\d+(?:\.\d+)?)/)?.[1])
      .filter((v): v is string => !!v);
    const fromGen = wpGen?.[1];
    const guess = mostCommon(coreVers);
    add({
      key: 'wordpress',
      naam: 'WordPress',
      categorie: 'cms',
      versie: fromGen ?? guess ?? '',
      productZekerheid: wpGen || wpApi ? 'zeker' : 'waarschijnlijk',
      versieZekerheid: fromGen ? 'zeker' : guess ? 'waarschijnlijk' : 'verborgen',
      bron: fromGen ? 'generator-tag in de pagina' : guess ? 'versienummer achter de WordPress-bestanden (?ver=)' : 'WordPress-paden in de pagina (/wp-content/)',
    });
    const wpVersion = fromGen ?? guess;
    for (const [kind, re] of [
      ['plugin', /\/wp-content\/plugins\/([a-z0-9_-]{2,80})\//i],
      ['thema', /\/wp-content\/themes\/([a-z0-9_-]{2,80})\//i],
    ] as const) {
      const found = new Map<string, string[]>();
      for (const u of urls) {
        const m = u.match(re);
        if (!m) continue;
        const slug = m[1]!.toLowerCase();
        const v = u.match(/[?&]ver=(\d+(?:\.\d+){1,3})/)?.[1];
        found.set(slug, [...(found.get(slug) ?? []), ...(v ? [v] : [])]);
      }
      for (const [slug, vers] of found) {
        // Is ?ver= gelijk aan de WordPress-versie, dan zegt het niets over de plug-in zelf.
        const v = mostCommon(vers.filter((x) => x !== wpVersion));
        add({
          key: `${kind}:${slug}`,
          naam: PLUGIN_NAMES[slug] ?? slug,
          categorie: kind,
          versie: v ?? '',
          productZekerheid: 'zeker',
          versieZekerheid: v ? 'waarschijnlijk' : 'verborgen',
          bron: `pad /wp-content/${kind === 'plugin' ? 'plugins' : 'themes'}/${slug}/ in de pagina`,
        });
      }
    }
  }

  // Drupal ---------------------------------------------------------------------------------
  const drupalGen = `${xgen} ${gen}`.match(/Drupal\s*(\d+(?:\.\d+)*)?/i);
  const drupalHeader = h['x-drupal-cache'] !== undefined || h['x-drupal-dynamic-cache'] !== undefined;
  const drupal7 = urls.some((u) => /\/misc\/drupal\.js/.test(u));
  const drupal8 = urls.some((u) => /\/core\/(?:misc\/drupal\.js|assets\/vendor\/)/.test(u));
  if (drupalGen || drupalHeader || drupal7 || drupal8 || /drupal-settings-json/.test(body)) {
    const v = drupalGen?.[1] ?? (drupal7 ? '7' : '');
    add({
      key: 'drupal',
      naam: 'Drupal',
      categorie: 'cms',
      versie: v,
      productZekerheid: drupalGen || drupalHeader ? 'zeker' : 'waarschijnlijk',
      versieZekerheid: drupalGen?.[1] ? 'zeker' : drupal7 ? 'waarschijnlijk' : 'verborgen',
      bron: drupalGen?.[1]
        ? 'generator-melding van de website'
        : drupal7
          ? 'bestand /misc/drupal.js (alleen Drupal 7 gebruikt dat pad)'
          : drupalHeader
            ? 'Drupal-header van de website'
            : 'Drupal-paden in de pagina',
    });
  }

  // Joomla ---------------------------------------------------------------------------------
  const joomlaGen = gen.match(/Joomla!?\s*(\d+(?:\.\d+)+)?/i);
  const joomla3 = urls.some((u) => /\/media\/jui\//.test(u));
  const joomla4 = urls.some((u) => /\/media\/(?:templates\/site|vendor\/joomla-custom-elements)\//.test(u));
  if (/joomla/i.test(gen) || joomla3 || joomla4 || urls.some((u) => /\/components\/com_[a-z]+\//.test(u) && /\/media\/system\//.test(body))) {
    const gv = joomlaGen?.[1];
    add({
      key: 'joomla',
      naam: 'Joomla',
      categorie: 'cms',
      versie: gv ?? (joomla3 ? '3' : ''),
      productZekerheid: /joomla/i.test(gen) ? 'zeker' : 'waarschijnlijk',
      versieZekerheid: gv ? 'zeker' : joomla3 ? 'waarschijnlijk' : 'verborgen',
      bron: gv ? 'generator-tag in de pagina' : joomla3 ? 'map /media/jui/ (hoort bij Joomla 3)' : 'Joomla-paden of generator-tag in de pagina',
    });
  }

  // TYPO3 ----------------------------------------------------------------------------------
  const typo3Gen = gen.match(/TYPO3\s*(?:CMS\s*)?(\d+(?:\.\d+)*)?/i);
  if (typo3Gen || urls.some((u) => /\/typo3(?:conf|temp)\//.test(u))) {
    const v = typo3Gen?.[1] ?? '';
    add({
      key: 'typo3',
      naam: 'TYPO3',
      categorie: 'cms',
      versie: v,
      productZekerheid: typo3Gen ? 'zeker' : 'waarschijnlijk',
      versieZekerheid: v ? 'zeker' : 'verborgen',
      bron: typo3Gen ? 'generator-tag in de pagina' : 'TYPO3-paden in de pagina (/typo3conf/, /typo3temp/)',
    });
  }

  // Magento / Adobe Commerce ----------------------------------------------------------------
  const mageHeader = Object.keys(h).some((k) => k.startsWith('x-magento-'));
  const mage2 = urls.some((u) => /\/static\/(?:version\d+\/)?frontend\/[^/]+\/[^/]+\//.test(u)) || cookies.includes('X-Magento-Vary');
  const mage1 = urls.some((u) => /\/skin\/frontend\//.test(u)) || /Mage\.Cookies/.test(body);
  if (mageHeader || mage2 || mage1) {
    add({
      key: 'magento',
      naam: 'Magento (Adobe Commerce)',
      categorie: 'webwinkel',
      versie: mage1 && !mage2 ? '1' : '',
      productZekerheid: mageHeader || cookies.includes('X-Magento-Vary') ? 'zeker' : 'waarschijnlijk',
      versieZekerheid: mage1 && !mage2 ? 'waarschijnlijk' : 'verborgen',
      bron: mage1 && !mage2 ? 'Magento 1-paden in de pagina (/skin/frontend/)' : 'Magento-kenmerken in de pagina of headers',
    });
  }

  // PrestaShop en Shopware ------------------------------------------------------------------
  if (/PrestaShop/i.test(gen) || /\bvar prestashop\s*=/.test(body) || cookies.some((c) => /^PrestaShop-/.test(c))) {
    add({ key: 'prestashop', naam: 'PrestaShop', categorie: 'webwinkel', versie: '', productZekerheid: 'zeker', versieZekerheid: 'verborgen', bron: 'PrestaShop-kenmerken in de pagina' });
  }
  if (/Shopware/i.test(gen) || h['sw-version-id'] !== undefined || cookies.includes('sw-states')) {
    add({ key: 'shopware', naam: 'Shopware', categorie: 'webwinkel', versie: '', productZekerheid: 'zeker', versieZekerheid: 'verborgen', bron: 'Shopware-kenmerken in de pagina of headers' });
  }

  // Beheerde platforms (de leverancier werkt de software bij) ---------------------------------
  const platforms: [string, string, boolean][] = [
    ['shopify', 'Shopify', h['x-shopid'] !== undefined || h['x-shopify-stage'] !== undefined || /cdn\.shopify\.com/.test(body)],
    ['wix', 'Wix', h['x-wix-request-id'] !== undefined || /static\.wixstatic\.com/.test(body)],
    ['squarespace', 'Squarespace', /static1\.squarespace\.com/.test(body)],
    ['webflow', 'Webflow', /Webflow/i.test(gen) || /\bdata-wf-site=/.test(body)],
    ['lightspeed', 'Lightspeed eCom', /cdn\.webshopapp\.com/.test(body)],
  ];
  for (const [key, naam, hit] of platforms) {
    if (hit) add({ key, naam, categorie: 'platform', versie: '', productZekerheid: 'zeker', versieZekerheid: 'verborgen', bron: `${naam}-kenmerken in de pagina of headers` });
  }

  // Webservers zonder versienummer en CDN's ---------------------------------------------------
  const server = (h.server ?? '').trim();
  const bareServers: [RegExp, string, string, Categorie][] = [
    [/^apache$/i, 'apache-httpd', 'Apache HTTP Server', 'webserver'],
    [/^nginx$/i, 'nginx', 'nginx', 'webserver'],
    [/^openresty$/i, 'openresty', 'OpenResty (nginx)', 'webserver'],
    [/^litespeed$/i, 'litespeed', 'LiteSpeed', 'webserver'],
    [/^microsoft-iis$/i, 'iis', 'Microsoft IIS (Windows Server)', 'webserver'],
    [/^cloudflare$/i, 'cloudflare', 'Cloudflare', 'cdn'],
    [/^(?:akamaighost|akamai)/i, 'akamai', 'Akamai', 'cdn'],
    [/^(?:cloudfront|amazons3)$/i, 'cloudfront', 'Amazon CloudFront', 'cdn'],
  ];
  const first = server.split(/[\s/]/)[0] ?? '';
  for (const [re, key, naam, categorie] of bareServers) {
    if (re.test(first) && !/\//.test(server.split(/\s/)[0] ?? '')) {
      add({ key, naam, categorie, versie: '', productZekerheid: 'zeker', versieZekerheid: 'verborgen', bron: 'Server-header (zonder versienummer)' });
    }
  }
  if (h['cf-ray'] !== undefined && !/^cloudflare$/i.test(first)) {
    add({ key: 'cloudflare', naam: 'Cloudflare', categorie: 'cdn', versie: '', productZekerheid: 'zeker', versieZekerheid: 'verborgen', bron: 'Cloudflare-header' });
  }

  // Taal zonder versie ------------------------------------------------------------------------
  const powered = h['x-powered-by'] ?? '';
  if (!/PHP\/\d/i.test(powered) && (/^PHP$/i.test(powered.trim()) || cookies.includes('PHPSESSID'))) {
    add({ key: 'php', naam: 'PHP', categorie: 'taal', versie: '', productZekerheid: 'zeker', versieZekerheid: 'verborgen', bron: cookies.includes('PHPSESSID') ? 'cookie PHPSESSID' : 'X-Powered-By-header' });
  }
  if (/ASP\.NET/i.test(powered) || cookies.includes('ASP.NET_SessionId')) {
    add({ key: 'aspnet', naam: 'ASP.NET', categorie: 'taal', versie: '', productZekerheid: 'zeker', versieZekerheid: 'verborgen', bron: /ASP\.NET/i.test(powered) ? 'X-Powered-By-header' : 'cookie ASP.NET_SessionId' });
  }

  // Besturingssysteem uit de Server-header ----------------------------------------------------
  const os: [RegExp, string, string][] = [
    [/\(CentOS\)/i, 'centos', 'CentOS Linux'],
    [/\(CentOS Stream\)/i, 'centos-stream', 'CentOS Stream'],
    [/\(Ubuntu\)|ubuntu/i, 'ubuntu', 'Ubuntu Linux'],
    [/\(Debian\)|deb\d+u|\+deb/i, 'debian', 'Debian Linux'],
    [/\(Red Hat(?: Enterprise Linux)?\)|\.el\d/i, 'rhel', 'Red Hat Enterprise Linux (of afgeleide)'],
    [/\((?:Rocky Linux|AlmaLinux)\)/i, 'rhel', 'Rocky/AlmaLinux (Red Hat-afgeleide)'],
    [/\(Win(?:32|64)\)/i, 'windows', 'Windows'],
    [/\(FreeBSD\)/i, 'freebsd', 'FreeBSD'],
  ];
  const osText = `${server} ${powered}`;
  for (const [re, key, naam] of os) {
    if (key === 'centos' && /CentOS Stream/i.test(osText)) continue;
    if (re.test(osText) && !out.some((o) => o.key === key && o.categorie === 'besturingssysteem')) {
      add({
        key,
        naam,
        categorie: 'besturingssysteem',
        // "(CentOS)" zonder Stream zetten alleen CentOS Linux 7 en ouder.
        versie: key === 'centos' ? '7' : '',
        productZekerheid: 'waarschijnlijk',
        versieZekerheid: key === 'centos' ? 'waarschijnlijk' : 'verborgen',
        bron: 'opmerking in de Server- of X-Powered-By-header',
      });
    }
  }
  if (/^microsoft-iis/i.test(server)) {
    add({ key: 'windows', naam: 'Windows Server', categorie: 'besturingssysteem', versie: '', productZekerheid: 'zeker', versieZekerheid: 'verborgen', bron: 'IIS draait alleen op Windows Server' });
  }

  // Bibliotheken in de browser ------------------------------------------------------------------
  const libs: { key: string; naam: string; res: RegExp[] }[] = [
    {
      key: 'jquery',
      naam: 'jQuery',
      res: [
        /(?:^|\/)jquery[.-](\d+\.\d+\.\d+)(?:\.slim)?(?:\.min)?\.js/i,
        /\/jquery\/(\d+\.\d+\.\d+)\/jquery(?:\.slim)?(?:\.min)?\.js/i,
        /\/jquery@(\d+\.\d+\.\d+)\//i,
        /\/jquery(?:\.slim)?(?:\.min)?\.js\?ver=(\d+\.\d+\.\d+)/i,
      ],
    },
    {
      key: 'jquery-ui',
      naam: 'jQuery UI',
      res: [/jquery-ui[.-](\d+\.\d+\.\d+)/i, /\/jqueryui\/(\d+\.\d+\.\d+)\//i, /\/ui\/(\d+\.\d+\.\d+)\/jquery-ui/i, /\/jquery-ui(?:\.min)?\.js\?ver=(\d+\.\d+\.\d+)/i],
    },
    {
      key: 'bootstrap',
      naam: 'Bootstrap',
      res: [/\/bootstrap@(\d+\.\d+\.\d+)\//i, /\/(?:twitter-)?bootstrap\/(\d+\.\d+\.\d+)\//i, /bootstrap[.-](\d+\.\d+\.\d+)(?:\.min)?\.(?:js|css)/i],
    },
    {
      key: 'angularjs',
      naam: 'AngularJS',
      res: [/\/angularjs\/(1\.\d+\.\d+)\//i, /\/angular\.js@(1\.\d+\.\d+)\//i, /angular[.-](1\.\d+\.\d+)(?:\.min)?\.js/i],
    },
    { key: 'vue', naam: 'Vue.js', res: [/\/vue@(\d+\.\d+\.\d+)\//i, /\/vue\/(\d+\.\d+\.\d+)\/vue/i] },
  ];
  for (const lib of libs) {
    const vers = urls.flatMap((u) => lib.res.map((re) => u.match(re)?.[1]).filter((v): v is string => !!v));
    const v = mostCommon(vers);
    if (v) {
      add({
        key: lib.key,
        naam: lib.naam,
        categorie: 'js-bibliotheek',
        versie: v,
        productZekerheid: 'zeker',
        versieZekerheid: 'waarschijnlijk',
        bron: 'versienummer in het adres van het script of stylesheet',
      });
    }
  }

  const seen = new Set<string>();
  return out.filter((o) => {
    const k = `${o.categorie}/${o.key}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
