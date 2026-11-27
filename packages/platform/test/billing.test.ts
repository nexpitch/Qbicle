import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  accessState,
  cancelSubscription,
  checkoutSubscription,
  completeSignup,
  createAuditOrder,
  createOrganization,
  extractToken,
  findPlan,
  getBilling,
  getInvoice,
  inviteMember,
  acceptInvitation,
  listInvoices,
  login,
  parseCatalog,
  registerSignup,
  settleTestPayment,
  startSubscription,
  syncPayment,
  updateBillingDetails,
} from '../src/index.ts';
import { createTestPlatform, hasDb, type TestPlatform } from './support/db.ts';
import { loginAs } from './support/users.ts';

type U = Awaited<ReturnType<typeof loginAs>>;

describe('prijscatalogus', () => {
  const base = {
    btwPercentage: 21,
    abonnementen: [
      { id: 'mkb', product: 'mkb', naam: 'MKB', kort: 'k', voorWie: 'w', perMaandBijJaar: 39, perMaandBijMaand: 47, limieten: { domeinen: 3, gebruikers: 5, itPartners: 1 }, functies: ['a'] },
    ],
  };

  it('rekent euro’s om naar centen, zodat €39 of €49 één regel is', () => {
    const c = parseCatalog(base);
    expect(findPlan(c, 'mkb')!.maandprijsCenten).toEqual({ jaar: 3900, maand: 4700 });
    expect(c.proefDagen).toBe(14);
  });

  it('weigert een ongeldig bestand met een duidelijke melding', () => {
    expect(() => parseCatalog({ ...base, abonnementen: [{ ...base.abonnementen[0], perMaandBijJaar: 'veel' }] })).toThrow(/perMaandBijJaar/);
    expect(() => parseCatalog({ ...base, abonnementen: [base.abonnementen[0], base.abonnementen[0]] })).toThrow(/twee keer/);
  });

  it('het meegeleverde bestand is geldig', async () => {
    const { loadCatalog } = await import('../src/index.ts');
    const c = loadCatalog();
    expect(c.plans.map((x) => x.product)).toEqual(['mkb', 'corporate']);
    expect(findPlan(c, 'business')!.functies.join(' ')).toMatch(/Infra-inventaris/);
  });
});

describe.skipIf(!hasDb)('abonnementen, betalen en facturen', () => {
  let p: TestPlatform;
  let eigenaar: U;
  let vreemde: U;
  let org: string;

  beforeAll(async () => {
    p = await createTestPlatform();
    eigenaar = await loginAs(p, 'eva@drukkerij.nl');
    vreemde = await loginAs(p, 'iemand@elders.nl');
    org = (await createOrganization(p, eigenaar, { name: 'Drukkerij Eva', kind: 'klant' })).id;
  });
  afterAll(async () => p?.close());

  it('registreren: eerst een inloglink, bij inloggen organisatie en proef', async () => {
    await registerSignup(p, { email: 'Nieuw@Bouwbedrijf.nl', organizationName: 'Bouwbedrijf Nieuw', plan: 'mkb', interval: 'jaar' }, { userId: null, ip: '198.51.100.7' });
    const mail = p.mailer.last('nieuw@bouwbedrijf.nl')!;
    const token = extractToken(mail.text, 'qbl_')!;
    const r = await login(p, token, { userId: null });
    const done = await completeSignup(p, { userId: r.session.user.id, email: r.session.user.email });
    expect(done).toMatchObject({ plan: 'mkb', product: 'mkb' });

    const b = await getBilling(p, r.session.user.id, done!.organizationId);
    expect(b.toegang).toBe('proef');
    expect(b.dagenOver).toBe(p.catalog.proefDagen);
    expect(b.abonnement!.monthlyPriceCents).toBe(findPlan(p.catalog, 'mkb')!.maandprijsCenten.jaar);
    expect(b.magBeheren).toBe(true);

    // Een tweede keer inloggen maakt niet nog een organisatie.
    expect(await completeSignup(p, { userId: r.session.user.id, email: r.session.user.email })).toBeUndefined();
  });

  it('weigert een onbekend pakket', async () => {
    await expect(
      registerSignup(p, { email: 'x@y.nl', organizationName: 'X', plan: 'goud', interval: 'jaar' }, { userId: null }),
    ).rejects.toMatchObject({ code: 'ongeldige_invoer' });
  });

  it('betalen tijdens de proef: periode begint na de proef, daarna factuur', async () => {
    const sub = await startSubscription(p, eigenaar, org, { plan: 'business', interval: 'jaar' });
    expect(sub.status).toBe('proef');

    const { payment, checkoutUrl } = await checkoutSubscription(p, eigenaar, org);
    expect(checkoutUrl).toBe(`https://app.qbicle.test/betalen/test/${payment.id}`);
    const monthly = findPlan(p.catalog, 'business')!.maandprijsCenten.jaar;
    expect(payment.amountExclCents).toBe(monthly * 12);
    expect(payment.vatCents).toBe(Math.round((monthly * 12 * p.catalog.btwPercentage) / 100));
    expect(payment.periodStart!.getTime()).toBeCloseTo(sub.trialEndsAt!.getTime(), -4);

    await updateBillingDetails(p, eigenaar, org, { naam: 'Drukkerij Eva BV', kvk: '1234 5678', btwNummer: 'nl 123456789 b01', adres: 'Kade 1', postcode: '1011 AA', plaats: 'Amsterdam' });
    const paid = await settleTestPayment(p, eigenaar, payment.id, 'betaald');
    expect(paid.status).toBe('betaald');

    const b = await getBilling(p, eigenaar.userId, org);
    expect(b.toegang).toBe('actief');
    expect(b.abonnement!.status).toBe('actief');
    expect(b.openBetaling).toBeNull();

    const inv = await listInvoices(p, eigenaar.userId, org);
    expect(inv).toHaveLength(1);
    expect(inv[0]!.number).toMatch(/^TEST-\d{4}-\d{6}$/);
    expect(inv[0]!.customer).toMatchObject({ naam: 'Drukkerij Eva BV', kvk: '12345678', btwNummer: 'NL123456789B01' });
    expect(inv[0]!.amountInclCents).toBe(payment.amountInclCents);

    // Nog eens verwerken (webhook én terugkomen) geeft geen tweede factuur.
    await syncPayment(p, payment.id);
    expect(await listInvoices(p, eigenaar.userId, org)).toHaveLength(1);
  });

  it('facturen zijn onwijzigbaar', async () => {
    const [inv] = await listInvoices(p, eigenaar.userId, org);
    await expect(p.pool.query('UPDATE invoice SET amount_excl_cents = 1 WHERE id = $1', [inv!.id])).rejects.toThrow(/onwijzigbaar/);
  });

  it('een mislukte betaling activeert niets en geeft geen factuur', async () => {
    const o = (await createOrganization(p, eigenaar, { name: 'Tweede zaak', kind: 'klant' })).id;
    await startSubscription(p, eigenaar, o, { plan: 'mkb', interval: 'maand' });
    const { payment } = await checkoutSubscription(p, eigenaar, o);
    expect(payment.amountExclCents).toBe(findPlan(p.catalog, 'mkb')!.maandprijsCenten.maand);
    const r = await settleTestPayment(p, eigenaar, payment.id, 'mislukt');
    expect(r.status).toBe('mislukt');
    expect((await getBilling(p, eigenaar.userId, o)).toegang).toBe('proef');
    expect(await listInvoices(p, eigenaar.userId, o)).toHaveLength(0);
  });

  it('opzeggen: betaald loopt door tot het einde van de periode, proef stopt direct', async () => {
    const s = await cancelSubscription(p, eigenaar, org);
    expect(s.status).toBe('opgezegd');
    expect(accessState(s)).toBe('actief');

    const o = (await createOrganization(p, eigenaar, { name: 'Derde zaak', kind: 'klant' })).id;
    await startSubscription(p, eigenaar, o, { plan: 'mkb', interval: 'jaar' });
    const c = await cancelSubscription(p, eigenaar, o);
    expect(c.status).toBe('beeindigd');
    // Opnieuw beginnen geeft geen tweede proef.
    const again = await startSubscription(p, eigenaar, o, { plan: 'mkb', interval: 'jaar' });
    expect(accessState(again)).toBe('betaling_nodig');
  });

  it('Qbicle Audit: eenmalige opdracht, direct betalen', async () => {
    const r = await createAuditOrder(p, eigenaar, org, { package: 'audit-quick', targetName: 'Overnamekandidaat BV', domains: ['https://Kandidaat.nl', 'kandidaat.nl', 'kandidaat-shop.nl'] });
    expect(r.payment.amountExclCents).toBe(125_000);
    const row = await p.pool.query('SELECT target_domains FROM audit_order WHERE id = $1', [r.orderId]);
    expect(row.rows[0].target_domains).toEqual(['kandidaat.nl', 'kandidaat-shop.nl']);
    await settleTestPayment(p, eigenaar, r.payment.id, 'betaald');
    const st = await p.pool.query('SELECT status FROM audit_order WHERE id = $1', [r.orderId]);
    expect(st.rows[0].status).toBe('betaald');
    await expect(createAuditOrder(p, eigenaar, org, { package: 'audit-plus', targetName: 'X', domains: ['x.nl'] })).rejects.toMatchObject({ code: 'conflict' });
  });

  it('rechten: beheerder ziet, betaalt niet; anderen zien niets', async () => {
    await inviteMember(p, eigenaar, org, { email: 'bram@drukkerij.nl', role: 'beheerder' });
    const bram = await loginAs(p, 'bram@drukkerij.nl');
    await acceptInvitation(p, bram, extractToken(p.mailer.last('bram@drukkerij.nl')!.text, 'qbu_')!).catch(async () => {
      // De laatste mail aan bram is de inloglink; zoek de uitnodiging.
      const inv = p.mailer.sent.filter((m) => m.to === 'bram@drukkerij.nl').map((m) => extractToken(m.text, 'qbu_')).find(Boolean)!;
      await acceptInvitation(p, bram, inv);
    });
    const b = await getBilling(p, bram.userId, org);
    expect(b.magBeheren).toBe(false);
    await expect(checkoutSubscription(p, bram, org)).rejects.toMatchObject({ code: 'geen_toegang' });
    await expect(getBilling(p, vreemde.userId, org)).rejects.toMatchObject({ code: 'niet_gevonden' });
    const [inv] = await listInvoices(p, bram.userId, org);
    await expect(getInvoice(p, vreemde.userId, org, inv!.id)).rejects.toMatchObject({ code: 'niet_gevonden' });
  });
});
