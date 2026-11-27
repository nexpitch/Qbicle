import { describe, expect, it } from 'vitest';
import { inPakket, KOPPELINGEN, KoppelingenTeststand, VERBODEN_RECHTEN, vindKoppeling } from '../src/index.ts';

describe('catalogus', () => {
  it('vraagt nooit rechten die inhoud lezen of iets wijzigen', () => {
    for (const k of KOPPELINGEN) {
      for (const r of k.rechten) {
        for (const re of VERBODEN_RECHTEN) expect(re.test(r.naam), `${k.id}: ${r.naam}`).toBe(false);
      }
    }
  });

  it('elke koppeling legt uit wat we zien, niet zien, het stappenplan en hoe je intrekt', () => {
    for (const k of KOPPELINGEN) {
      expect(k.zien.length, k.id).toBeGreaterThan(0);
      expect(k.nietZien.length, k.id).toBeGreaterThan(0);
      expect(k.rechten.length, k.id).toBeGreaterThan(0);
      expect(k.stappen.length, k.id).toBeGreaterThan(1);
      expect(k.intrekkenBijDienst, k.id).not.toBe('');
    }
    expect(new Set(KOPPELINGEN.map((k) => k.id)).size).toBe(KOPPELINGEN.length);
  });

  it('Business-koppelingen alleen in Business', () => {
    expect(inPakket(vindKoppeling('microsoft365')!, 'mkb')).toBe(true);
    expect(inPakket(vindKoppeling('aws')!, 'mkb')).toBe(false);
    expect(inPakket(vindKoppeling('aws')!, 'business')).toBe(true);
  });
});

describe('teststand', () => {
  let nu = new Date('2026-11-27T10:00:00Z');
  const t = new KoppelingenTeststand(() => nu);
  const org = 'org-1';

  it('route: starten, deellink, toestemming, intrekken', () => {
    expect(t.get(org, 'microsoft365').status).toBe('niet_gekoppeld');
    expect(t.starten(org, 'microsoft365', 'mkb', 'a@b.nl').status).toBe('wacht_op_it');

    const link = t.deelLink(org, 'microsoft365', 'a@b.nl');
    expect(link.token).toMatch(/^qbk_/);
    const open = t.openDeelLink(link.token);
    expect(open.koppeling.id).toBe('microsoft365');
    expect(JSON.stringify(open)).not.toContain(org);

    const s = t.testToestemming(org, 'microsoft365', 'gelukt');
    expect(s.status).toBe('actief');
    expect(s.verleendeRechten).toContain('User.Read.All');
    expect(s.bevindingen.length).toBeGreaterThan(0);

    const weg = t.intrekken(org, 'microsoft365', 'a@b.nl');
    expect(weg.status).toBe('ingetrokken');
    expect(weg.verleendeRechten).toEqual([]);
    expect(weg.logboek[0]!.tekst).toContain('Sleutels en tokens gewist');
    expect(() => t.openDeelLink(link.token)).toThrow(/bestaat niet/);
  });

  it('te veel rechten geeft een waarschuwing; mislukt geeft fout', () => {
    t.starten(org, 'aws', 'business', 'a@b.nl');
    expect(t.testToestemming(org, 'aws', 'mislukt').status).toBe('fout');
    const s = t.testToestemming(org, 'aws', 'te_veel_rechten');
    expect(s.status).toBe('let_op');
    expect(s.verleendeRechten).toContain('AdministratorAccess');
  });

  it('weigert binnenkort, buiten pakket, verkeerde volgorde en verlopen links', () => {
    expect(() => t.starten(org, 'azure', 'business', 'x')).toThrow(/binnenkort/);
    expect(() => t.starten(org, 'unifi', 'mkb', 'x')).toThrow(/Business/);
    expect(() => t.testToestemming(org, 'meraki', 'gelukt')).toThrow(/Start eerst/);
    expect(() => t.starten(org, 'bestaat-niet', 'mkb', 'x')).toThrow(/bestaat niet/);
    t.starten(org, 'connector', 'business', 'x');
    const link = t.deelLink(org, 'connector', 'x');
    nu = new Date(nu.getTime() + 8 * 86_400_000);
    expect(() => t.openDeelLink(link.token)).toThrow(/verlopen/);
    expect(() => t.openDeelLink('qbk_onzin')).toThrow(/bestaat niet/);
  });

  it('organisaties zien elkaars koppelingen niet', () => {
    expect(t.lijst('org-2')).toEqual([]);
    expect(t.interesse('org-2', 'azure').interesse).toBe(true);
    expect(t.get(org, 'azure').interesse).toBe(false);
  });
});
