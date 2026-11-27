import { HEADER_MAATREGELEN, MAATREGEL_TEKST, kennisStand, onderdelenUitAntwoord, type WebProfiel } from '@qbicle/scanner';
import type { Actor } from './audit.ts';
import type { Platform } from './context.ts';
import { withTransaction } from './db.ts';
import { PlatformError } from './errors.ts';
import { authorize } from './organizations.ts';

/**
 * Voorbeelddata voor het klantdashboard, zolang de scan-worker nog geen
 * resultaten opslaat. Alleen buiten productie en alleen als
 * QBICLE_DEMODATA=aan. Alles hangt aan het domein voorbeeldbedrijf.example
 * (.example is gereserveerd en bestaat nooit echt) en is te herkennen aan
 * source = 'demo'. Opnieuw vullen vervangt de vorige voorbeelddata.
 */

export const DEMO_DOMAIN = 'voorbeeldbedrijf.example';

export function demoDataAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV !== 'production' && env.QBICLE_DEMODATA === 'aan';
}

interface DemoAsset {
  key: string;
  type: string;
  value: string;
  visibility: 'primair' | 'subdomein' | 'alleen-ct' | null;
  exposure: 'internet' | 'cloud' | 'intern' | 'onbekend';
  managed?: 'ja' | 'nee' | 'onbekend';
  category?: string;
  days: number;
}

interface DemoFinding {
  asset: string;
  check: string;
  key: string;
  certainty: 'vastgesteld' | 'mogelijk' | 'onbekend';
  title: string;
  detail: string;
  days: number;
  resolvedDays?: number;
  cves?: string[];
  sources?: { name: string; url: string }[];
}

const D = DEMO_DOMAIN;

const ASSETS: DemoAsset[] = [
  { key: 'domein', type: 'domein', value: D, visibility: 'primair', exposure: 'internet', days: 84 },
  { key: 'www', type: 'website', value: `https://www.${D}`, visibility: 'primair', exposure: 'internet', days: 84 },
  { key: 'cert', type: 'certificaat', value: `www.${D}`, visibility: 'primair', exposure: 'internet', days: 84 },
  { key: 'mail', type: 'mailserver', value: 'voorbeeldbedrijf-example.mail.protection.outlook.com', visibility: 'primair', exposure: 'internet', days: 84 },
  { key: 'shop-sub', type: 'subdomein', value: `webshop.${D}`, visibility: 'subdomein', exposure: 'internet', days: 84 },
  { key: 'shop', type: 'website', value: `https://webshop.${D}`, visibility: 'subdomein', exposure: 'internet', days: 84 },
  { key: 'oud', type: 'subdomein', value: `oud.${D}`, visibility: 'alleen-ct', exposure: 'internet', days: 84 },
  { key: 'vpn', type: 'host', value: `vpn.${D}`, visibility: 'subdomein', exposure: 'internet', category: 'firewall', days: 70 },
  { key: 'm365', type: 'cloudresource', value: `Microsoft 365 (${D})`, visibility: null, exposure: 'cloud', managed: 'ja', days: 56 },
  { key: 'admin', type: 'account', value: `beheer@${D}`, visibility: null, exposure: 'cloud', managed: 'ja', days: 56 },
  { key: 'modem', type: 'netwerkapparaat', value: 'KPN Box 12 (modem)', visibility: null, exposure: 'internet', managed: 'nee', category: 'router', days: 42 },
  { key: 'deco', type: 'netwerkapparaat', value: 'TP-Link Deco X20 (wifi)', visibility: null, exposure: 'intern', managed: 'nee', category: 'accesspoint', days: 42 },
  { key: 'nas', type: 'apparaat', value: 'Synology NAS DS218', visibility: null, exposure: 'intern', managed: 'nee', category: 'nas', days: 42 },
  { key: 'printer', type: 'apparaat', value: 'HP LaserJet Pro M404', visibility: null, exposure: 'intern', managed: 'nee', category: 'printer', days: 42 },
  { key: 'laptop', type: 'apparaat', value: 'Laptop receptie (Windows 11)', visibility: null, exposure: 'intern', managed: 'ja', category: 'laptop', days: 42 },
];

const RFC_SPF = { name: 'RFC 7208 (SPF)', url: 'https://www.rfc-editor.org/rfc/rfc7208' };
const RFC_DMARC = { name: 'RFC 7489 (DMARC)', url: 'https://www.rfc-editor.org/rfc/rfc7489' };
const FORUM_DMARC = { name: 'Forum Standaardisatie: DMARC', url: 'https://www.forumstandaardisatie.nl/open-standaarden/dmarc' };
const INTERNET_NL = { name: 'Internet.nl', url: 'https://internet.nl/' };

const FINDINGS: DemoFinding[] = [
  {
    asset: 'domein', check: 'dmarc', key: 'dmarc.missing', certainty: 'vastgesteld', days: 84, resolvedDays: 20,
    title: 'DMARC staat niet aan', detail: `Er staat geen DMARC-record op _dmarc.${D}.`, sources: [RFC_DMARC, FORUM_DMARC],
  },
  {
    asset: 'domein', check: 'dmarc', key: 'dmarc.p_none', certainty: 'vastgesteld', days: 20,
    title: 'DMARC staat aan, maar houdt nepmail nog niet tegen',
    detail: `Het DMARC-record op _dmarc.${D} heeft p=none. Ontvangers leveren nepmail uit jouw naam dan nog gewoon af.`,
    sources: [RFC_DMARC, FORUM_DMARC],
  },
  {
    asset: 'domein', check: 'spf', key: 'spf.neutral_all', certainty: 'vastgesteld', days: 84, resolvedDays: 9,
    title: 'De SPF-instelling eindigt met ?all',
    detail: `Het SPF-record van ${D} eindigt met ?all. Daarmee zeg je ontvangers niet wat ze moeten doen met mail van andere servers.`,
    sources: [RFC_SPF, INTERNET_NL],
  },
  {
    asset: 'domein', check: 'dnssec', key: 'dnssec.missing', certainty: 'vastgesteld', days: 84,
    title: 'DNSSEC staat niet aan', detail: `${D} is niet ondertekend met DNSSEC.`, sources: [INTERNET_NL],
  },
  {
    asset: 'domein', check: 'caa', key: 'caa.missing', certainty: 'vastgesteld', days: 84,
    title: 'Niet vastgelegd wie certificaten mag uitgeven', detail: `Er staat geen CAA-record op ${D}.`,
    sources: [{ name: 'RFC 8659 (CAA)', url: 'https://www.rfc-editor.org/rfc/rfc8659' }],
  },
  {
    asset: 'cert', check: 'tls', key: 'cert.expires_14d', certainty: 'vastgesteld', days: 4,
    title: 'Het certificaat verloopt binnen 14 dagen',
    detail: `Het certificaat van www.${D} verloopt over 10 dagen. Het lijkt niet automatisch te worden verlengd.`,
  },
  {
    asset: 'www', check: 'headers', key: 'web.hsts_missing', certainty: 'vastgesteld', days: 84, resolvedDays: 35,
    title: 'De website dwingt geen beveiligde verbinding af (HSTS)', detail: `https://www.${D} stuurt geen Strict-Transport-Security mee.`,
    sources: [{ name: 'MDN: Strict-Transport-Security', url: 'https://developer.mozilla.org/docs/Web/HTTP/Headers/Strict-Transport-Security' }],
  },
  {
    asset: 'www', check: 'headers', key: 'web.csp_missing', certainty: 'vastgesteld', days: 84,
    title: 'Geen Content-Security-Policy op de website', detail: `https://www.${D} stuurt geen Content-Security-Policy mee.`,
    sources: [{ name: 'MDN: Content-Security-Policy', url: 'https://developer.mozilla.org/docs/Web/HTTP/CSP' }],
  },
  {
    asset: 'www', check: 'securitytxt', key: 'web.securitytxt_missing', certainty: 'vastgesteld', days: 84,
    title: 'Geen security.txt', detail: `Op https://www.${D}/.well-known/security.txt staat niets. Onderzoekers weten zo niet waar ze een lek kunnen melden.`,
    sources: [{ name: 'RFC 9116 (security.txt)', url: 'https://www.rfc-editor.org/rfc/rfc9116' }],
  },
  {
    asset: 'shop', check: 'https', key: 'web.no_https_redirect', certainty: 'vastgesteld', days: 84, resolvedDays: 13,
    title: 'De webshop opent ook zonder beveiligde verbinding', detail: `http://webshop.${D} stuurt niet door naar https.`,
  },
  {
    asset: 'www', check: 'web.software', key: 'web.software_update_achter', certainty: 'mogelijk', days: 21,
    title: 'WordPress 6.8.2 mist beschikbare updates',
    detail: `De website meldt WordPress 6.8.2 (waarschijnlijk) (versienummer achter de WordPress-bestanden). Reeks 6.8 wordt nog ondersteund, maar de nieuwste versie daarin is 6.8.13. Die updates bevatten vaak beveiligingsfixes.`,
    sources: [{ name: 'endoflife.date', url: 'https://endoflife.date/wordpress' }],
  },
  {
    asset: 'shop', check: 'software', key: 'web.server_einde_ondersteuning', certainty: 'vastgesteld', days: 84,
    title: 'De webshop draait op PHP 7.4, dat geen updates meer krijgt',
    detail: `De server van webshop.${D} meldt X-Powered-By: PHP/7.4.33. PHP 7.4 krijgt sinds 28 november 2022 geen beveiligingsupdates meer.`,
    sources: [
      { name: 'php.net: ondersteunde versies', url: 'https://www.php.net/supported-versions.php' },
      { name: 'endoflife.date: PHP', url: 'https://endoflife.date/php' },
    ],
  },
  {
    asset: 'vpn', check: 'software', key: 'netwerkapparaat.kwetsbaarheid', certainty: 'mogelijk', days: 70, cves: ['CVE-2024-21762'],
    title: 'De VPN-toegang is mogelijk kwetsbaar (FortiGate SSL-VPN)',
    detail: `vpn.${D} toont het inlogscherm van een FortiGate SSL-VPN. De precieze versie zien we niet; oudere versies hebben een lek dat actief wordt misbruikt.`,
    sources: [{ name: 'Fortinet PSIRT FG-IR-24-015', url: 'https://www.fortiguard.com/psirt/FG-IR-24-015' }],
  },
  {
    asset: 'admin', check: 'm365', key: 'account.admin_zonder_mfa', certainty: 'vastgesteld', days: 56, resolvedDays: 6,
    title: 'Een beheerdersaccount heeft geen tweestapsverificatie',
    detail: `Het account beheer@${D} is globale beheerder in Microsoft 365 en logde in zonder tweede stap.`,
    sources: [{ name: 'Microsoft: MFA voor beheerders', url: 'https://learn.microsoft.com/entra/identity/authentication/concept-mfa-howitworks' }],
  },
  {
    asset: 'modem', check: 'router', key: 'netwerkapparaat.upnp_aan', certainty: 'vastgesteld', days: 42,
    title: 'UPnP staat aan op de modem', detail: 'Apparaten in het netwerk kunnen zelf poorten naar internet openzetten via de KPN Box.',
  },
  {
    asset: 'modem', check: 'router', key: 'apparaat.beheerpoort_open_naar_internet', certainty: 'vastgesteld', days: 42, resolvedDays: 27,
    title: 'De beheerpagina van de NAS was vanaf internet bereikbaar',
    detail: 'De KPN Box stuurde poort 5001 door naar de Synology NAS. Die regel is inmiddels verwijderd.',
  },
  {
    asset: 'deco', check: 'router', key: 'netwerkapparaat.update_beschikbaar', certainty: 'vastgesteld', days: 42,
    title: 'Er is een firmware-update voor de wifi', detail: 'De Deco X20 draait niet de nieuwste firmware van TP-Link.',
  },
  {
    asset: 'nas', check: 'inventaris', key: 'apparaat.einde_ondersteuning', certainty: 'mogelijk', days: 42,
    title: 'De NAS krijgt mogelijk geen updates meer',
    detail: 'De NAS meldt DSM 6.2. Synology levert voor DSM 6.2 geen beveiligingsupdates meer.',
    sources: [{ name: 'Synology: productondersteuning', url: 'https://www.synology.com/products/status' }],
  },
  {
    asset: 'printer', check: 'inventaris', key: 'apparaat.onbeheerd', certainty: 'onbekend', days: 42,
    title: 'We weten niet wie de printer bijhoudt', detail: 'De printer staat niet in een beheersysteem. Of er updates op komen, kunnen we niet zien.',
  },
];

const VULNS = [{ cve: 'CVE-2024-21762', cvss: 9.8, kev: true }];

/** Wat de voorbeeldwebsites laten zien, zodat het profiel "Software en server" met de echte herkenning wordt gevuld. */
const DEMO_SITES: { asset: string; headers: Record<string, string>; setCookies?: string[]; body: string; tls: string; ok: Record<string, boolean | null> }[] = [
  {
    asset: 'www',
    headers: { server: 'nginx', link: '<https://www.voorbeeldbedrijf.example/wp-json/>; rel="https://api.w.org/"' },
    body: [
      '<link rel="stylesheet" href="/wp-includes/css/dist/block-library/style.min.css?ver=6.8.2">',
      '<script src="/wp-includes/js/wp-emoji-release.min.js?ver=6.8.2"></script>',
      '<script src="/wp-includes/js/jquery/jquery.min.js?ver=3.7.1"></script>',
      '<link rel="stylesheet" href="/wp-content/plugins/woocommerce/assets/css/woocommerce.css?ver=9.8.5">',
      '<script src="/wp-content/plugins/contact-form-7/includes/js/index.js?ver=6.0.6"></script>',
      '<link rel="stylesheet" href="/wp-content/plugins/elementor/assets/css/frontend.min.css?ver=6.8.2">',
      '<link rel="stylesheet" href="/wp-content/themes/astra/style.css?ver=4.11.1">',
    ].join('\n'),
    tls: 'TLSv1.3',
    ok: { https: true, hsts: true, csp: false, framing: true, xcto: true, referrer: true, versies: true, cookies: true, securitytxt: false },
  },
  {
    asset: 'shop',
    headers: { server: 'Apache/2.4.58', 'x-powered-by': 'PHP/7.4.33' },
    setCookies: ['PHPSESSID=demo; Secure; HttpOnly'],
    body: '<script src="https://code.jquery.com/jquery-1.12.4.min.js"></script>',
    tls: 'TLSv1.2',
    ok: { https: true, hsts: false, csp: false, framing: false, xcto: false, referrer: false, versies: false, cookies: true, securitytxt: false },
  },
];

const MAATREGEL_LABELS: Record<string, { label: string; uitleg: string }> = {
  ...MAATREGEL_TEKST,
  ...Object.fromEntries(HEADER_MAATREGELEN.map((m) => [m.key, { label: m.label, uitleg: m.uitleg }])),
};

export function demoWebProfiel(site: (typeof DEMO_SITES)[number], value: string, now: Date): WebProfiel {
  const onderdelen = onderdelenUitAntwoord({ url: `${value}/`, status: 200, headers: site.headers, setCookies: site.setCookies ?? [], body: site.body }, now);
  return {
    versie: 1,
    website: value,
    kennisStand: kennisStand(),
    onderdelen,
    maatregelen: [
      ...Object.entries(site.ok).map(([key, ok]) => ({ key, ...MAATREGEL_LABELS[key]!, ok })),
      { key: 'tls', label: `${MAATREGEL_TEKST.tls!.label} (${site.tls.replace('TLSv', 'TLS ')})`, uitleg: MAATREGEL_TEKST.tls!.uitleg, ok: true },
    ],
    tls: site.tls,
    achterCdn: false,
  };
}

export async function seedDemoData(p: Platform, actor: Actor & { userId: string }, organizationId: string, now = new Date()): Promise<{ assets: number; findings: number }> {
  if (!demoDataAllowed()) throw new PlatformError('geen_toegang', 'Voorbeelddata staat hier uit.');
  await authorize(p.pool, actor.userId, organizationId, 'org:wijzigen');
  const ago = (days: number) => new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

  return withTransaction(p.pool, async (q) => {
    await q.query(`DELETE FROM asset WHERE organization_id = $1 AND source = 'demo'`, [organizationId]);
    await q.query(`DELETE FROM domain WHERE organization_id = $1 AND name = $2`, [organizationId, DEMO_DOMAIN]);

    const dom = await q.query<{ id: string }>(
      `INSERT INTO domain (organization_id, name, verified_at, verification_method, verification_token, created_at)
       VALUES ($1, $2, $3, 'dns-txt', 'demo', $4) RETURNING id`,
      [organizationId, DEMO_DOMAIN, ago(84), ago(85)],
    );
    const domainId = dom.rows[0]!.id;

    const ids = new Map<string, string>();
    for (const a of ASSETS) {
      const r = await q.query<{ id: string }>(
        `INSERT INTO asset (organization_id, domain_id, type, value, source, visibility, exposure, managed, category, first_seen, last_seen)
         VALUES ($1, $2, $3, $4, 'demo', $5, $6, $7, $8, $9, $10) RETURNING id`,
        [organizationId, domainId, a.type, a.value, a.visibility, a.exposure, a.managed ?? 'onbekend', a.category ?? 'onbekend', ago(a.days), ago(1)],
      );
      ids.set(a.key, r.rows[0]!.id);
    }
    const nas = ids.get('nas')!;
    await q.query(`INSERT INTO component (asset_id, kind, vendor, product, version, eol_date) VALUES ($1, 'os', 'Synology', 'DSM', '6.2.4', $2)`, [nas, '2024-10-01']);
    await q.query(`INSERT INTO component (asset_id, kind, vendor, product, version) VALUES ($1, 'firmware', 'TP-Link', 'Deco X20 firmware', '1.1.6')`, [ids.get('deco')!]);
    await q.query(`INSERT INTO component (asset_id, kind, vendor, product, version, eol_date) VALUES ($1, 'software', 'PHP Group', 'PHP', '7.4.33', '2022-11-28')`, [ids.get('shop')!]);

    for (const site of DEMO_SITES) {
      const a = ASSETS.find((x) => x.key === site.asset)!;
      await q.query(
        `INSERT INTO asset_attribute (asset_id, key, value, observed_at, certainty) VALUES ($1, 'web.profiel', $2, $3, 'vastgesteld')`,
        [ids.get(site.asset)!, JSON.stringify(demoWebProfiel(site, a.value, now)), ago(1)],
      );
    }

    for (const v of VULNS) {
      await q.query(`INSERT INTO vuln (cve_id, cvss, in_kev) VALUES ($1, $2, $3) ON CONFLICT (cve_id) DO NOTHING`, [v.cve, v.cvss, v.kev]);
    }
    for (const f of FINDINGS) {
      const assetId = ids.get(f.asset)!;
      const r = await q.query<{ id: string }>(
        `INSERT INTO finding (asset_id, check_key, finding_key, fingerprint, certainty, title, detail, sources, first_seen, last_seen, resolved_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
        [
          assetId, f.check, f.key, `demo:${organizationId}:${f.key}:${f.asset}`, f.certainty, f.title, f.detail,
          JSON.stringify(f.sources ?? []), ago(f.days), f.resolvedDays === undefined ? ago(1) : ago(f.resolvedDays),
          f.resolvedDays === undefined ? null : ago(f.resolvedDays),
        ],
      );
      for (const cve of f.cves ?? []) await q.query('INSERT INTO finding_vuln (finding_id, cve_id) VALUES ($1, $2)', [r.rows[0]!.id, cve]);
    }

    // Wekelijkse bewakingsscans; de laatste met uitkomsten per check voor de dekking.
    let last = '';
    for (const days of [84, 56, 28, 1]) {
      const s = await q.query<{ id: string }>(
        `INSERT INTO scan (domain_id, trigger, status, max_level, scanner_version, created_at, started_at, finished_at)
         VALUES ($1, 'bewaking', 'klaar', 1, 'demo', $2, $2, $3) RETURNING id`,
        [domainId, ago(days), new Date(ago(days).getTime() + 4 * 60 * 1000)],
      );
      last = s.rows[0]!.id;
    }
    const checks: [string, string, string][] = [
      ['domein', 'spf', 'finding'], ['domein', 'dmarc', 'finding'], ['domein', 'dnssec', 'finding'], ['domein', 'caa', 'finding'],
      ['www', 'headers', 'finding'], ['www', 'https', 'ok'], ['www', 'securitytxt', 'finding'], ['cert', 'tls', 'finding'],
      ['shop', 'https', 'ok'], ['shop', 'software', 'finding'], ['shop', 'headers', 'ok'], ['mail', 'starttls', 'ok'],
      ['vpn', 'software', 'finding'], ['oud', 'dns', 'unknown'], ['vpn', 'tls', 'ok'],
    ];
    for (const [asset, check, outcome] of checks) {
      await q.query(`INSERT INTO check_run (scan_id, asset_id, check_key, level, outcome) VALUES ($1, $2, $3, 0, $4)`, [last, ids.get(asset)!, check, outcome]);
    }
    await q.query(
      `INSERT INTO audit_log (organization_id, actor, action, subject, detail, at) VALUES
         ($1, 'demo', 'domein.toegevoegd', $2, $3, $4),
         ($1, 'demo', 'domein.geverifieerd', $2, $3, $5)`,
      [organizationId, domainId, JSON.stringify({ domein: DEMO_DOMAIN }), ago(85), ago(84)],
    );
    return { assets: ASSETS.length, findings: FINDINGS.length };
  });
}
