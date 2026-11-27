import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasDb } from '../../../packages/platform/test/support/db.ts';
import { suggest } from '../src/core/followups.ts';
import { cockpitHarness } from './support.ts';

describe('vervolgvoorstel bij mislukte incasso', () => {
  it('kiest de actie die bij de reden past', () => {
    expect(suggest({ failure_reason: 'geen_dekking', failures: 1 }).action).toBe('herpoging');
    expect(suggest({ failure_reason: 'geen_dekking', failures: 2 }).action).toBe('factuur_sturen');
    expect(suggest({ failure_reason: 'storno', failures: 1 }).action).toBe('klant_mailen');
    expect(suggest({ failure_reason: 'mandaat_ingetrokken', failures: 1 }).action).toBe('factuur_sturen');
    expect(suggest({ failure_reason: 'rekening_opgeheven', failures: 1 }).action).toBe('factuur_sturen');
    expect(suggest({ failure_reason: 'geen_dekking', failures: 3 }).action).toBe('bellen');
  });
});

describe.skipIf(!hasDb)('cockpit: mislukte incasso opvolgen', () => {
  let h: Awaited<ReturnType<typeof cockpitHarness>>;
  let fin: string;
  let support: string;
  const A = '55555555-5555-4555-8555-555555555555';
  const B = '66666666-6666-4666-8666-666666666666';
  const C = '77777777-7777-4777-8777-777777777777';
  const today = () => new Date().toISOString().slice(0, 10);
  const followups = async () =>
    (await h.p.pool.query('SELECT f.id, f.organization_id, f.suggested_action, f.status, f.mail_body FROM collection_followup f')).rows as Array<{
      id: string;
      organization_id: string;
      suggested_action: string;
      status: string;
      mail_body: string | null;
    }>;
  const of = async (org: string) => (await followups()).find((f) => f.organization_id === org)!;

  beforeAll(async () => {
    h = await cockpitHarness();
    const q = h.p.pool;
    await q.query(
      `INSERT INTO organization (id, name, kind, payment_method, billing_email) VALUES
        ($1, 'Bakkerij De Korst', 'klant', 'incasso', 'admin@korst.test'),
        ($2, 'Van Dijk Advocaten', 'klant', 'incasso', 'fin@vandijk.test'),
        ($3, 'Fietsen Smit', 'klant', 'incasso', 'info@smit.test')`,
      [A, B, C],
    );
    await q.query(
      `INSERT INTO subscription (organization_id, plan, billing_interval, monthly_price_cents, status, current_period_start, current_period_end)
       SELECT id, 'mkb', 'maand', 5900, 'actief', now() - interval '1 month', now() - interval '1 hour' FROM organization WHERE id = ANY($1)`,
      [[A, B, C]],
    );
    const admin = await h.login('beheer@qbicle.test', 'beheerder');
    fin = await h.login('fin@qbicle.test', 'financieel');
    support = await h.login('support@qbicle.test', 'support');
    const run = ((await (await h.post('/api/incasso', { incassodatum: today() }, fin)).json()) as { batch: string }).batch;
    expect((await h.post(`/api/incasso/${run}/valideren`, {}, fin)).status).toBe(200);
    expect((await h.post(`/api/incasso/${run}/indienen`, {}, admin)).status).toBe(200);
    const items = (await q.query('SELECT id, organization_id FROM collection_item WHERE run_id = $1', [run])).rows as Array<{ id: string; organization_id: string }>;
    const reden: Record<string, string> = { [A]: 'geen_dekking', [B]: 'storno', [C]: 'mandaat_ingetrokken' };
    for (const it of items) {
      const r = await h.post(`/api/incasso/regels/${it.id}/testuitkomst`, { uitkomst: 'mislukt', reden: reden[it.organization_id] }, fin);
      expect(r.status).toBe(200);
    }
  });
  afterAll(async () => h?.close());

  it('zet bij elke mislukte incasso meteen een voorstel met conceptmail klaar', async () => {
    const fs = await followups();
    expect(fs).toHaveLength(3);
    expect((await of(A)).suggested_action).toBe('herpoging');
    expect((await of(B)).suggested_action).toBe('klant_mailen');
    expect((await of(C)).suggested_action).toBe('factuur_sturen');
    expect((await of(C)).mail_body).toContain('{betaallink}');
    expect(fs.every((f) => f.status === 'voorgesteld')).toBe(true);

    const page = await (await h.get('/incasso/mislukt', support)).text();
    expect(page).toContain('Bakkerij De Korst');
    expect(page).toContain('Voorstel agent');
    expect(page).toContain('Mislukt · 3 te doen');
    // Lezen mag, uitvoeren niet.
    expect(page).not.toContain('versturen</button>');
    const f = await of(B);
    expect((await h.post(`/api/incasso/vervolg/${f.id}/uitvoeren`, { actie: 'bellen', notitie: 'x' }, support)).status).toBe(403);
  });

  it('betaalverzoek: vraagt om {betaallink}, mailt met de echte link, en maar één keer', async () => {
    const f = await of(C);
    const sent = () => h.p.mailer.sent.filter((m) => m.to === 'info@smit.test');
    expect((await h.post(`/api/incasso/vervolg/${f.id}/uitvoeren`, { actie: 'factuur_sturen', onderwerp: 'Betaal', tekst: 'Graag betalen.' }, fin)).status).toBe(400);
    const res = await h.post(`/api/incasso/vervolg/${f.id}/uitvoeren`, { actie: 'factuur_sturen', onderwerp: 'Betaalverzoek', tekst: f.mail_body }, fin);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { betaling: string; gemaildAan: string };
    expect(body.gemaildAan).toBe('info@smit.test');
    expect(sent()).toHaveLength(1);
    expect(sent()[0]!.text).toContain(`/betalen/test/${body.betaling}`);
    expect(sent()[0]!.text).not.toContain('{betaallink}');
    expect((await h.post(`/api/incasso/vervolg/${f.id}/uitvoeren`, { actie: 'factuur_sturen', onderwerp: 'B', tekst: f.mail_body }, fin)).status).toBe(409);
    expect(sent()).toHaveLength(1);

    // Testmodus: de klant betaalt.
    const t = await h.post(`/api/incasso/vervolg/${f.id}/testuitkomst`, { uitkomst: 'betaald' }, fin);
    expect(((await t.json()) as { status: string }).status).toBe('betaald');
    expect((await h.p.pool.query('SELECT count(*)::int AS n FROM invoice WHERE organization_id = $1', [C])).rows[0].n).toBe(1);
  });

  it('andere actie kiezen: bellen vraagt om een notitie en mailt niet', async () => {
    const f = await of(A);
    const before = h.p.mailer.sent.length;
    expect((await h.post(`/api/incasso/vervolg/${f.id}/uitvoeren`, { actie: 'bellen' }, fin)).status).toBe(400);
    expect((await h.post(`/api/incasso/vervolg/${f.id}/uitvoeren`, { actie: 'bellen', notitie: 'Betaalt vrijdag via overboeking' }, fin)).status).toBe(200);
    expect(h.p.mailer.sent.length).toBe(before);
    const row = (await h.p.pool.query('SELECT status, chosen_action, decision_note, result_payment_id FROM collection_followup WHERE id = $1', [f.id])).rows[0];
    expect(row).toEqual({ status: 'uitgevoerd', chosen_action: 'bellen', decision_note: 'Betaalt vrijdag via overboeking', result_payment_id: null });
  });

  it('afwijzen vraagt een reden en komt in het audit-log', async () => {
    const f = await of(B);
    expect((await h.post(`/api/incasso/vervolg/${f.id}/afwijzen`, { reden: '' }, fin)).status).toBe(400);
    expect((await h.post(`/api/incasso/vervolg/${f.id}/afwijzen`, { reden: 'Klant heeft al overgemaakt' }, fin)).status).toBe(200);

    const open = await (await h.get('/incasso/mislukt', fin)).text();
    expect(open).toContain('Geen mislukte incasso');
    const done = await (await h.get('/incasso/mislukt?toon=afgehandeld', fin)).text();
    expect(done).toContain('Klant heeft al overgemaakt');
    expect(done).toContain('voorstel was: Opnieuw incasseren');

    const log = (await h.p.pool.query(`SELECT action FROM audit_log WHERE action LIKE 'cockpit.incasso_vervolg%' ORDER BY id`)).rows.map((r) => r.action);
    expect(log).toEqual(['cockpit.incasso_vervolg_uitgevoerd', 'cockpit.incasso_vervolg_mail_verstuurd', 'cockpit.incasso_vervolg_uitgevoerd', 'cockpit.incasso_vervolg_afgewezen']);
  });
});
