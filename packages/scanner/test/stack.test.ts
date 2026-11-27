import { describe, expect, it } from 'vitest';
import { softwareCheck, type ProfielOnderdeel } from '../src/checks/software.ts';
import { cyclesFor, parseEndoflifeMarkdown } from '../src/kennis/eol.ts';
import { buildWebProfiles } from '../src/profiel.ts';
import { scanDomain } from '../src/scan.ts';
import { detectStack } from '../src/stack.ts';
import { fakeNet, GOOD_HEADERS, healthyConfig } from './fake-net.ts';
import { NOW, ctxFor, keysOf, website } from './helpers.ts';

const D = 'voorbeeld.nl';
const res = (headers: Record<string, string>, body = '', setCookies: string[] = []) => ({ url: `https://${D}/`, status: 200, headers, setCookies, body });

const WP = [
  '<link rel="stylesheet" href="/wp-includes/css/dist/block-library/style.min.css?ver=6.8.2">',
  '<script src="/wp-includes/js/wp-emoji-release.min.js?ver=6.8.2"></script>',
  '<script src="/wp-includes/js/jquery/jquery.min.js?ver=3.7.1"></script>',
  '<link rel="stylesheet" href="/wp-content/plugins/woocommerce/assets/css/woocommerce.css?ver=9.8.5">',
  '<link rel="stylesheet" href="/wp-content/plugins/elementor/assets/css/frontend.min.css?ver=6.8.2">',
  '<link rel="stylesheet" href="/wp-content/themes/astra/style.css?ver=4.11.1">',
].join('\n');

function site(headers: Record<string, string>, body = '', setCookies: string[] = []) {
  const cfg = healthyConfig(D);
  cfg.http![`https://${D}/`] = { headers, body, setCookies };
  return ctxFor(fakeNet(cfg), D, website(D));
}

const profiel = (out: { evidence?: Record<string, unknown> }) => out.evidence!.profiel as ProfielOnderdeel[];
const deel = (out: { evidence?: Record<string, unknown> }, key: string) => profiel(out).find((o) => o.key === key)!;

describe('kennis van endoflife.date', () => {
  it('leest het releases-blok uit de YAML-kop, met opmerkingen en zonder YAML-bibliotheek', () => {
    const md = [
      '---',
      'title: PHP',
      'releases:',
      '  - releaseCycle: "8.4"',
      '    eol: 2028-12-31 # geschat',
      '    latest: "8.4.15"',
      '',
      '  - releaseCycle: "7.4"',
      '    eol: true',
      '    latest: "7.4.33"',
      '---',
      'Tekst',
    ].join('\n');
    expect(parseEndoflifeMarkdown(md)).toEqual([
      { cycle: '8.4', eol: '2028-12-31', latest: '8.4.15' },
      { cycle: '7.4', eol: true, latest: '7.4.33' },
    ]);
  });

  it('kiest de langste passende reeks, of alle reeksen bij alleen een hoofdversie', () => {
    const c = [{ cycle: '3', eol: false }, { cycle: '3.10', eol: '2023-08-17' }, { cycle: '1.1.1', eol: true }, { cycle: '1.1', eol: true }];
    expect(cyclesFor(c, '3.10.12').map((x) => x.cycle)).toEqual(['3.10']);
    expect(cyclesFor(c, '1.1.1w').map((x) => x.cycle)).toEqual(['1.1.1']);
    expect(cyclesFor([{ cycle: '3.9', eol: true }, { cycle: '3.10', eol: true }], '3').map((x) => x.cycle)).toEqual(['3.9', '3.10']);
  });
});

describe('herkenning uit de pagina (passief)', () => {
  it('WordPress: versie uit ?ver= is waarschijnlijk; plug-ins en thema met eigen versie', () => {
    const s = detectStack(res({}, WP));
    expect(s.find((x) => x.key === 'wordpress')).toMatchObject({ versie: '6.8.2', productZekerheid: 'waarschijnlijk', versieZekerheid: 'waarschijnlijk' });
    expect(s.find((x) => x.key === 'plugin:woocommerce')).toMatchObject({ naam: 'WooCommerce', versie: '9.8.5', versieZekerheid: 'waarschijnlijk' });
    // ?ver= gelijk aan de WordPress-versie zegt niets over de plug-in zelf.
    expect(s.find((x) => x.key === 'plugin:elementor')).toMatchObject({ versie: '', versieZekerheid: 'verborgen' });
    expect(s.find((x) => x.key === 'thema:astra')).toMatchObject({ versie: '4.11.1' });
    expect(s.find((x) => x.key === 'jquery')).toMatchObject({ versie: '3.7.1', categorie: 'js-bibliotheek' });
  });

  it('WordPress via generator-tag of REST-link is zeker', () => {
    const a = detectStack(res({}, '<meta name="generator" content="WordPress 6.2.1" />'));
    expect(a[0]).toMatchObject({ key: 'wordpress', versie: '6.2.1', productZekerheid: 'zeker', versieZekerheid: 'zeker' });
    const b = detectStack(res({ link: '<https://x/wp-json/>; rel="https://api.w.org/"' }));
    expect(b[0]).toMatchObject({ key: 'wordpress', versie: '', productZekerheid: 'zeker', versieZekerheid: 'verborgen' });
  });

  it('Drupal, Joomla, TYPO3, Magento en beheerde platforms', () => {
    expect(detectStack(res({ 'x-generator': 'Drupal 10 (https://www.drupal.org)' }))[0]).toMatchObject({ key: 'drupal', versie: '10', versieZekerheid: 'zeker' });
    expect(detectStack(res({}, '<script src="/misc/drupal.js?v=7.98"></script>'))[0]).toMatchObject({ key: 'drupal', versie: '7', versieZekerheid: 'waarschijnlijk' });
    expect(detectStack(res({}, '<meta name="generator" content="Joomla! - Open Source Content Management" /><script src="/media/jui/js/jquery.min.js"></script>'))[0])
      .toMatchObject({ key: 'joomla', versie: '3', productZekerheid: 'zeker', versieZekerheid: 'waarschijnlijk' });
    expect(detectStack(res({}, '<meta name="generator" content="TYPO3 CMS" />'))[0]).toMatchObject({ key: 'typo3', versieZekerheid: 'verborgen' });
    expect(detectStack(res({}, '<link href="/skin/frontend/default/x.css">'))[0]).toMatchObject({ key: 'magento', versie: '1' });
    expect(detectStack(res({ 'x-shopid': '123' }))[0]).toMatchObject({ key: 'shopify', categorie: 'platform' });
  });

  it('server, taal en besturingssysteem zonder versie, en CDN', () => {
    const s = detectStack(res({ server: 'nginx' }, '', ['PHPSESSID=1; Secure']));
    expect(s.map((x) => [x.key, x.versieZekerheid])).toEqual([['nginx', 'verborgen'], ['php', 'verborgen']]);
    expect(detectStack(res({ server: 'cloudflare', 'cf-ray': 'x' }))).toHaveLength(1);
    expect(detectStack(res({ server: 'Apache/2.4.6 (CentOS) PHP/5.4.16' })).find((x) => x.categorie === 'besturingssysteem')).toMatchObject({ key: 'centos', versie: '7' });
    expect(detectStack(res({ server: 'Apache/2.4.57 (CentOS Stream)' })).find((x) => x.categorie === 'besturingssysteem')).toMatchObject({ key: 'centos-stream', versie: '' });
  });

  it('vraagt niets extra op: alleen de voorpagina', async () => {
    const cfg = healthyConfig(D);
    cfg.http![`https://${D}/`] = { headers: {}, body: WP };
    const net = fakeNet(cfg);
    await softwareCheck.run(ctxFor(net, D, website(D)));
    expect(net.requests).toEqual([`get:https://${D}/`]);
  });
});

describe('beoordeling en bevindingen', () => {
  it('WordPress achter in een ondersteunde reeks: update_achter, mogelijk (versie afgeleid), voor de webbouwer', async () => {
    const { keys, out } = await keysOf(softwareCheck, site({}, WP));
    expect(keys).toEqual(['web.software_update_achter']);
    expect(out.findings![0]!.certainty).toBe('mogelijk');
    const wp = deel(out, 'wordpress');
    expect(wp).toMatchObject({ status: 'achter', wie: 'webbouwer', laatsteInReeks: '6.8.13' });
    expect(wp.uitleg).toContain('WordPress 6.8.2 (waarschijnlijk)');
    expect(wp.bronnen.map((b) => b.url)).toContain('https://endoflife.date/wordpress');
    // jQuery 3.7.1: geen bevinding, wel zichtbaar dat er een nieuwere versie is.
    expect(deel(out, 'jquery').status).toBe('achter');
  });

  it('jQuery 1.12: oude bibliotheek (licht) en bekend lek met voorwaarde (mogelijk)', async () => {
    const { keys, out } = await keysOf(softwareCheck, site({}, '<script src="https://code.jquery.com/jquery-1.12.4.min.js"></script>'));
    expect(keys).toEqual(['web.bibliotheek_einde', 'web.software_kwetsbaar']);
    expect(out.findings!.find((f) => f.key === 'web.software_kwetsbaar')!.certainty).toBe('mogelijk');
    expect(deel(out, 'jquery').lekken.map((l) => l.cveId).sort()).toEqual(['CVE-2020-11022', 'CVE-2020-11023']);
  });

  it('Joomla 3 en Drupal 7: einde ondersteuning, mogelijk omdat de versie is afgeleid', async () => {
    const j = await keysOf(softwareCheck, site({}, '<meta name="generator" content="Joomla! - Open Source Content Management" /><script src="/media/jui/js/x.js"></script>'));
    expect(j.keys).toEqual(['web.software_einde_ondersteuning']);
    expect(j.out.findings![0]!.certainty).toBe('mogelijk');
    const d = await keysOf(softwareCheck, site({}, '<script src="/misc/drupal.js"></script>'));
    expect(deel(d.out, 'drupal')).toMatchObject({ status: 'einde', reeks: '7' });
  });

  it('Drupal 10 stopt binnenkort (laatste reeks 10.6 tot 9 december 2026)', async () => {
    const { keys, out } = await keysOf(softwareCheck, site({ 'x-generator': 'Drupal 10 (https://www.drupal.org)' }));
    expect(keys).toEqual(['web.software_einde_binnenkort']);
    expect(deel(out, 'drupal')).toMatchObject({ status: 'binnenkort', ondersteundTot: '2026-12-09' });
  });

  it('PHP achter zonder distributie: server_update_achter voor de hostingpartij', async () => {
    const { keys, out } = await keysOf(softwareCheck, site({ 'x-powered-by': 'PHP/8.4.1' }));
    expect(keys).toEqual(['web.server_update_achter']);
    expect(deel(out, 'php')).toMatchObject({ wie: 'hosting', status: 'achter' });
  });

  it('CentOS Linux: besturingssysteem zonder updates, mogelijk', async () => {
    const { out } = await keysOf(softwareCheck, site({ server: 'Apache/2.4.6 (CentOS)' }));
    const f = out.findings!.find((x) => x.discriminator === 'centos')!;
    expect(f).toMatchObject({ key: 'web.server_einde_ondersteuning', certainty: 'mogelijk' });
    // Apache van de distributie: wel getoond, geen bevinding op het versienummer.
    expect(out.findings!.some((x) => x.discriminator === 'apache-httpd')).toBe(false);
  });

  it('Red Hat in de Server-header geldt ook voor PHP zonder eigen distributietekst; Ubuntu niet', async () => {
    const rh = await keysOf(softwareCheck, site({ server: 'Apache/2.4.37 (Red Hat Enterprise Linux)', 'x-powered-by': 'PHP/7.2.24' }));
    expect(rh.keys).toEqual(['web.server_einde_distro']);
    expect(deel(rh.out, 'php')).toMatchObject({ status: 'einde', distributie: 'Red Hat-achtige Linux' });
    const ub = await keysOf(softwareCheck, site({ server: 'Apache/2.4.41 (Ubuntu)', 'x-powered-by': 'PHP/7.4.33' }));
    expect(ub.keys).toContain('web.server_einde_ondersteuning');
  });

  it('Shopify: bijgewerkt door de leverancier, geen bevindingen', async () => {
    const { outcome, keys, out } = await keysOf(softwareCheck, site({ 'x-shopid': '1' }, '<script src="https://cdn.shopify.com/s/x.js"></script>'));
    expect(outcome).toBe('ok');
    expect(keys).toEqual([]);
    expect(deel(out, 'shopify')).toMatchObject({ status: 'beheerd', wie: 'leverancier' });
  });
});

describe('profiel per website', () => {
  it('software plus maatregelen uit de andere checks, zonder extra verzoeken', async () => {
    const cfg = healthyConfig(D);
    cfg.http![`https://${D}/`] = { headers: { ...GOOD_HEADERS, server: 'nginx' }, body: WP };
    const r = await scanDomain(D, { net: fakeNet(cfg), now: NOW });
    const [p] = buildWebProfiles(r.checks).filter((x) => x.website === `https://${D}`);
    expect(p!.kennisStand).toBe('2026-11-27');
    expect(p!.onderdelen.map((o) => o.key)).toContain('wordpress');
    expect(Object.fromEntries(p!.maatregelen.map((m) => [m.key, m.ok]))).toMatchObject({ https: true, hsts: true, csp: true, versies: true });
    expect(r.findings.some((f) => f.key === 'web.software_update_achter')).toBe(true);
  });
});
