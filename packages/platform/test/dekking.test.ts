import { describe, expect, it } from 'vitest';
import { ASSET_GROUPS, dekkingVoor, mailDienstVoor, type Dashboard } from '../src/index.ts';

type D = Pick<Dashboard, 'groups' | 'assets' | 'lastScanAt'>;

function dash(assets: { type: string; group: string; label: string }[], scanned = true): D {
  return {
    lastScanAt: scanned ? new Date() : null,
    assets: assets.map((a, i) => ({ id: String(i), typeLabel: a.type, level: 'ok', openFindings: 0, exposure: 'internet', lastSeen: new Date(), firstSeen: new Date(), ...a })) as D['assets'],
    groups: ASSET_GROUPS.map((g) => ({ key: g.key, label: g.label, uitleg: g.uitleg, count: assets.filter((a) => a.group === g.key).length, withIssues: 0, level: 'ok' as const })),
  };
}

describe('eerlijke dekking per onderdeel', () => {
  it('herkent de maildienst aan de MX', () => {
    expect(mailDienstVoor(['aspmx.l.google.com.', 'alt1.aspmx.l.google.com'])?.id).toBe('google-workspace');
    expect(mailDienstVoor(['bedrijf-nl.mail.protection.outlook.com'])?.id).toBe('microsoft365');
    expect(mailDienstVoor(['mx.transip.email'])?.id).toBe('anders');
    expect(mailDienstVoor([])).toBeNull();
  });

  it('zonder scan is niets gecontroleerd', () => {
    const r = dekkingVoor(dash([], false), [], '/o/x');
    expect(r.volledig).toBe(0);
    expect(r.onderdelen.every((o) => o.dekking === 'niet')).toBe(true);
    expect(r.onvolledig).toBe(true);
  });

  it('Google-mail met alleen DNS bekeken is gedeeltelijk, met de Google-koppeling als actie', () => {
    const d = dash([
      { type: 'domein', group: 'domeinen', label: 'nexpitch.com' },
      { type: 'mailserver', group: 'mail', label: 'aspmx.l.google.com' },
    ]);
    const r = dekkingVoor(d, [], '/o/x');
    const mail = r.onderdelen.find((o) => o.key === 'mail')!;
    expect(mail.dekking).toBe('deels');
    expect(mail.nietGekeken).toMatch(/Google Workspace/);
    expect(mail.actie).toEqual({ label: 'Koppel Google Workspace', href: '/o/x/koppelingen/google-workspace' });
    // Geen servers gevonden betekent niet "in orde": niet gecontroleerd, met uitnodiging.
    const servers = r.onderdelen.find((o) => o.key === 'servers')!;
    expect(servers.dekking).toBe('niet');
    expect(servers.actie?.label).toBe('Server toevoegen');
    expect(r.mailDienst?.naam).toBe('Google Workspace');
    expect(r.volledig).toBe(2); // domeinen en websites
    expect(r.onvolledig).toBe(true);
  });

  it('servers van buiten: claimt geen poortcontrole die de scanner niet doet', () => {
    const d = dash([
      { type: 'domein', group: 'domeinen', label: 'nexpitch.com' },
      { type: 'host', group: 'servers', label: 'vpn.nexpitch.com' },
    ]);
    const servers = dekkingVoor(d, [], '/o/x').onderdelen.find((o) => o.key === 'servers')!;
    expect(servers.dekking).toBe('deels');
    expect(servers.gekeken).not.toMatch(/welke poorten open staan/);
    expect(servers.nietGekeken).toMatch(/andere poorten open staan/);
    expect(servers.actie).toEqual({ label: 'Router koppelen', href: '/o/x/koppelingen' });
  });

  it('met de koppeling wordt mail volledig gecontroleerd', () => {
    const d = dash([{ type: 'mailserver', group: 'mail', label: 'aspmx.l.google.com' }]);
    const r = dekkingVoor(d, ['google-workspace'], '/o/x');
    expect(r.onderdelen.find((o) => o.key === 'mail')!.dekking).toBe('volledig');
    expect(r.onderdelen.find((o) => o.key === 'cloud')!.dekking).toBe('volledig');
  });
});
