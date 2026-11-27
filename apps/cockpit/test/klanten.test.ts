import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasDb } from '../../../packages/platform/test/support/db.ts';
import { cockpitHarness } from './support.ts';

describe.skipIf(!hasDb)('cockpit: bedrijven en gebruikers', () => {
  let h: Awaited<ReturnType<typeof cockpitHarness>>;
  let admin: string;
  let lezer: string;
  const ORG = '11111111-1111-4111-8111-111111111111';
  const ORG2 = '22222222-2222-4222-8222-222222222222';
  let klantId: string;

  beforeAll(async () => {
    h = await cockpitHarness();
    const q = h.p.pool;
    await q.query(`INSERT INTO organization (id, name, kind, kvk_number) VALUES ($1, 'Bakkerij De Korst', 'klant', '12345678'), ($2, 'Van Dijk Advocaten', 'klant', NULL)`, [ORG, ORG2]);
    klantId = (await q.query(`INSERT INTO app_user (email, last_login_at) VALUES ('jan@dekorst.nl', now()) RETURNING id`)).rows[0].id;
    await q.query(`INSERT INTO membership (organization_id, user_id, role) VALUES ($1, $2, 'eigenaar')`, [ORG, klantId]);
    await q.query(`INSERT INTO domain (organization_id, name, verification_token) VALUES ($1, 'dekorst.nl', 'abc')`, [ORG]);
    await q.query(
      `INSERT INTO subscription (organization_id, plan, billing_interval, monthly_price_cents, status, current_period_start, current_period_end)
       VALUES ($1, 'mkb', 'jaar', 4900, 'actief', now(), now() + interval '1 year'),
              ($2, 'business', 'maand', 17900, 'achterstallig', now() - interval '1 month', now())`,
      [ORG, ORG2],
    );
    await q.query(
      `INSERT INTO payment (organization_id, subscription_id, description, amount_excl_cents, vat_cents, amount_incl_cents, status, provider)
       SELECT organization_id, id, 'Qbicle Business november', 17900, 3759, 21659, 'mislukt', 'nep' FROM subscription WHERE organization_id = $1`,
      [ORG2],
    );
    await q.query(`INSERT INTO user_session (user_id, token_hash, expires_at) VALUES ($1, '\\x01', now() + interval '1 day')`, [klantId]);
    admin = await h.login('beheer@qbicle.test', 'beheerder');
    lezer = await h.login('lezer@qbicle.test', 'lezer');
  });
  afterAll(async () => h?.close());

  it('lijst met zoeken en filteren op abonnementsstatus', async () => {
    const all = await (await h.get('/klanten', admin)).text();
    expect(all).toContain('Bakkerij De Korst');
    expect(all).toContain('Van Dijk Advocaten');
    expect(all).toContain('Qbicle MKB');
    expect(all).toContain('1× betaling mislukt');

    const achter = await (await h.get('/klanten?filter=achterstallig', admin)).text();
    expect(achter).toContain('Van Dijk Advocaten');
    expect(achter).not.toContain('Bakkerij De Korst');

    for (const zoek of ['korst', 'dekorst.nl', 'jan@dekorst', '12345678']) {
      const html = await (await h.get(`/klanten?zoek=${encodeURIComponent(zoek)}`, admin)).text();
      expect(html, zoek).toContain('Bakkerij De Korst');
      expect(html, zoek).not.toContain('Van Dijk Advocaten');
    }
  });

  it('detailpagina met tabbladen', async () => {
    expect(await (await h.get(`/klanten/${ORG}`, admin)).text()).toContain('Factuurgegevens');
    expect(await (await h.get(`/klanten/${ORG}?tab=gebruikers`, admin)).text()).toContain('jan@dekorst.nl');
    expect(await (await h.get(`/klanten/${ORG}?tab=domeinen`, admin)).text()).toContain('dekorst.nl');
    expect(await (await h.get(`/klanten/${ORG2}?tab=facturatie`, admin)).text()).toContain('Qbicle Business november');
    expect((await h.get('/klanten/33333333-3333-4333-8333-333333333333', admin)).status).toBe(404);
    expect((await h.get('/klanten/geen-id', admin)).status).toBe(404);
  });

  it('notities: support en beheerder mogen schrijven, lezer niet; staat in tijdlijn', async () => {
    expect((await h.post(`/api/klanten/${ORG}/notities`, { tekst: 'Belde over factuur, terugbellen vrijdag.' }, lezer)).status).toBe(403);
    expect((await h.post(`/api/klanten/${ORG}/notities`, { tekst: '   ' }, admin)).status).toBe(400);
    expect((await h.post(`/api/klanten/${ORG}/notities`, { tekst: 'Belde over factuur, terugbellen vrijdag.' }, admin)).status).toBe(201);
    const notes = await (await h.get(`/klanten/${ORG}?tab=notities`, lezer)).text();
    expect(notes).toContain('Belde over factuur');
    expect(notes).not.toContain('Notitie toevoegen');
    expect(await (await h.get(`/klanten/${ORG}?tab=tijdlijn`, admin)).text()).toContain('Notitie toegevoegd');
  });

  it('gebruikers: lijst, detail, overal uitloggen, blokkeren en deblokkeren', async () => {
    const list = await (await h.get('/gebruikers?zoek=korst', admin)).text();
    expect(list).toContain('jan@dekorst.nl');
    expect(list).not.toContain('lezer@qbicle.test');
    expect(await (await h.get(`/gebruikers/${klantId}`, admin)).text()).toContain('Bakkerij De Korst');

    expect((await h.post(`/api/gebruikers/${klantId}/uitloggen`, {}, lezer)).status).toBe(403);
    const out = await h.post(`/api/gebruikers/${klantId}/uitloggen`, {}, admin);
    expect(((await out.json()) as { sessiesBeeindigd: number }).sessiesBeeindigd).toBe(1);

    expect((await h.post(`/api/gebruikers/${klantId}/blokkeren`, { reden: '' }, admin)).status).toBe(400);
    expect((await h.post(`/api/gebruikers/${klantId}/blokkeren`, { reden: 'Misbruik gemeld door eigenaar' }, admin)).status).toBe(200);
    const row = (await h.p.pool.query('SELECT disabled_at, disabled_reason FROM app_user WHERE id = $1', [klantId])).rows[0];
    expect(row.disabled_at).not.toBeNull();
    expect(row.disabled_reason).toBe('Misbruik gemeld door eigenaar');
    expect(await (await h.get('/gebruikers?status=geblokkeerd', admin)).text()).toContain('jan@dekorst.nl');
    expect((await h.post(`/api/gebruikers/${klantId}/deblokkeren`, {}, admin)).status).toBe(200);

    // Medewerkers blokkeer je hier niet.
    const staffId = (await h.p.pool.query(`SELECT id FROM app_user WHERE email = 'lezer@qbicle.test'`)).rows[0].id;
    expect((await h.post(`/api/gebruikers/${staffId}/blokkeren`, { reden: 'test' }, admin)).status).toBe(409);

    const log = await h.p.pool.query(`SELECT action, actor FROM audit_log WHERE subject = $1 AND action LIKE 'cockpit.%' ORDER BY id`, [klantId]);
    expect(log.rows.map((r) => r.action)).toEqual(['cockpit.gebruiker_uitgelogd', 'cockpit.gebruiker_geblokkeerd', 'cockpit.gebruiker_gedeblokkeerd']);
    expect(log.rows.every((r) => r.actor.startsWith('medewerker:'))).toBe(true);
  });
});
