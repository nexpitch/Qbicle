import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  changePlan,
  checkoutSubscription,
  checkVatNumber,
  cleanCountryAndVat,
  completeSignup,
  createAuditOrder,
  createOrganization,
  extractToken,
  getBilling,
  getBillingDetails,
  listInvoices,
  login,
  parseViesResponse,
  recheckVatNumber,
  registerSignup,
  retryPayment,
  settleTestPayment,
  startSubscription,
  updateBillingDetails,
  vatTreatment,
  ViesRestClient,
} from '../src/index.ts';
import { createTestPlatform, hasDb, type TestPlatform } from './support/db.ts';
import { loginAs } from './support/users.ts';

type U = Awaited<ReturnType<typeof loginAs>>;

describe('btw-nummer: formaat per land', () => {
  it('accepteert geldige formaten en maakt ze netjes', () => {
    expect(cleanCountryAndVat('be', 'be 0123.456.789')).toEqual({ land: 'BE', btw: 'BE0123456789' });
    expect(cleanCountryAndVat('DE', 'DE123456789').btw).toBe('DE123456789');
    expect(cleanCountryAndVat('GR', 'EL123456789').btw).toBe('EL123456789');
    expect(cleanCountryAndVat('AT', 'ATU12345678').btw).toBe('ATU12345678');
    expect(cleanCountryAndVat('NL', 'nl 123456789 b01').btw).toBe('NL123456789B01');
    expect(cleanCountryAndVat('US', '12-3456789').btw).toBe('123456789');
    expect(cleanCountryAndVat(null, null)).toEqual({ land: 'NL', btw: null });
  });

  it('weigert een nummer dat niet bij het land hoort of het verkeerde formaat heeft', () => {
    expect(() => cleanCountryAndVat('BE', 'NL123456789B01')).toThrow(/begint met BE/);
    expect(() => cleanCountryAndVat('DE', 'DE12345')).toThrow(/formaat van Duitsland/);
    expect(() => cleanCountryAndVat('GR', 'GR123456789')).toThrow(/begint met EL/);
  });
});

describe('VIES-antwoord lezen', () => {
  it('geldig, ongeldig en storing', () => {
    expect(parseViesResponse(200, { valid: true, requestIdentifier: 'WAPIAAAAX', requestDate: '2026-11-27T10:00:00Z', name: 'ACME NV', address: '---' })).toMatchObject({
      status: 'geldig',
      requestIdentifier: 'WAPIAAAAX',
      name: 'ACME NV',
      address: null,
    });
    expect(parseViesResponse(200, { valid: false, userError: 'INVALID' }).status).toBe('ongeldig');
    expect(parseViesResponse(200, { valid: false, userError: 'MS_UNAVAILABLE' }).status).toBe('storing');
    expect(parseViesResponse(200, { actionSucceed: false, errorWrappers: [{ error: 'MS_MAX_CONCURRENT_REQ' }] }).status).toBe('storing');
    expect(parseViesResponse(400, { actionSucceed: false, errorWrappers: [{ error: 'INVALID_INPUT' }] }).status).toBe('ongeldig');
    expect(parseViesResponse(500, {}).status).toBe('storing');
  });

  it('netwerkfout of time-out wordt storing, nooit geldig', async () => {
    const down = new ViesRestClient('https://vies.test', 50, (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch);
    expect(await down.check({ countryCode: 'BE', vatNumber: '0123456789' })).toMatchObject({ status: 'storing' });
    let sent: unknown;
    const ok = new ViesRestClient('https://vies.test', 50, (async (_u: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ valid: true, requestIdentifier: 'WAPI1' }), { status: 200 });
    }) as unknown as typeof fetch);
    expect((await ok.check({ countryCode: 'BE', vatNumber: '0123456789', requesterCountryCode: 'NL', requesterNumber: '123456789B01' })).requestIdentifier).toBe('WAPI1');
    expect(sent).toEqual({ countryCode: 'BE', vatNumber: '0123456789', requesterMemberStateCode: 'NL', requesterNumber: '123456789B01' });
  });
});

describe.skipIf(!hasDb)('btw verlegd voor EU-klanten buiten NL', () => {
  let p: TestPlatform;
  let eigenaar: U;
  let n = 0;
  const pct = () => p.catalog.btwPercentage;

  async function klant(land: string, btw: string | null): Promise<string> {
    const org = (await createOrganization(p, eigenaar, { name: `Klant ${++n}`, kind: 'klant' })).id;
    await updateBillingDetails(p, eigenaar, org, { naam: `Klant ${n}`, land, btwNummer: btw, adres: 'Straat 1', postcode: '1000', plaats: 'Brussel' });
    await startSubscription(p, eigenaar, org, { plan: 'mkb', interval: 'maand' });
    return org;
  }

  /** Alleen in tests: controles ouder maken (in productie is vat_check onwijzigbaar). */
  async function backdate(org: string, interval: string) {
    await p.pool.query(`ALTER TABLE vat_check DISABLE TRIGGER vat_check_no_update`);
    await p.pool.query(`UPDATE vat_check SET checked_at = checked_at - $2::interval WHERE organization_id = $1`, [org, interval]);
    await p.pool.query(`ALTER TABLE vat_check ENABLE TRIGGER vat_check_no_update`);
  }

  beforeAll(async () => {
    p = await createTestPlatform();
    p.config.supplierVatNumber = 'NL864512378B01';
    eigenaar = await loginAs(p, 'eigenaar@voorbeeld.be');
  });
  beforeEach(() => {
    p.vies.calls = [];
    p.vies.outcomes.clear();
  });
  afterAll(async () => p?.close());

  it('geldig Belgisch nummer: 0% btw verlegd, factuur met beide btw-nummers en bewijs', async () => {
    const org = await klant('BE', 'BE0123456789');
    expect(p.vies.calls).toEqual([{ countryCode: 'BE', vatNumber: '0123456789', requesterCountryCode: 'NL', requesterNumber: '864512378B01' }]);
    const d = await getBillingDetails(p, eigenaar.userId, org);
    expect(d.btw).toMatchObject({ vanToepassing: true, verlegd: true });
    expect(d.btw.laatsteControle).toMatchObject({ status: 'geldig', source: 'klant' });
    expect(d.btw.laatsteControle!.requestIdentifier).toMatch(/^TEST/);

    const b = await getBilling(p, eigenaar.userId, org);
    expect(b.btw).toMatchObject({ verlegd: true, percentage: 0 });
    expect(b.volgendeBetaling!.inclCents).toBe(b.volgendeBetaling!.exclCents);

    const { payment } = await checkoutSubscription(p, eigenaar, org);
    expect(payment).toMatchObject({ vatCents: 0, vatCode: 'eu_verlegd', vatRate: 0 });
    expect(payment.amountInclCents).toBe(payment.amountExclCents);
    await settleTestPayment(p, eigenaar, payment.id, 'betaald');
    const [inv] = await listInvoices(p, eigenaar.userId, org);
    expect(inv).toMatchObject({ vatCode: 'eu_verlegd', reverseCharge: true, vatRate: 0, vatCents: 0, customerVatNumber: 'BE0123456789', supplierVatNumber: 'NL864512378B01' });
    const row = await p.pool.query('SELECT vat_check_id FROM invoice WHERE id = $1', [inv!.id]);
    expect(row.rows[0].vat_check_id).toBeTruthy();
    // Het bewijs is onwijzigbaar.
    await expect(p.pool.query(`UPDATE vat_check SET status = 'ongeldig' WHERE id = $1`, [row.rows[0].vat_check_id])).rejects.toThrow(/bewijs/);
  });

  it('ongeldig nummer volgens VIES: gewoon btw', async () => {
    p.vies.outcomes.set('DE123456789', 'ongeldig');
    const org = await klant('DE', 'DE123456789');
    const { payment } = await checkoutSubscription(p, eigenaar, org);
    expect(payment.vatCode).toBe('nl_standaard');
    expect(payment.vatCents).toBe(Math.round((payment.amountExclCents * pct()) / 100));
    expect((await getBillingDetails(p, eigenaar.userId, org)).btw.uitleg).toMatch(/niet als geldig/);
  });

  it('VIES in storing: nooit stilzwijgend 0%, later opnieuw proberen lukt', async () => {
    p.vies.outcomes.set('FR12345678901', 'storing');
    const org = await klant('FR', 'FR12345678901');
    expect((await getBilling(p, eigenaar.userId, org)).btw).toMatchObject({ verlegd: false, percentage: pct() });
    const { payment } = await checkoutSubscription(p, eigenaar, org);
    expect(payment.vatCode).toBe('nl_standaard');
    // Bij betalen is opnieuw gevraagd (de vorige controle was geen uitslag).
    expect(p.vies.calls.length).toBe(2);

    p.vies.outcomes.set('FR12345678901', 'geldig');
    await backdate(org, '2 minutes');
    const st = await recheckVatNumber(p, eigenaar, org);
    expect(st.verlegd).toBe(true);
    const again = await checkoutSubscription(p, eigenaar, org);
    expect(again.payment.vatCode).toBe('eu_verlegd');
    // Te snel nog eens: beschermt VIES tegen spammen.
    await expect(recheckVatNumber(p, eigenaar, org)).rejects.toMatchObject({ code: 'conflict' });
  });

  it('Nederland en buiten de EU: gewoon btw, geen VIES-vraag', async () => {
    const nl = await klant('NL', 'NL123456789B01');
    const us = await klant('US', '123456789');
    expect(p.vies.calls).toEqual([]);
    for (const org of [nl, us]) {
      const { payment } = await checkoutSubscription(p, eigenaar, org);
      expect(payment.vatCode).toBe('nl_standaard');
      expect(payment.vatRate).toBe(pct());
    }
    expect((await getBillingDetails(p, eigenaar.userId, us)).btw.uitleg).toMatch(/Buiten de EU/);
  });

  it('EU-klant zonder btw-nummer: btw, met uitleg hoe 0% te krijgen', async () => {
    const org = await klant('BE', null);
    const b = await getBilling(p, eigenaar.userId, org);
    expect(b.btw.verlegd).toBe(false);
    expect(b.btw.uitleg).toMatch(/Vul je btw-nummer in/);
  });

  it('verouderde controle: bij betalen opnieuw vragen; ongeldig geworden = btw en melding voor de cockpit', async () => {
    const org = await klant('BE', 'BE0987654321');
    await backdate(org, '40 days');
    expect((await vatTreatment(p, p.pool, org)).reverseCharge).toBe(false);

    p.vies.outcomes.set('BE0987654321', 'ongeldig');
    const { payment } = await checkoutSubscription(p, eigenaar, org);
    expect(p.vies.calls).toHaveLength(2);
    expect(payment.vatCode).toBe('nl_standaard');
    const o = await p.pool.query('SELECT vat_alert_at, vat_alert FROM organization WHERE id = $1', [org]);
    expect(o.rows[0].vat_alert_at).toBeTruthy();
    expect(o.rows[0].vat_alert).toMatch(/ongeldig/);
    const note = await p.pool.query(`SELECT body FROM org_note WHERE organization_id = $1 AND source = 'systeem'`, [org]);
    expect(note.rows[0].body).toMatch(/Btw verlegd gestopt/);

    // Weer geldig: melding vervalt.
    p.vies.outcomes.set('BE0987654321', 'geldig');
    await checkVatNumber(p, org, 'cockpit', { userId: null });
    const o2 = await p.pool.query('SELECT vat_alert_at FROM organization WHERE id = $1', [org]);
    expect(o2.rows[0].vat_alert_at).toBeNull();
  });

  it('upgrade naar rato, Audit en opnieuw betalen volgen de btw-stand', async () => {
    const org = await klant('LU', 'LU12345678');
    const first = await checkoutSubscription(p, eigenaar, org);
    await settleTestPayment(p, eigenaar, first.payment.id, 'betaald');
    const up = await changePlan(p, eigenaar, org, { plan: 'business', interval: 'maand' });
    expect(up.payment).toMatchObject({ vatCode: 'eu_verlegd', vatCents: 0 });
    expect(up.preview.btwPercentage).toBe(0);
    expect(up.preview.bijbetalingInclCents).toBe(up.preview.bijbetalingExclCents);

    const audit = await createAuditOrder(p, eigenaar, org, { package: 'audit-quick', targetName: 'Doel BV', domains: ['doel.nl'] });
    expect(audit.payment).toMatchObject({ vatCode: 'eu_verlegd', vatCents: 0 });

    // Mislukte upgradebetaling opnieuw, terwijl het nummer intussen ongeldig is: nu met btw.
    await settleTestPayment(p, eigenaar, up.payment!.id, 'mislukt');
    p.vies.outcomes.set('LU12345678', 'ongeldig');
    await backdate(org, '40 days');
    const retry = await retryPayment(p, eigenaar, org, up.payment!.id);
    expect(retry.payment.vatCode).toBe('nl_standaard');
    expect(retry.payment.amountExclCents).toBe(up.payment!.amountExclCents);
    expect(retry.payment.vatCents).toBe(Math.round((retry.payment.amountExclCents * pct()) / 100));
  });

  it('registreren met land en btw-nummer: meteen gecontroleerd', async () => {
    await registerSignup(
      p,
      { email: 'nieuw@bedrijf.be', organizationName: 'Bedrijf BE', plan: 'mkb', interval: 'jaar', country: 'BE', vatNumber: 'BE 0111.222.333' },
      { userId: null, ip: '198.51.100.9' },
    );
    await expect(
      registerSignup(p, { email: 'fout@bedrijf.be', organizationName: 'Fout', plan: 'mkb', country: 'BE', vatNumber: 'DE123456789' }, { userId: null }),
    ).rejects.toMatchObject({ code: 'ongeldige_invoer' });
    const token = extractToken(p.mailer.last('nieuw@bedrijf.be')!.text, 'qbl_')!;
    const r = await login(p, token, { userId: null });
    const done = await completeSignup(p, { userId: r.session.user.id, email: r.session.user.email });
    const d = await getBillingDetails(p, r.session.user.id, done!.organizationId);
    expect(d).toMatchObject({ land: 'BE', btwNummer: 'BE0111222333' });
    expect(d.btw.laatsteControle).toMatchObject({ status: 'geldig', source: 'registratie' });
    expect((await getBilling(p, r.session.user.id, done!.organizationId)).btw.verlegd).toBe(true);
  });
});
