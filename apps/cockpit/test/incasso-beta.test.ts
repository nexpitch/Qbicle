import { NepBetaalprovider, settleTestPayment } from '@qbicle/platform';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasDb } from '../../../packages/platform/test/support/db.ts';
import { cockpitHarness } from './support.ts';

/** Reviewpunten I10 tot en met I13 (vóór de bèta). */
describe.skipIf(!hasDb)('incasso vóór de bèta: I10 tot en met I13', () => {
  let h: Awaited<ReturnType<typeof cockpitHarness>>;
  let fin: string;
  const PAID_DIRECT = 'a1111111-1111-4111-8111-111111111111';
  const PAID_LATER = 'a2222222-2222-4222-8222-222222222222';
  const RETRY = 'a3333333-3333-4333-8333-333333333333';
  const MAIL = 'a4444444-4444-4444-8444-444444444444';
  const ORGS = [PAID_DIRECT, PAID_LATER, RETRY, MAIL];
  const today = () => new Date().toISOString().slice(0, 10);

  type F = { id: string; status: string; suggested_action: string; attempt: number; previous_followup_id: string | null; mail_subject: string | null; mail_body: string | null; mail_status: string | null; mail_error: string | null };
  const followupsOf = async (org: string) =>
    (
      await h.p.pool.query(
        `SELECT id, status, suggested_action, attempt, previous_followup_id, mail_subject, mail_body, mail_status, mail_error
           FROM collection_followup WHERE organization_id = $1 ORDER BY attempt`,
        [org],
      )
    ).rows as F[];
  const last = async (org: string) => (await followupsOf(org)).at(-1)!;

  /** De klant betaalt de periode zelf (bijv. via de klantomgeving). */
  const customerPays = (org: string) =>
    h.p.pool.query(
      `INSERT INTO payment (organization_id, subscription_id, description, period_start, period_end,
                            amount_excl_cents, vat_cents, amount_incl_cents, status, provider, paid_at)
       SELECT organization_id, subscription_id, 'Zelf betaald', period_start, period_end, amount_excl_cents, vat_cents, amount_incl_cents, 'betaald', 'nep', now()
         FROM collection_item WHERE organization_id = $1`,
      [org],
    );

  beforeAll(async () => {
    h = await cockpitHarness();
    const q = h.p.pool;
    await q.query(
      `INSERT INTO organization (id, name, kind, payment_method, billing_email) VALUES
        ($1, 'Drukkerij Direct', 'klant', 'incasso', 'a@direct.test'),
        ($2, 'Later BV', 'klant', 'incasso', 'b@later.test'),
        ($3, 'Opnieuw & Co', 'klant', 'incasso', 'c@opnieuw.test'),
        ($4, 'Mailfout VOF', 'klant', 'incasso', 'd@mailfout.test')`,
      ORGS,
    );
    await q.query(
      `INSERT INTO subscription (organization_id, plan, billing_interval, monthly_price_cents, status, current_period_start, current_period_end)
       SELECT id, 'mkb', 'maand', 5900, 'actief', now() - interval '1 month', now() - interval '1 hour' FROM organization WHERE id = ANY($1)`,
      [ORGS],
    );
    const admin = await h.login('beheer@qbicle.test', 'beheerder');
    fin = await h.login('fin@qbicle.test', 'financieel');
    const run = ((await (await h.post('/api/incasso', { incassodatum: today() }, fin)).json()) as { batch: string }).batch;
    expect((await h.post(`/api/incasso/${run}/valideren`, {}, fin)).status).toBe(200);
    expect((await h.post(`/api/incasso/${run}/indienen`, {}, admin)).status).toBe(200);
    const items = (await q.query('SELECT id FROM collection_item WHERE run_id = $1', [run])).rows as Array<{ id: string }>;
    expect(items).toHaveLength(4);
    for (const it of items) {
      expect((await h.post(`/api/incasso/regels/${it.id}/testuitkomst`, { uitkomst: 'mislukt', reden: 'geen_dekking' }, fin)).status).toBe(200);
    }
  });
  afterAll(async () => h?.close());

  it('I10: opnieuw incasseren weigert als de klant de periode al zelf betaalde', async () => {
    const f = await last(PAID_DIRECT);
    expect(f.suggested_action).toBe('herpoging');
    await customerPays(PAID_DIRECT);
    const before = h.p.mailer.sent.length;
    const res = await h.post(`/api/incasso/vervolg/${f.id}/uitvoeren`, { actie: 'herpoging', onderwerp: f.mail_subject, tekst: f.mail_body }, fin);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { alBetaald: boolean }).alBetaald).toBe(true);
    expect(h.p.mailer.sent.length).toBe(before);
    const after = await last(PAID_DIRECT);
    expect(after.status).toBe('vervallen');
    const pays = (await h.p.pool.query(`SELECT count(*)::int AS n FROM payment WHERE organization_id = $1 AND description LIKE 'Herpoging:%'`, [PAID_DIRECT])).rows[0];
    expect(pays.n).toBe(0);
  });

  it('I10: een open voorstel vervalt vanzelf zodra de klant betaald heeft', async () => {
    await customerPays(PAID_LATER);
    const page = await (await h.get('/incasso/mislukt', fin)).text();
    expect(page).not.toContain('Later BV');
    expect((await last(PAID_LATER)).status).toBe('vervallen');
    const done = await (await h.get('/incasso/mislukt?toon=afgehandeld', fin)).text();
    expect(done).toContain('Vervallen: al betaald');
    const log = (await h.p.pool.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'cockpit.incasso_vervolg_vervallen'`)).rows[0];
    expect(log.n).toBe(2);
  });

  it('I10: mislukt de vervolgbetaling, dan komt er een nieuw voorstel, daarna bellen', async () => {
    const first = await last(RETRY);
    expect(first.suggested_action).toBe('herpoging');
    expect((await h.post(`/api/incasso/vervolg/${first.id}/uitvoeren`, { actie: 'herpoging', onderwerp: first.mail_subject, tekst: first.mail_body }, fin)).status).toBe(200);
    expect((await h.post(`/api/incasso/vervolg/${first.id}/testuitkomst`, { uitkomst: 'mislukt' }, fin)).status).toBe(200);

    const second = await last(RETRY);
    expect(second.attempt).toBe(2);
    expect(second.previous_followup_id).toBe(first.id);
    expect(second.status).toBe('voorgesteld');
    expect(second.suggested_action).toBe('factuur_sturen');
    expect(second.mail_body).toContain('Ook de nieuwe poging');

    expect((await h.post(`/api/incasso/vervolg/${second.id}/uitvoeren`, { actie: 'factuur_sturen', onderwerp: second.mail_subject, tekst: second.mail_body }, fin)).status).toBe(200);
    expect((await h.post(`/api/incasso/vervolg/${second.id}/testuitkomst`, { uitkomst: 'mislukt' }, fin)).status).toBe(200);
    const third = await last(RETRY);
    expect(third.attempt).toBe(3);
    expect(third.suggested_action).toBe('bellen');

    // Opnieuw de lijst openen maakt geen dubbele voorstellen.
    await h.get('/incasso/mislukt', fin);
    expect(await followupsOf(RETRY)).toHaveLength(3);
  });

  it('I11: mislukt de mail, dan is dat zichtbaar en kan hij opnieuw worden verstuurd', async () => {
    const f = await last(MAIL);
    const mailer = h.p.mailer;
    const send = mailer.send.bind(mailer);
    mailer.send = async () => {
      throw new Error('Brevo: 503 Service Unavailable');
    };
    try {
      const res = await h.post(`/api/incasso/vervolg/${f.id}/uitvoeren`, { actie: 'herpoging', onderwerp: f.mail_subject, tekst: f.mail_body }, fin);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { mailMislukt: boolean }).mailMislukt).toBe(true);
    } finally {
      mailer.send = send;
    }
    const failed = await last(MAIL);
    expect(failed.status).toBe('uitgevoerd');
    expect(failed.mail_status).toBe('mislukt');
    expect(failed.mail_error).toContain('503');

    // Blijft bij "te doen" staan met een knop om opnieuw te versturen.
    const page = await (await h.get('/incasso/mislukt', fin)).text();
    expect(page).toContain('Mailfout VOF');
    expect(page).toContain('Mail opnieuw versturen');

    const res = await h.post(`/api/incasso/vervolg/${f.id}/mail-opnieuw`, {}, fin);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { verstuurd: boolean }).verstuurd).toBe(true);
    expect((await last(MAIL)).mail_status).toBe('verstuurd');
    expect(mailer.sent.filter((m) => m.to === 'd@mailfout.test')).toHaveLength(1);
    expect((await h.post(`/api/incasso/vervolg/${f.id}/mail-opnieuw`, {}, fin)).status).toBe(409);

    const log = (await h.p.pool.query(`SELECT action FROM audit_log WHERE subject = $1 ORDER BY id`, [f.id])).rows.map((r) => r.action);
    expect(log).toEqual(['cockpit.incasso_vervolg_uitgevoerd', 'cockpit.incasso_vervolg_mail_mislukt', 'cockpit.incasso_vervolg_mail_verstuurd']);
  });

  it('I12: testbetalingen staan in de database, dus een tweede programma ziet ze ook', async () => {
    const web = new NepBetaalprovider('https://app.qbicle.test', h.p.pool);
    const cockpit = new NepBetaalprovider('https://app.qbicle.test', h.p.pool);
    const { providerPaymentId } = await cockpit.createPayment({
      paymentId: '00000000-0000-4000-8000-000000000001',
      amountInclCents: 100,
      description: 'test',
      redirectUrl: 'x',
      webhookUrl: 'x',
    });
    expect(await web.getStatus(providerPaymentId)).toBe('open');
    await web.settle(providerPaymentId, 'betaald');
    expect(await cockpit.getStatus(providerPaymentId)).toBe('betaald');
    // Maar één keer: een betaalde testbetaling wordt niet alsnog mislukt.
    await cockpit.settle(providerPaymentId, 'mislukt');
    expect(await web.getStatus(providerPaymentId)).toBe('betaald');
  });

  it('I13: een testbetaling geeft een testfactuur uit een eigen reeks', async () => {
    const r = (
      await h.p.pool.query(
        `SELECT pm.id, f.organization_id FROM collection_followup f JOIN payment pm ON pm.id = f.result_payment_id
          WHERE f.organization_id = $1 AND pm.status = 'open'`,
        [MAIL],
      )
    ).rows[0] as { id: string; organization_id: string };
    const owner = (
      await h.p.pool.query(
        `INSERT INTO app_user (email) VALUES ('eigenaar@mailfout.test') RETURNING id`,
      )
    ).rows[0] as { id: string };
    await h.p.pool.query(`INSERT INTO membership (organization_id, user_id, role) VALUES ($1, $2, 'eigenaar')`, [MAIL, owner.id]);
    await settleTestPayment(h.p, { userId: owner.id }, r.id, 'betaald');
    const inv = (await h.p.pool.query('SELECT number, test FROM invoice WHERE payment_id = $1', [r.id])).rows[0] as { number: string; test: boolean };
    expect(inv.number).toMatch(/^TEST-\d{4}-\d{6}$/);
    expect(inv.test).toBe(true);
  });
});
