import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  acceptInvitation,
  addDomain,
  createClientForPartner,
  createOrganization,
  extractToken,
  getOrganization,
  grantPartnerAccess,
  inviteMember,
  listClients,
  listOrganizationsForUser,
  listPartners,
  revokePartnerAccess,
} from '../src/index.ts';
import { createTestPlatform, hasDb, type TestPlatform } from './support/db.ts';
import { loginAs } from './support/users.ts';

type U = Awaited<ReturnType<typeof loginAs>>;

describe.skipIf(!hasDb)('IT-partners met meerdere klanten', () => {
  let p: TestPlatform;
  let msp: string;
  let sanne: U; // eigenaar van de IT-partner
  let tom: U; // lezer bij de IT-partner
  let anna: U; // eigenaar van een bestaande klant
  let bakkerij: string;

  beforeAll(async () => {
    p = await createTestPlatform();
    sanne = await loginAs(p, 'sanne@itpartner.nl');
    tom = await loginAs(p, 'tom@itpartner.nl');
    anna = await loginAs(p, 'anna@bakkerij.nl');
    msp = (await createOrganization(p, sanne, { name: 'IT Partner Zuid', kind: 'it-partner' })).id;
    await inviteMember(p, sanne, msp, { email: 'tom@itpartner.nl', role: 'lezer' });
    await acceptInvitation(p, tom, extractToken(p.mailer.last('tom@itpartner.nl')!.text, 'qbu_')!);
    bakkerij = (await createOrganization(p, anna, { name: 'Bakkerij', kind: 'klant' })).id;
  });
  afterAll(async () => p?.close());

  it('partner maakt een klant aan en beheert die', async () => {
    const klant = await createClientForPartner(p, sanne, msp, { name: 'Tandarts Smit' });
    const org = await getOrganization(p, sanne.userId, klant.id);
    expect(org.access).toMatchObject({ role: 'beheerder', via: 'partner', partnerOrgId: msp });
    await addDomain(p, sanne, klant.id, { name: 'tandartssmit.nl' });

    // Een lezer bij de partner is ook bij de klant alleen lezer.
    const forTom = await getOrganization(p, tom.userId, klant.id);
    expect(forTom.access.role).toBe('lezer');
    await expect(addDomain(p, tom, klant.id, { name: 'ander.nl' })).rejects.toMatchObject({ code: 'geen_toegang' });

    // De partner nodigt de eerste eigenaar uit; daarna kan dat niet nog eens.
    await inviteMember(p, sanne, klant.id, { email: 'dr@tandartssmit.nl', role: 'eigenaar' });
    const dr = await loginAs(p, 'dr@tandartssmit.nl');
    await acceptInvitation(p, dr, extractToken(p.mailer.sent.filter((m) => m.to === 'dr@tandartssmit.nl')[0]!.text, 'qbu_')!);
    await expect(inviteMember(p, sanne, klant.id, { email: 'nog1@tandartssmit.nl', role: 'eigenaar' })).rejects.toMatchObject({
      code: 'geen_toegang',
    });

    // De klant kan de partner eruit zetten.
    await revokePartnerAccess(p, dr, klant.id, msp);
    await expect(getOrganization(p, sanne.userId, klant.id)).rejects.toMatchObject({ code: 'niet_gevonden' });
  });

  it('alleen een IT-partner of adviseur kan klanten aanmaken', async () => {
    await expect(createClientForPartner(p, anna, bakkerij, { name: 'X' })).rejects.toMatchObject({ code: 'ongeldige_invoer' });
    await expect(createClientForPartner(p, tom, msp, { name: 'X' })).rejects.toMatchObject({ code: 'geen_toegang' });
  });

  it('bestaande klant geeft een partner leestoegang', async () => {
    const link = await grantPartnerAccess(p, anna, bakkerij, { partnerOrgId: msp, access: 'lezer' });
    expect(link).toMatchObject({ partnerName: 'IT Partner Zuid', clientName: 'Bakkerij', access: 'lezer' });
    expect((await getOrganization(p, sanne.userId, bakkerij)).access.role).toBe('lezer');
    await expect(addDomain(p, sanne, bakkerij, { name: 'bakkerij.nl' })).rejects.toMatchObject({ code: 'geen_toegang' });

    const clients = await listClients(p, sanne.userId, msp);
    expect(clients.map((c) => c.clientName)).toEqual(['Bakkerij']);
    const partners = await listPartners(p, anna.userId, bakkerij);
    expect(partners.map((c) => c.partnerName)).toEqual(['IT Partner Zuid']);
  });

  it('opwaarderen naar beheerder vervangt de oude toegang', async () => {
    await grantPartnerAccess(p, anna, bakkerij, { partnerOrgId: msp, access: 'beheerder' });
    expect((await getOrganization(p, sanne.userId, bakkerij)).access.role).toBe('beheerder');
    expect(await listPartners(p, anna.userId, bakkerij)).toHaveLength(1);
  });

  it('een partner kan zichzelf geen extra rechten geven of andere partners toelaten', async () => {
    const other = (await createOrganization(p, sanne, { name: 'Ander MSP', kind: 'it-partner' })).id;
    await expect(grantPartnerAccess(p, sanne, bakkerij, { partnerOrgId: other, access: 'beheerder' })).rejects.toMatchObject({
      code: 'geen_toegang',
    });
    await expect(inviteMember(p, sanne, bakkerij, { email: 'sanne2@itpartner.nl', role: 'eigenaar' })).rejects.toMatchObject({
      code: 'geen_toegang',
    });
  });

  it('een gewone klant kan geen partner zijn', async () => {
    const tweede = (await createOrganization(p, anna, { name: 'Tweede zaak', kind: 'klant' })).id;
    await expect(grantPartnerAccess(p, anna, tweede, { partnerOrgId: bakkerij, access: 'lezer' })).rejects.toMatchObject({
      code: 'ongeldige_invoer',
    });
  });

  it('de partner kan zelf de samenwerking beëindigen', async () => {
    await revokePartnerAccess(p, sanne, bakkerij, msp);
    const list = await listOrganizationsForUser(p, sanne.userId);
    expect(list.map((o) => o.name)).not.toContain('Bakkerij');
  });

  it('een buitenstaander kan een koppeling niet intrekken', async () => {
    await grantPartnerAccess(p, anna, bakkerij, { partnerOrgId: msp, access: 'lezer' });
    const kees = await loginAs(p, 'kees@garage.nl');
    await expect(revokePartnerAccess(p, kees, bakkerij, msp)).rejects.toMatchObject({ code: 'niet_gevonden' });
    await expect(revokePartnerAccess(p, tom, bakkerij, msp)).rejects.toMatchObject({ code: 'niet_gevonden' });
  });
});
