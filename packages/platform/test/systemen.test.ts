import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  acceptInvitation,
  addSysteem,
  beoordeelSysteem,
  createOrganization,
  extractToken,
  getSysteem,
  inviteMember,
  listAudit,
  listSystemen,
  removeSysteem,
  startSubscription,
  updateSysteem,
  type SysteemInvoer,
} from '../src/index.ts';
import { createTestPlatform, hasDb, type TestPlatform } from './support/db.ts';
import { loginAs } from './support/users.ts';

const basis = {
  naam: 'Webshop',
  hosting: 'saas',
  eigenaar: 'Sanne',
  impactUitval: 'merkbaar',
  gegevens: [],
  inloggen: 'mfa',
  updates: 'leverancier',
  verwerkersovereenkomst: 'ja',
  datalocatie: 'eu',
  terugval: 'getest',
} as const;

describe('beoordeling bedrijfskritisch systeem', () => {
  it('stilstand of betaalgegevens geeft hoge impact', () => {
    expect(beoordeelSysteem({ ...basis, impactUitval: 'stil', gegevens: [] }).impact).toBe('hoog');
    expect(beoordeelSysteem({ ...basis, gegevens: ['betaalgegevens'] }).impact).toBe('hoog');
    expect(beoordeelSysteem({ ...basis, gegevens: ['klanten'] }).impact).toBe('middel');
    expect(beoordeelSysteem({ ...basis, impactUitval: 'laag' }).impact).toBe('laag');
  });

  it('goed geregeld systeem heeft geen acties', () => {
    expect(beoordeelSysteem({ ...basis, gegevens: ['klanten'] }).acties).toEqual([]);
  });

  it('acties in gewone taal, de urgentste eerst', () => {
    const b = beoordeelSysteem({
      ...basis,
      naam: 'Exact Online',
      eigenaar: null,
      impactUitval: 'stil',
      gegevens: ['klanten', 'betaalgegevens'],
      inloggen: 'wachtwoord',
      verwerkersovereenkomst: 'onbekend',
      datalocatie: 'buiten-eu',
      terugval: 'geen',
    });
    expect(b.impact).toBe('hoog');
    expect(b.waarom).toBe('Het bedrijf ligt stil als het uitvalt en er staan betaalgegevens in.');
    expect(b.acties[0]!.urgentie).toBe('crit');
    const tekst = b.acties.map((a) => a.tekst).join('\n');
    expect(tekst).toContain('tweestapsverificatie (MFA) aan voor Exact Online');
    expect(tekst).toContain('back-up of export');
    expect(tekst).toContain('verwerkersovereenkomst');
    expect(tekst).toContain('buiten de EU');
    expect(tekst).toContain('verantwoordelijk');
  });

  it('eigen server zonder vaste updates', () => {
    const b = beoordeelSysteem({ ...basis, hosting: 'eigen-server', updates: 'niemand' });
    expect(b.acties.map((a) => a.tekst).join()).toContain('updates');
  });
});

describe.skipIf(!hasDb)('register bedrijfskritische systemen', () => {
  let p: TestPlatform;
  let eigenaar: Awaited<ReturnType<typeof loginAs>>;
  let lezer: Awaited<ReturnType<typeof loginAs>>;
  let org: string;
  const invoer = (naam: string): SysteemInvoer => ({ naam, soort: 'boekhouding', impactUitval: 'stil', gegevens: ['klanten'] });

  beforeAll(async () => {
    p = await createTestPlatform();
    eigenaar = await loginAs(p, 'eigenaar@systemen.nl');
    lezer = await loginAs(p, 'lezer@systemen.nl');
    org = (await createOrganization(p, eigenaar, { name: 'Systemen BV', kind: 'klant' })).id;
    await startSubscription(p, eigenaar, org, { plan: 'mkb', interval: 'jaar' });
    await inviteMember(p, eigenaar, org, { email: lezer.email, role: 'lezer' });
    await acceptInvitation(p, lezer, extractToken(p.mailer.last(lezer.email)!.text, 'qbu_')!);
  });
  afterAll(async () => p?.close());

  it('toevoegen, lezen, wijzigen, verwijderen, met audit-log', async () => {
    const s = await addSysteem(p, eigenaar, org, { ...invoer('  Exact Online '), leverancier: '', gegevens: ['klanten', 'klanten'] });
    expect(s.naam).toBe('Exact Online');
    expect(s.leverancier).toBeNull();
    expect(s.gegevens).toEqual(['klanten']);
    expect(s.hosting).toBe('onbekend');

    const g = await getSysteem(p, lezer.userId, org, s.id);
    expect(g.beoordeling.impact).toBe('hoog');

    const u = await updateSysteem(p, eigenaar, org, s.id, { ...invoer('Exact Online'), impactUitval: 'laag', gegevens: [] });
    expect(u.impactUitval).toBe('laag');

    await removeSysteem(p, eigenaar, org, s.id);
    await expect(getSysteem(p, eigenaar.userId, org, s.id)).rejects.toThrow(/bestaat niet/);
    const log = (await listAudit(p.pool, org)).map((r) => r.action);
    expect(log).toEqual(expect.arrayContaining(['systeem.toegevoegd', 'systeem.gewijzigd', 'systeem.verwijderd']));
  });

  it('lezer kan kijken maar niet wijzigen; een buitenstaander ziet niets', async () => {
    const reg = await listSystemen(p, lezer.userId, org);
    expect(reg.magWijzigen).toBe(false);
    await expect(addSysteem(p, lezer, org, invoer('Stiekem'))).rejects.toThrow(/geen toestemming/);
    const vreemd = await loginAs(p, 'vreemd@elders.nl');
    await expect(listSystemen(p, vreemd.userId, org)).rejects.toThrow(/bestaat niet/);
  });

  it('MKB tot 5 systemen, Business onbeperkt', async () => {
    for (let i = 1; i <= 5; i++) await addSysteem(p, eigenaar, org, invoer(`Systeem ${i}`));
    expect((await listSystemen(p, eigenaar.userId, org)).limiet).toBe(5);
    await expect(addSysteem(p, eigenaar, org, invoer('Zesde'))).rejects.toThrow(/5 systemen/);

    const biz = (await createOrganization(p, eigenaar, { name: 'Groot BV', kind: 'klant' })).id;
    await startSubscription(p, eigenaar, biz, { plan: 'business', interval: 'jaar' });
    for (let i = 1; i <= 6; i++) await addSysteem(p, eigenaar, biz, invoer(`Systeem ${i}`));
    const reg = await listSystemen(p, eigenaar.userId, biz);
    expect(reg.limiet).toBeNull();
    expect(reg.systemen).toHaveLength(6);
  });

  it('gelijktijdig toevoegen omzeilt de grens niet', async () => {
    const o = (await createOrganization(p, eigenaar, { name: 'Race BV', kind: 'klant' })).id;
    await startSubscription(p, eigenaar, o, { plan: 'mkb', interval: 'jaar' });
    const r = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => addSysteem(p, eigenaar, o, invoer(`S${i}`))));
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(5);
  });
});
