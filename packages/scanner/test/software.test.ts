import { describe, expect, it } from 'vitest';
import { softwareCheck } from '../src/checks/software.ts';
import { cookiesCheck, headersCheck, isSessionCookie, securityTxtCheck } from '../src/checks/web.ts';
import { assessEol, detectSoftware, normalizeVersion } from '../src/software.ts';
import { fakeNet, healthyConfig } from './fake-net.ts';
import { NOW, ctxFor, keysOf, website } from './helpers.ts';

const D = 'voorbeeld.nl';
const res = (headers: Record<string, string>, body = '') => ({ url: `https://${D}/`, status: 200, headers, setCookies: [], body });

describe('softwareherkenning', () => {
  it('leest meerdere producten uit één Server-header, met distributie', () => {
    const sw = detectSoftware(res({ server: 'Apache/2.4.41 (Ubuntu) OpenSSL/1.1.1f', 'x-powered-by': 'PHP/7.4.3-4ubuntu2.18' }));
    expect(sw.map((s) => [s.product?.key, s.version, s.backportDistro])).toEqual([
      ['apache-httpd', '2.4.41', 'Ubuntu'],
      ['openssl', '1.1.1f', 'Ubuntu'],
      ['php', '7.4.3', 'Ubuntu'],
    ]);
  });

  it('herkent Red Hat aan -fips en .el', () => {
    expect(detectSoftware(res({ server: 'Apache/2.4.6 OpenSSL/1.0.2k-fips' }))[1]!.backportDistro).toBe('Red Hat-achtige Linux');
    expect(normalizeVersion('1.0.2k-fips')).toBe('1.0.2k');
  });

  it('einde ondersteuning per reeks', () => {
    const at = (server: string) => assessEol(detectSoftware(res({ server }))[0]!, NOW);
    expect(at('PHP/7.4.33')).toMatchObject({ status: 'einde', cycle: '7.4' });
    expect(at('PHP/8.2.10')).toMatchObject({ status: 'binnenkort', cycle: '8.2' });
    expect(at('PHP/8.3.1')).toMatchObject({ status: 'ondersteund' });
    expect(at('Microsoft-IIS/8.5')).toMatchObject({ status: 'einde' });
    expect(at('Microsoft-IIS/10.0')).toMatchObject({ status: 'ondersteund' });
    expect(at('nginx/1.18.0')).toMatchObject({ status: 'einde', cycle: '1.18' });
    expect(at('nginx/1.27.3')).toBeNull();
    expect(at('OpenSSL/1.1.1w')).toMatchObject({ status: 'einde', cycle: '1.1.1' });
    expect(at('Apache/2.2.15')).toMatchObject({ status: 'einde' });
  });
});

function siteWith(headers: Record<string, string>) {
  const cfg = healthyConfig(D);
  cfg.http![`https://${D}/`] = { headers };
  return ctxFor(fakeNet(cfg), D, website(D));
}

describe('softwarecheck', () => {
  it('Apache 2.4.49: actief misbruikt lek, vastgesteld, met bronnen', async () => {
    const { keys, out } = await keysOf(softwareCheck, siteWith({ server: 'Apache/2.4.49 (Unix)' }));
    expect(keys).toEqual(['web.software_kwetsbaar']);
    const f = out.findings![0]!;
    expect(f.certainty).toBe('vastgesteld');
    expect(f.vulns!.map((v) => v.cveId).sort()).toEqual(['CVE-2021-41773', 'CVE-2021-42013']);
    expect(f.vulns!.every((v) => v.inKev)).toBe(true);
    expect(f.sources!.map((s) => s.url)).toContain('https://nvd.nist.gov/vuln/detail/CVE-2021-41773');
    expect(f.sources!.map((s) => s.name)).toContain('CISA KEV');
  });

  it('zelfde versie onder Ubuntu: hooguit mogelijk', async () => {
    const { out } = await keysOf(softwareCheck, siteWith({ server: 'Apache/2.4.49 (Ubuntu)' }));
    expect(out.findings![0]!.certainty).toBe('mogelijk');
  });

  it('lek met voorwaarde (PHP-CGI op Windows) is mogelijk', async () => {
    const { keys, out } = await keysOf(softwareCheck, siteWith({ 'x-powered-by': 'PHP/8.3.4' }));
    expect(keys).toEqual(['web.software_kwetsbaar']);
    expect(out.findings![0]!.certainty).toBe('mogelijk');
  });

  it('PHP 7.4 zonder distributie: einde ondersteuning, vastgesteld, met bron', async () => {
    const { keys, out } = await keysOf(softwareCheck, siteWith({ 'x-powered-by': 'PHP/7.4.33' }));
    expect(keys).toEqual(['web.software_einde_ondersteuning']);
    expect(out.findings![0]!.certainty).toBe('vastgesteld');
    expect(out.findings![0]!.sources![0]!.url).toContain('php.net');
  });

  it('geen versies zichtbaar: niet van toepassing, telt niet als onbekend', async () => {
    const { outcome } = await keysOf(softwareCheck, siteWith({ server: 'nginx' }));
    expect(outcome).toBe('not_applicable');
  });

  it('kijkt niet naar een foutpagina', async () => {
    const cfg = healthyConfig(D);
    cfg.http![`https://${D}/`] = { status: 403, headers: { server: 'Apache/2.4.49' } };
    const { outcome } = await keysOf(softwareCheck, ctxFor(fakeNet(cfg), D, website(D)));
    expect(outcome).toBe('unknown');
  });
});

describe('cookies, cookiemuur en security.txt', () => {
  it('HttpOnly alleen bij sessie- en inlogcookies', async () => {
    expect(['PHPSESSID', 'laravel_session', 'auth_token', 'sid', 'JSESSIONID'].every(isSessionCookie)).toBe(true);
    expect(['_ga', 'CookieConsent', 'OptanonConsent', 'NID', 'consentUUID', 'side_menu'].some(isSessionCookie)).toBe(false);
    const cfg = healthyConfig(D);
    cfg.http![`https://${D}/`] = { headers: {}, setCookies: ['_ga=1; Secure', 'CookieConsent=1; Secure', 'PHPSESSID=1; Secure'] };
    const { out } = await keysOf(cookiesCheck, ctxFor(fakeNet(cfg), D, website(D)));
    const f = out.findings!.find((x) => x.key === 'web.cookie_no_httponly')!;
    expect(f.detail).toContain('PHPSESSID');
    expect(f.detail).not.toContain('_ga');
  });

  it('cookiemuur op een ander domein: headers onbekend, niet n.v.t.', async () => {
    const cfg = healthyConfig(D);
    cfg.http![`https://${D}/`] = { status: 302, headers: { location: `https://myprivacy.uitgever.nl/consent?redirectUri=https://${D}/` } };
    const { outcome, out } = await keysOf(headersCheck, ctxFor(fakeNet(cfg), D, website(D)));
    expect(outcome).toBe('unknown');
    expect(out.message).toContain('toestemmingspagina');
  });

  it('doorverwijzing naar een ander bedrijfsdomein blijft n.v.t.', async () => {
    const cfg = healthyConfig(D);
    cfg.http![`https://${D}/`] = { status: 301, headers: { location: 'https://voorbeeldgroep.com/' } };
    const { outcome } = await keysOf(headersCheck, ctxFor(fakeNet(cfg), D, website(D)));
    expect(outcome).toBe('not_applicable');
  });

  it('security.txt die doorverwijst naar een geldige security.txt elders is in orde', async () => {
    const cfg = healthyConfig(D);
    cfg.http![`https://${D}/.well-known/security.txt`] = { status: 301, headers: { location: 'https://www.ncsc.nl/.well-known/security.txt' } };
    cfg.http!['https://www.ncsc.nl/.well-known/security.txt'] = {
      headers: { 'content-type': 'text/plain' },
      body: 'Contact: https://www.ncsc.nl/contact\nExpires: 2027-06-01T00:00:00Z\n',
    };
    const { outcome } = await keysOf(securityTxtCheck, ctxFor(fakeNet(cfg), D, website(D)));
    expect(outcome).toBe('ok');
  });
});
