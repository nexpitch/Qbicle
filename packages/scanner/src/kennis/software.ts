import type { Source } from '@qbicle/score';

/**
 * Basiskennis over websitesoftware: wanneer een versie geen beveiligingsupdates
 * meer krijgt (einde ondersteuning) en een kleine set actief misbruikte lekken.
 *
 * Dit is een handmatig samengestelde startset (stand 26-11-2026), zodat de scanner
 * ook zonder internetverbinding iets zinnigs zegt. In productie vult de periodieke
 * taak uit fase 4 de volledige NVD-, KEV-, EPSS- en NCSC-snapshots aan
 * (zie QBICLE_VULN_DIR in docs/scanner-kwaliteit.md). Elke regel heeft een bron;
 * voeg niets toe zonder bron.
 */

export interface EolCycleDef {
  /** Versiereeks, bijvoorbeeld "8.1" of "2.4". */
  cycle: string;
  /** Laatste dag met beveiligingsupdates (ISO), true = al lang voorbij zonder vaste datum, false = ondersteund. */
  eol: string | boolean;
}

/** Wie werkt dit bij: de hostingpartij (server en taal), de webbouwer (CMS, plug-ins, scripts) of de leverancier (SaaS). */
export type Beheerder = 'hosting' | 'webbouwer' | 'leverancier';

export interface ProductDef {
  /** Vaste sleutel, ook voor de discriminator van de vingerafdruk. */
  key: string;
  /** Wie dit bijwerkt; bepaalt de actie (server-bijwerken of software-bijwerken). */
  wie: Beheerder;
  /** Slug op endoflife.date; als die er is, gaat de snapshot (eol-snapshot.json) voor `cycles`. */
  eolSlug?: string;
  /** Een bibliotheek in de browser weegt lichter dan software op de server. */
  bibliotheek?: boolean;
  /** Naam in het rapport. */
  name: string;
  /** Hoe het product in headers of de generator-tag heet. */
  match: RegExp;
  /** CPE-leverancier en -product zoals NVD ze gebruikt. */
  cpe?: { vendor: string; product: string };
  cycles?: EolCycleDef[];
  eolSources?: Source[];
  /** Hoe het versienummer bij dit product de reeks bepaalt (standaard: eerste twee delen). */
  cycleOf?: (version: string) => string[];
}

const majorMinor = (v: string) => {
  const p = v.replace(/[a-z]+$/i, '').split('.');
  return [p.slice(0, 3).join('.'), p.slice(0, 2).join('.'), p[0]!];
};

const nginxCycles: EolCycleDef[] = [];
// nginx ondersteunt alleen de actuele stable- en mainline-reeks. 1.24 en ouder krijgen
// sinds april 2025 (release 1.28) zeker geen updates meer.
for (let minor = 0; minor <= 24; minor++) nginxCycles.push({ cycle: `1.${minor}`, eol: true });

export const PRODUCTS: ProductDef[] = [
  {
    key: 'php',
    wie: 'hosting',
    eolSlug: 'php',
    name: 'PHP',
    match: /^php$/i,
    cpe: { vendor: 'php', product: 'php' },
    cycles: [
      { cycle: '5.3', eol: '2014-08-14' },
      { cycle: '5.4', eol: '2015-09-03' },
      { cycle: '5.5', eol: '2016-07-21' },
      { cycle: '5.6', eol: '2018-12-31' },
      { cycle: '7.0', eol: '2019-01-10' },
      { cycle: '7.1', eol: '2019-12-01' },
      { cycle: '7.2', eol: '2020-11-30' },
      { cycle: '7.3', eol: '2021-12-06' },
      { cycle: '7.4', eol: '2022-11-28' },
      { cycle: '8.0', eol: '2023-11-26' },
      { cycle: '8.1', eol: '2025-12-31' },
      { cycle: '8.2', eol: '2026-12-31' },
      { cycle: '8.3', eol: '2027-12-31' },
      { cycle: '8.4', eol: '2028-12-31' },
    ],
    eolSources: [
      { name: 'php.net', url: 'https://www.php.net/supported-versions.php' },
      { name: 'endoflife.date', url: 'https://endoflife.date/php' },
    ],
  },
  {
    key: 'apache-httpd',
    wie: 'hosting',
    eolSlug: 'apache-http-server',
    name: 'Apache HTTP Server',
    match: /^apache$/i,
    cpe: { vendor: 'apache', product: 'http_server' },
    cycles: [
      { cycle: '2.0', eol: '2013-07-10' },
      { cycle: '2.2', eol: '2017-07-11' },
      { cycle: '2.4', eol: false },
    ],
    eolSources: [
      { name: 'httpd.apache.org', url: 'https://httpd.apache.org/' },
      { name: 'endoflife.date', url: 'https://endoflife.date/apache-http-server' },
    ],
  },
  {
    key: 'nginx',
    wie: 'hosting',
    eolSlug: 'nginx',
    name: 'nginx',
    match: /^nginx$/i,
    cpe: { vendor: 'f5', product: 'nginx' },
    cycles: nginxCycles,
    eolSources: [
      { name: 'nginx.org', url: 'https://nginx.org/en/download.html' },
      { name: 'endoflife.date', url: 'https://endoflife.date/nginx' },
    ],
  },
  {
    key: 'openssl',
    wie: 'hosting',
    eolSlug: 'openssl',
    name: 'OpenSSL',
    match: /^openssl$/i,
    cpe: { vendor: 'openssl', product: 'openssl' },
    cycleOf: majorMinor,
    cycles: [
      { cycle: '0.9.8', eol: '2015-12-31' },
      { cycle: '1.0.0', eol: '2015-12-31' },
      { cycle: '1.0.1', eol: '2016-12-31' },
      { cycle: '1.0.2', eol: '2019-12-31' },
      { cycle: '1.1.0', eol: '2019-09-11' },
      { cycle: '1.1.1', eol: '2023-09-11' },
      { cycle: '3.0', eol: '2026-09-07' },
      { cycle: '3.1', eol: '2025-03-14' },
      { cycle: '3.2', eol: '2025-11-23' },
    ],
    eolSources: [
      { name: 'openssl-library.org', url: 'https://openssl-library.org/policies/releasestrat/' },
      { name: 'endoflife.date', url: 'https://endoflife.date/openssl' },
    ],
  },
  {
    // IIS-versie hoort vast bij een Windows Server-versie; die bepaalt de ondersteuning.
    key: 'iis',
    wie: 'hosting',
    name: 'Microsoft IIS (Windows Server)',
    match: /^microsoft-iis$/i,
    cycles: [
      { cycle: '6.0', eol: '2015-07-14' }, // Windows Server 2003
      { cycle: '7.0', eol: '2020-01-14' }, // Windows Server 2008
      { cycle: '7.5', eol: '2020-01-14' }, // Windows Server 2008 R2
      { cycle: '8.0', eol: '2023-10-10' }, // Windows Server 2012
      { cycle: '8.5', eol: '2023-10-10' }, // Windows Server 2012 R2
      { cycle: '10.0', eol: false }, // Windows Server 2016 en nieuwer
    ],
    eolSources: [
      { name: 'Microsoft Lifecycle', url: 'https://learn.microsoft.com/lifecycle/products/?terms=windows%20server' },
      { name: 'endoflife.date', url: 'https://endoflife.date/windows-server' },
    ],
  },
  {
    key: 'tomcat',
    wie: 'hosting',
    eolSlug: 'tomcat',
    name: 'Apache Tomcat',
    match: /^(?:apache-coyote|tomcat)$/i,
    cpe: { vendor: 'apache', product: 'tomcat' },
  },
  { key: 'aspnet', wie: 'hosting', name: 'ASP.NET', match: /^asp\.net$/i },
  { key: 'litespeed', wie: 'hosting', name: 'LiteSpeed', match: /^litespeed$/i },
  { key: 'openresty', wie: 'hosting', name: 'OpenResty (nginx)', match: /^openresty$/i },
  // Besturingssystemen: versie zien we zelden, maar CentOS Linux is in elke versie voorbij.
  { key: 'centos', wie: 'hosting', eolSlug: 'centos', name: 'CentOS Linux', match: /^centos$/i },
  { key: 'centos-stream', wie: 'hosting', name: 'CentOS Stream', match: /^centos-stream$/i },
  { key: 'ubuntu', wie: 'hosting', eolSlug: 'ubuntu', name: 'Ubuntu Linux', match: /^ubuntu$/i },
  { key: 'debian', wie: 'hosting', eolSlug: 'debian', name: 'Debian Linux', match: /^debian$/i },
  { key: 'rhel', wie: 'hosting', eolSlug: 'rhel', name: 'Red Hat Enterprise Linux', match: /^rhel$/i },
  { key: 'windows', wie: 'hosting', name: 'Windows Server', match: /^windows$/i },
  { key: 'freebsd', wie: 'hosting', name: 'FreeBSD', match: /^freebsd$/i },
  // CDN: zit voor de echte server; de software erachter is dan vaak niet zichtbaar.
  { key: 'cloudflare', wie: 'leverancier', name: 'Cloudflare', match: /^cloudflare$/i },
  { key: 'akamai', wie: 'leverancier', name: 'Akamai', match: /^akamai$/i },
  { key: 'cloudfront', wie: 'leverancier', name: 'Amazon CloudFront', match: /^cloudfront$/i },
  // CMS en webwinkels
  {
    key: 'wordpress',
    wie: 'webbouwer',
    eolSlug: 'wordpress',
    name: 'WordPress',
    match: /^wordpress$/i,
    cpe: { vendor: 'wordpress', product: 'wordpress' },
  },
  { key: 'drupal', wie: 'webbouwer', eolSlug: 'drupal', name: 'Drupal', match: /^drupal$/i, cpe: { vendor: 'drupal', product: 'drupal' } },
  { key: 'joomla', wie: 'webbouwer', eolSlug: 'joomla', name: 'Joomla', match: /^joomla!?$/i, cpe: { vendor: 'joomla', product: 'joomla\\!' } },
  { key: 'typo3', wie: 'webbouwer', eolSlug: 'typo3', name: 'TYPO3', match: /^typo3$/i, cpe: { vendor: 'typo3', product: 'typo3' } },
  { key: 'magento', wie: 'webbouwer', eolSlug: 'magento', name: 'Magento (Adobe Commerce)', match: /^magento$/i },
  { key: 'shopware', wie: 'webbouwer', eolSlug: 'shopware', name: 'Shopware', match: /^shopware$/i },
  { key: 'prestashop', wie: 'webbouwer', name: 'PrestaShop', match: /^prestashop$/i },
  // Beheerde platforms: de leverancier werkt de software bij.
  { key: 'shopify', wie: 'leverancier', name: 'Shopify', match: /^shopify$/i },
  { key: 'wix', wie: 'leverancier', name: 'Wix', match: /^wix$/i },
  { key: 'squarespace', wie: 'leverancier', name: 'Squarespace', match: /^squarespace$/i },
  { key: 'webflow', wie: 'leverancier', name: 'Webflow', match: /^webflow$/i },
  { key: 'lightspeed', wie: 'leverancier', name: 'Lightspeed eCom', match: /^lightspeed$/i },
  // Bibliotheken die in de browser van de bezoeker draaien.
  { key: 'jquery', wie: 'webbouwer', eolSlug: 'jquery', bibliotheek: true, name: 'jQuery', match: /^jquery$/i, cpe: { vendor: 'jquery', product: 'jquery' } },
  { key: 'jquery-ui', wie: 'webbouwer', eolSlug: 'jquery-ui', bibliotheek: true, name: 'jQuery UI', match: /^jquery-ui$/i, cpe: { vendor: 'jqueryui', product: 'jquery_ui' } },
  { key: 'bootstrap', wie: 'webbouwer', eolSlug: 'bootstrap', bibliotheek: true, name: 'Bootstrap', match: /^bootstrap$/i, cpe: { vendor: 'getbootstrap', product: 'bootstrap' } },
  { key: 'angularjs', wie: 'webbouwer', eolSlug: 'angularjs', bibliotheek: true, name: 'AngularJS', match: /^angularjs$/i, cpe: { vendor: 'angularjs', product: 'angular.js' } },
  { key: 'vue', wie: 'webbouwer', eolSlug: 'vue', bibliotheek: true, name: 'Vue.js', match: /^vue(?:\.js)?$/i, cpe: { vendor: 'vuejs', product: 'vue.js' } },
];

export const productByKey = (key: string) => PRODUCTS.find((p) => p.key === key);

/**
 * Actief misbruikte lekken (CISA KEV) in websitesoftware, in het formaat van de
 * NVD CVE API 2.0, zodat dezelfde VulnDb ze inleest als de echte snapshot.
 */
export const BASE_NVD = {
  vulnerabilities: [
    {
      cve: {
        id: 'CVE-2021-41773',
        descriptions: [{ lang: 'en', value: 'Path traversal and file disclosure in Apache HTTP Server 2.4.49.' }],
        metrics: { cvssMetricV31: [{ cvssData: { baseScore: 7.5 } }] },
        configurations: [{ nodes: [{ cpeMatch: [{ vulnerable: true, criteria: 'cpe:2.3:a:apache:http_server:2.4.49:*:*:*:*:*:*:*' }] }] }],
      },
    },
    {
      cve: {
        id: 'CVE-2021-42013',
        descriptions: [{ lang: 'en', value: 'Path traversal and remote code execution in Apache HTTP Server 2.4.49 and 2.4.50 (incomplete fix of CVE-2021-41773).' }],
        metrics: { cvssMetricV31: [{ cvssData: { baseScore: 9.8 } }] },
        configurations: [
          {
            nodes: [
              {
                cpeMatch: [
                  { vulnerable: true, criteria: 'cpe:2.3:a:apache:http_server:2.4.49:*:*:*:*:*:*:*' },
                  { vulnerable: true, criteria: 'cpe:2.3:a:apache:http_server:2.4.50:*:*:*:*:*:*:*' },
                ],
              },
            ],
          },
        ],
      },
    },
    {
      cve: {
        id: 'CVE-2014-0160',
        descriptions: [{ lang: 'en', value: 'Heartbleed: memory disclosure in the TLS heartbeat extension of OpenSSL 1.0.1 through 1.0.1f.' }],
        metrics: { cvssMetricV31: [{ cvssData: { baseScore: 7.5 } }] },
        configurations: [
          {
            nodes: [
              {
                cpeMatch: [
                  { vulnerable: true, criteria: 'cpe:2.3:a:openssl:openssl:*:*:*:*:*:*:*:*', versionStartIncluding: '1.0.1', versionEndIncluding: '1.0.1f' },
                ],
              },
            ],
          },
        ],
      },
    },
    {
      cve: {
        id: 'CVE-2024-4577',
        descriptions: [{ lang: 'en', value: 'PHP-CGI argument injection on Windows (certain code pages).' }],
        metrics: { cvssMetricV31: [{ cvssData: { baseScore: 9.8 } }] },
        configurations: [
          {
            nodes: [
              {
                cpeMatch: [
                  { vulnerable: true, criteria: 'cpe:2.3:a:php:php:*:*:*:*:*:*:*:*', versionStartIncluding: '8.1.0', versionEndExcluding: '8.1.29' },
                  { vulnerable: true, criteria: 'cpe:2.3:a:php:php:*:*:*:*:*:*:*:*', versionStartIncluding: '8.2.0', versionEndExcluding: '8.2.20' },
                  { vulnerable: true, criteria: 'cpe:2.3:a:php:php:*:*:*:*:*:*:*:*', versionStartIncluding: '8.3.0', versionEndExcluding: '8.3.8' },
                ],
              },
            ],
          },
        ],
      },
    },
    {
      cve: {
        id: 'CVE-2020-11023',
        descriptions: [{ lang: 'en', value: 'Cross-site scripting in jQuery before 3.5.0 when passing HTML containing <option> elements from untrusted sources to DOM manipulation methods.' }],
        metrics: { cvssMetricV31: [{ cvssData: { baseScore: 6.1 } }] },
        configurations: [
          { nodes: [{ cpeMatch: [{ vulnerable: true, criteria: 'cpe:2.3:a:jquery:jquery:*:*:*:*:*:*:*:*', versionStartIncluding: '1.0.3', versionEndExcluding: '3.5.0' }] }] },
        ],
      },
    },
    {
      cve: {
        id: 'CVE-2020-11022',
        descriptions: [{ lang: 'en', value: 'Cross-site scripting in jQuery 1.2 up to 3.5.0 when passing HTML from untrusted sources to DOM manipulation methods.' }],
        metrics: { cvssMetricV31: [{ cvssData: { baseScore: 6.1 } }] },
        configurations: [
          { nodes: [{ cpeMatch: [{ vulnerable: true, criteria: 'cpe:2.3:a:jquery:jquery:*:*:*:*:*:*:*:*', versionStartIncluding: '1.2', versionEndExcluding: '3.5.0' }] }] },
        ],
      },
    },
  ],
};

export const BASE_KEV = {
  vulnerabilities: [
    { cveID: 'CVE-2021-41773', dateAdded: '2021-11-03' },
    { cveID: 'CVE-2021-42013', dateAdded: '2021-11-03' },
    { cveID: 'CVE-2014-0160', dateAdded: '2022-05-04' },
    { cveID: 'CVE-2024-4577', dateAdded: '2024-06-12', knownRansomwareCampaignUse: 'Known' },
    { cveID: 'CVE-2020-11023', dateAdded: '2025-01-23' },
  ],
};

/**
 * Lekken die alleen onder een voorwaarde gelden die we van buitenaf niet zien
 * (besturingssysteem, configuratie). Die melden we altijd als "mogelijk".
 */
export const CONDITIONAL: Record<string, string> = {
  'CVE-2024-4577': 'Alleen als PHP als CGI op Windows draait; dat zien we van buitenaf niet.',
  'CVE-2020-11022': 'Alleen als de website HTML van buiten (bijvoorbeeld uit een formulier) via jQuery in de pagina zet; dat zien we van buitenaf niet.',
  'CVE-2020-11023': 'Alleen als de website HTML van buiten (bijvoorbeeld uit een formulier) via jQuery in de pagina zet; dat zien we van buitenaf niet.',
};
