import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  acceptInvitation,
  changeMemberRole,
  createOrganization,
  extractToken,
  getOrganization,
  inviteMember,
  listAudit,
  listMembers,
  listOrganizationsForUser,
  removeMember,
  renameOrganization,
  revokeInvitation,
} from '../src/index.ts';
import { createTestPlatform, hasDb, type TestPlatform } from './support/db.ts';
import { loginAs } from './support/users.ts';

type U = Awaited<ReturnType<typeof loginAs>>;

describe.skipIf(!hasDb)('organisaties, leden en uitnodigingen', () => {
  let p: TestPlatform;
  let anna: U; // eigenaar Bakkerij
  let kees: U; // eigenaar Garage, een andere klant
  let orgId: string;
  let otherOrgId: string;

  beforeAll(async () => {
    p = await createTestPlatform();
    anna = await loginAs(p, 'anna@bakkerij.nl');
    kees = await loginAs(p, 'kees@garage.nl');
    orgId = (await createOrganization(p, anna, { name: '  Bakkerij   de Korenaar ', kind: 'klant' })).id;
    otherOrgId = (await createOrganization(p, kees, { name: 'Garage Kees', kind: 'klant' })).id;
  });
  afterAll(async () => p?.close());

  it('de maker wordt eigenaar; de naam wordt opgeschoond', async () => {
    const org = await getOrganization(p, anna.userId, orgId);
    expect(org.name).toBe('Bakkerij de Korenaar');
    expect(org.access).toMatchObject({ role: 'eigenaar', via: 'lid' });
  });

  it('een andere klant ziet de organisatie niet (ook niet dat ze bestaat)', async () => {
    await expect(getOrganization(p, kees.userId, orgId)).rejects.toMatchObject({ code: 'niet_gevonden' });
    await expect(listMembers(p, kees.userId, orgId)).rejects.toMatchObject({ code: 'niet_gevonden' });
    await expect(renameOrganization(p, kees, orgId, 'Overgenomen')).rejects.toMatchObject({ code: 'niet_gevonden' });
    await expect(getOrganization(p, kees.userId, 'geen-uuid')).rejects.toMatchObject({ code: 'niet_gevonden' });
    const list = await listOrganizationsForUser(p, kees.userId);
    expect(list.map((o) => o.id)).toEqual([otherOrgId]);
  });

  it('uitnodigen, accepteren met hetzelfde adres, en daarna lid zijn', async () => {
    await inviteMember(p, anna, orgId, { email: 'Piet@Bakkerij.nl', role: 'beheerder' });
    const mail = p.mailer.last('piet@bakkerij.nl')!;
    expect(mail.subject).toContain('Bakkerij de Korenaar');
    const token = extractToken(mail.text, 'qbu_')!;

    // Iemand anders met de doorgestuurde link: geweigerd.
    await expect(acceptInvitation(p, kees, token)).rejects.toMatchObject({ code: 'geen_toegang' });

    const piet = await loginAs(p, 'piet@bakkerij.nl');
    expect(await acceptInvitation(p, piet, token)).toEqual({ organizationId: orgId, role: 'beheerder' });
    await expect(acceptInvitation(p, piet, token)).rejects.toMatchObject({ code: 'verlopen' });

    const members = await listMembers(p, anna.userId, orgId);
    expect(members.map((m) => [m.email, m.role])).toEqual([
      ['anna@bakkerij.nl', 'eigenaar'],
      ['piet@bakkerij.nl', 'beheerder'],
    ]);
  });

  it('een beheerder kan geen eigenaar uitnodigen of maken', async () => {
    const piet = await loginAs(p, 'piet@bakkerij.nl');
    await expect(inviteMember(p, piet, orgId, { email: 'x@bakkerij.nl', role: 'eigenaar' })).rejects.toMatchObject({ code: 'geen_toegang' });
    await expect(changeMemberRole(p, piet, orgId, piet.userId, 'eigenaar')).rejects.toMatchObject({ code: 'geen_toegang' });
    await expect(changeMemberRole(p, piet, orgId, anna.userId, 'lezer')).rejects.toMatchObject({ code: 'geen_toegang' });
    await expect(removeMember(p, piet, orgId, anna.userId)).rejects.toMatchObject({ code: 'geen_toegang' });
  });

  it('een lezer kan niemand uitnodigen', async () => {
    await inviteMember(p, anna, orgId, { email: 'lies@bakkerij.nl', role: 'lezer' });
    const token = extractToken(p.mailer.last('lies@bakkerij.nl')!.text, 'qbu_')!;
    const lies = await loginAs(p, 'lies@bakkerij.nl');
    await acceptInvitation(p, lies, token);
    await expect(inviteMember(p, lies, orgId, { email: 'y@bakkerij.nl', role: 'lezer' })).rejects.toMatchObject({ code: 'geen_toegang' });
  });

  it('de laatste eigenaar kan niet weg of omlaag', async () => {
    await expect(changeMemberRole(p, anna, orgId, anna.userId, 'lezer')).rejects.toMatchObject({ code: 'conflict' });
    await expect(removeMember(p, anna, orgId, anna.userId)).rejects.toMatchObject({ code: 'conflict' });
  });

  it('met twee eigenaren kan er één vertrekken', async () => {
    const piet = await loginAs(p, 'piet@bakkerij.nl');
    await changeMemberRole(p, anna, orgId, piet.userId, 'eigenaar');
    await changeMemberRole(p, anna, orgId, anna.userId, 'beheerder');
    await changeMemberRole(p, piet, orgId, anna.userId, 'eigenaar');
  });

  it('een nieuwe uitnodiging vervangt de oude; intrekken maakt de link ongeldig', async () => {
    await inviteMember(p, anna, orgId, { email: 'joke@bakkerij.nl', role: 'lezer' });
    const first = extractToken(p.mailer.last('joke@bakkerij.nl')!.text, 'qbu_')!;
    const inv = await inviteMember(p, anna, orgId, { email: 'joke@bakkerij.nl', role: 'lezer' });
    const second = extractToken(p.mailer.last('joke@bakkerij.nl')!.text, 'qbu_')!;
    expect(second).toBeDefined();
    const joke = await loginAs(p, 'joke@bakkerij.nl');
    await expect(acceptInvitation(p, joke, first)).rejects.toMatchObject({ code: 'verlopen' });
    await revokeInvitation(p, anna, orgId, inv.id);
    await expect(acceptInvitation(p, joke, second)).rejects.toMatchObject({ code: 'verlopen' });
  });

  it('een andere organisatie kan uitnodigingen van deze organisatie niet intrekken', async () => {
    const inv = await inviteMember(p, anna, orgId, { email: 'kim@bakkerij.nl', role: 'lezer' });
    await expect(revokeInvitation(p, kees, otherOrgId, inv.id)).rejects.toMatchObject({ code: 'niet_gevonden' });
  });

  it('wie al lid is, kan niet opnieuw worden uitgenodigd', async () => {
    await expect(inviteMember(p, anna, orgId, { email: 'piet@bakkerij.nl', role: 'lezer' })).rejects.toMatchObject({ code: 'conflict' });
  });

  it('alles staat in het audit-log van de organisatie, en niet bij een ander', async () => {
    const log = await listAudit(p.pool, orgId);
    const actions = log.map((l) => l.action);
    expect(actions).toContain('org.aangemaakt');
    expect(actions).toContain('uitnodiging.geaccepteerd');
    expect(actions).toContain('lid.rol_gewijzigd');
    const other = await listAudit(p.pool, otherOrgId);
    expect(other.map((l) => l.action)).toEqual(['org.aangemaakt']);
  });

  it('het audit-log kan niet worden gewijzigd of gewist', async () => {
    await expect(p.pool.query("UPDATE audit_log SET action = 'x'")).rejects.toThrow(/alleen-toevoegen/);
    await expect(p.pool.query('DELETE FROM audit_log')).rejects.toThrow(/alleen-toevoegen/);
    await expect(p.pool.query('TRUNCATE audit_log')).rejects.toThrow(/alleen-toevoegen/);
  });
});
