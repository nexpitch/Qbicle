import { describe, expect, it } from 'vitest';
import { ACTIONS, WEIGHTS } from '@qbicle/score';
import { korteNaam, oplosGids, ZELF_TE_DOEN, type OplosContext } from '../src/oplossen.ts';

const base: OplosContext = { naam: 'bakkerij.nl', zone: 'bakkerij.nl', dns: null, mail: null, titel: 'Titel' };
const transip = { id: 'transip', naam: 'TransIP', inlog: 'https://www.transip.nl/cp/', stappen: ['Log in.', 'Kies je domein.', 'Open DNS.', 'Kies type TXT…'] };

describe('zo los je het op', () => {
  it('heeft voor elke actie in het scoremodel een uitleg', () => {
    for (const [key, w] of Object.entries(WEIGHTS)) {
      expect(ACTIONS[w.action], w.action).toBeTruthy();
      expect(oplosGids(key, w.action, base), `${key} → ${w.action}`).not.toBeNull();
    }
  });

  it('DMARC begint in de meekijkstand, op het hoofddomein, met korte naam', () => {
    const g = oplosGids('dmarc.missing', 'dmarc-instellen', { ...base, naam: 'shop.bakkerij.nl' })!;
    expect(g.regels).toEqual([{ type: 'TXT', naam: '_dmarc.bakkerij.nl', kort: '_dmarc', waarde: 'v=DMARC1; p=none; rua=mailto:dmarc@bakkerij.nl' }]);
    expect(g.voorwaarde).toBeNull();
    expect(g.waarschuwingen.join(' ')).toMatch(/subdomein/);
  });

  it('DMARC strenger zetten alleen na controle van de rapporten, en eerst quarantine', () => {
    const g = oplosGids('dmarc.p_none', 'dmarc-aanscherpen', base)!;
    expect(g.voorwaarde).toMatch(/rapporten/);
    expect(g.wijzigingen).toEqual([expect.objectContaining({ van: 'p=none', naar: 'p=quarantine' })]);
    expect(JSON.stringify(g)).not.toMatch(/p=reject;/);
  });

  it('SPF alleen kant-en-klaar als we de mailpartij kennen, altijd met ~all', () => {
    const onbekend = oplosGids('spf.missing', 'spf-instellen', base)!;
    expect(onbekend.ingreep).toBe('aanvragen');
    expect(onbekend.regels).toEqual([]);
    const m365 = oplosGids('spf.missing', 'spf-instellen', { ...base, mail: { id: 'microsoft', naam: 'Microsoft 365' } })!;
    expect(m365.regels[0]).toMatchObject({ kort: '@', waarde: 'v=spf1 include:spf.protection.outlook.com ~all' });
  });

  it('dichtzetten (-all, p=reject) alleen na bevestiging dat er geen mail vanaf gaat', () => {
    const spf = oplosGids('spf.missing_no_mail', 'mail-dichtzetten', base)!;
    expect(spf.regels[0]!.waarde).toBe('v=spf1 -all');
    expect(spf.voorwaarde).toMatch(/nooit mail/);
    const www = oplosGids('dmarc.missing_no_mail', 'mail-dichtzetten', { ...base, naam: 'www.bakkerij.nl' })!;
    expect(www.regels[0]).toMatchObject({ naam: '_dmarc.www.bakkerij.nl', kort: '_dmarc.www', waarde: 'v=DMARC1; p=reject;' });
    expect(www.waarschuwingen.join(' ')).toMatch(/CNAME/);
  });

  it('CAA is een voorbeeld met waarschuwing, nooit een blinde waarde', () => {
    const g = oplosGids('caa.missing', 'caa-instellen', base)!;
    expect(g.regels[0]!.voorbeeld).toBe(true);
    expect(g.voorwaarde).toMatch(/mislukken/);
  });

  it('gebruikt de stappen en de inloglink van de DNS-partij als die bekend is', () => {
    const g = oplosGids('dmarc.missing', 'dmarc-instellen', { ...base, dns: transip })!;
    expect(g.inlog).toEqual({ naam: 'TransIP', url: transip.inlog });
    expect(g.stappen.slice(0, 3)).toEqual(['Log in.', 'Kies je domein.', 'Open DNS.']);
    expect(g.stappen[3]).toMatch(/type TXT/);
    expect(g.doorsturen).toMatch(/_dmarc\.bakkerij\.nl/);
  });

  it('security.txt verloopt over een jaar', () => {
    const g = oplosGids('web.securitytxt_missing', 'securitytxt-plaatsen', { ...base, now: new Date('2026-11-27T10:00:00Z') })!;
    expect(g.bestand!.inhoud).toContain('Expires: 2027-11-27T00:00:00Z');
  });

  it('korte naam', () => {
    expect(korteNaam('bakkerij.nl', 'bakkerij.nl')).toBe('@');
    expect(korteNaam('_dmarc.bakkerij.nl', 'bakkerij.nl')).toBe('_dmarc');
    expect(korteNaam('_dmarc.bakkerij.nl', null)).toBe('_dmarc.bakkerij.nl');
    // Zonder bekende zone geldt het domein van het asset als hoofddomein.
    expect(oplosGids('dmarc.missing', 'dmarc-instellen', { ...base, zone: null })!.regels[0]!.kort).toBe('_dmarc');
  });

  it('noemt alleen bestaande acties als zelf te doen', () => {
    for (const k of ZELF_TE_DOEN) expect(ACTIONS[k as keyof typeof ACTIONS], k).toBeDefined();
  });
});
