import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  changeMemberRole,
  createOrganization,
  getBillingDetails,
  inviteMember,
  listContacts,
  removeContact,
  setContact,
  startSubscription,
  updateBillingDetails,
} from '../src/index.ts';
import { createTestPlatform, hasDb, type TestPlatform } from './support/db.ts';
import { loginAs } from './support/users.ts';

type U = Awaited<ReturnType<typeof loginAs>>;

describe.skipIf(!hasDb)('klantaccount: gegevens, contactpersonen, gebruikerslimiet', () => {
  let p: TestPlatform;
  let eigenaar: U;
  let lezer: U;
  let org: string;

  beforeAll(async () => {
    p = await createTestPlatform();
    eigenaar = await loginAs(p, 'piet@installatie.nl');
    lezer = await loginAs(p, 'lezer@installatie.nl');
    org = (await createOrganization(p, eigenaar, { name: 'Installatiebedrijf Piet', kind: 'klant' })).id;
    await p.pool.query(`INSERT INTO membership (organization_id, user_id, role) VALUES ($1, $2, 'lezer')`, [org, lezer.userId]);
  });
  afterAll(async () => p?.close());

  it('referentie komt in de factuurgegevens', async () => {
    await updateBillingDetails(p, eigenaar, org, { naam: 'Piet Installatie B.V.', referentie: ' PO-2026-118 ', kvk: '12345678' });
    const d = await getBillingDetails(p, eigenaar.userId, org);
    expect(d).toMatchObject({ naam: 'Piet Installatie B.V.', referentie: 'PO-2026-118', kvk: '12345678' });
  });

  it('contactpersonen: één per soort, overschrijven, weghalen, met rechten', async () => {
    await setContact(p, eigenaar, org, 'security', { naam: 'Kees de Vries', telefoon: '06 12345678' });
    await setContact(p, eigenaar, org, 'financieel', { naam: 'Anna', email: 'Administratie@Installatie.nl' });
    await setContact(p, eigenaar, org, 'security', { naam: 'Kees de Vries', email: 'kees@installatie.nl', telefoon: '+31 6 12345678' });
    const list = await listContacts(p, lezer.userId, org);
    expect(list.map((c) => c.kind)).toEqual(['financieel', 'security']);
    expect(list[0]!.email).toBe('administratie@installatie.nl');
    expect(list[1]).toMatchObject({ email: 'kees@installatie.nl', phone: '+31 6 12345678' });

    await expect(setContact(p, lezer, org, 'algemeen', { naam: 'X', email: 'x@x.nl' })).rejects.toMatchObject({ code: 'geen_toegang' });
    await expect(setContact(p, eigenaar, org, 'algemeen', { naam: 'Zonder bereik' })).rejects.toMatchObject({ code: 'ongeldige_invoer' });
    await expect(setContact(p, eigenaar, org, 'algemeen', { naam: 'Y', telefoon: 'bel me' })).rejects.toMatchObject({ code: 'ongeldige_invoer' });
    await expect(setContact(p, eigenaar, org, 'baas', { naam: 'Y', email: 'y@y.nl' })).rejects.toMatchObject({ code: 'niet_gevonden' });

    await removeContact(p, eigenaar, org, 'financieel');
    expect((await listContacts(p, eigenaar.userId, org)).map((c) => c.kind)).toEqual(['security']);
  });

  it('het pakket begrenst het aantal gebruikers, uitnodigingen tellen mee', async () => {
    await startSubscription(p, eigenaar, org, { plan: 'mkb', interval: 'jaar' }); // 5 gebruikers
    // Nu 2 leden; 3 uitnodigingen passen, de 4e niet.
    for (const n of [1, 2, 3]) await inviteMember(p, eigenaar, org, { email: `collega${n}@installatie.nl`, role: 'lezer' });
    await expect(inviteMember(p, eigenaar, org, { email: 'collega4@installatie.nl', role: 'lezer' })).rejects.toThrow(/ruimte voor 5 gebruikers/);
    // Opnieuw uitnodigen van hetzelfde adres vervangt de oude en mag dus wel.
    await inviteMember(p, eigenaar, org, { email: 'collega3@installatie.nl', role: 'beheerder' });
    // Upgraden geeft ruimte.
    await startSubscription(p, eigenaar, org, { plan: 'business', interval: 'jaar' });
    await inviteMember(p, eigenaar, org, { email: 'collega4@installatie.nl', role: 'lezer' });
  });

  it('rol wijzigen blijft werken zoals voorheen', async () => {
    await changeMemberRole(p, eigenaar, org, lezer.userId, 'beheerder');
    await expect(changeMemberRole(p, lezer, org, eigenaar.userId, 'lezer')).rejects.toMatchObject({ code: 'geen_toegang' });
  });
});
