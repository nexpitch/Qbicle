import { describe, expect, it } from 'vitest';
import { can, mayAssignRole, partnerRole, PERMISSIONS, type Access } from '../src/roles.ts';

const lid = (role: Access['role']): Access => ({ organizationId: 'o', role, via: 'lid' });
const partner = (role: Access['role']): Access => ({ organizationId: 'o', role, via: 'partner', partnerOrgId: 'p' });

describe('rechten per rol', () => {
  it('eigenaar mag alles', () => {
    for (const perm of PERMISSIONS) expect(can(lid('eigenaar'), perm)).toBe(true);
  });

  it('lezer mag alleen kijken', () => {
    const allowed = PERMISSIONS.filter((perm) => can(lid('lezer'), perm));
    expect(allowed.sort()).toEqual(['bevindingen:lezen', 'domeinen:lezen', 'leden:lezen', 'org:lezen']);
  });

  it('beheerder mag geen partners toelaten', () => {
    expect(can(lid('beheerder'), 'partners:beheren')).toBe(false);
    expect(can(lid('beheerder'), 'domeinen:beheren')).toBe(true);
    expect(can(lid('beheerder'), 'scans:starten')).toBe(true);
  });

  it('via een partner nooit partners of klanten beheren', () => {
    expect(can(partner('eigenaar'), 'partners:beheren')).toBe(false);
    expect(can(partner('beheerder'), 'klanten:beheren')).toBe(false);
    expect(can(partner('beheerder'), 'scans:starten')).toBe(true);
  });

  it('elke rol heeft minstens de rechten van de rol eronder', () => {
    for (const perm of PERMISSIONS) {
      if (can(lid('lezer'), perm)) expect(can(lid('beheerder'), perm)).toBe(true);
      if (can(lid('beheerder'), perm)) expect(can(lid('eigenaar'), perm)).toBe(true);
    }
  });
});

describe('partnerrol', () => {
  it('is nooit hoger dan de rol binnen de partner of het toegangsniveau', () => {
    expect(partnerRole('eigenaar', 'beheerder')).toBe('beheerder');
    expect(partnerRole('eigenaar', 'lezer')).toBe('lezer');
    expect(partnerRole('lezer', 'beheerder')).toBe('lezer');
  });
});

describe('rollen toekennen', () => {
  it('nooit hoger dan je eigen rol', () => {
    expect(mayAssignRole(lid('beheerder'), 'beheerder', true)).toBe(true);
    expect(mayAssignRole(lid('beheerder'), 'eigenaar', true)).toBe(false);
    expect(mayAssignRole(lid('lezer'), 'beheerder', true)).toBe(false);
    expect(mayAssignRole(lid('eigenaar'), 'eigenaar', true)).toBe(true);
  });

  it('partner mag de eerste eigenaar van een nieuwe klant uitnodigen, daarna niet meer', () => {
    expect(mayAssignRole(partner('beheerder'), 'eigenaar', false)).toBe(true);
    expect(mayAssignRole(partner('beheerder'), 'eigenaar', true)).toBe(false);
    expect(mayAssignRole(partner('lezer'), 'eigenaar', false)).toBe(false);
    expect(mayAssignRole(lid('beheerder'), 'eigenaar', false)).toBe(false);
  });
});
