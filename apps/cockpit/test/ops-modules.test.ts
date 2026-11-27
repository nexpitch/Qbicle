import { SecretBox } from '@qbicle/devices';
import { ensureAgent, loadUsageConfig, propose, recordAiCall, type OpsContext } from '@qbicle/ops';
import { extractToken, SYSTEM_ACTOR } from '@qbicle/platform';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestPlatform, hasDb, type TestPlatform } from '../../../packages/platform/test/support/db.ts';
import { createCockpit } from '../src/app.tsx';
import type { StaffRole } from '../src/core/roles.ts';
import { addStaff, DEFAULT_COCKPIT_CONFIG, type Cockpit } from '../src/core/staff.ts';
import { stepAt, totpCode } from '../src/core/totp.ts';

const ORIGIN = 'https://cockpit.qbicle.test';
const SYS = { ...SYSTEM_ACTOR, kind: 'medewerker' as const };

describe.skipIf(!hasDb)('cockpit: gebruik, gezondheid, support en agents', () => {
  let p: TestPlatform;
  let cockpit: Cockpit;
  let app: ReturnType<typeof createCockpit>;
  let ops: OpsContext;
  let orgId: string;
  const agent = { kind: 'agent' as const, agentKey: 'test-agent' };

  beforeAll(async () => {
    p = await createTestPlatform();
    cockpit = {
      p,
      config: { ...DEFAULT_COCKPIT_CONFIG, origin: ORIGIN },
      box: new SecretBox({ currentId: 'test', keys: new Map([['test', Buffer.alloc(32, 7)]]) }),
    };
    app = createCockpit(cockpit, { secureCookies: true, trustProxy: false });
    ops = { pool: p.pool, config: loadUsageConfig(), mailer: p.mailer };
    orgId = (await p.pool.query("INSERT INTO organization (name, kind) VALUES ('Garage De Vries', 'klant') RETURNING id")).rows[0].id;
    const u = (await p.pool.query("INSERT INTO app_user (email) VALUES ('piet@devries.nl') RETURNING id")).rows[0].id;
    await p.pool.query("INSERT INTO membership (organization_id, user_id, role) VALUES ($1, $2, 'eigenaar')", [orgId, u]);
    const d = (await p.pool.query("INSERT INTO domain (organization_id, name, verification_token) VALUES ($1, 'devries.nl', 'x') RETURNING id", [orgId])).rows[0].id;
    await p.pool.query("INSERT INTO scan (domain_id, trigger, status, started_at) VALUES ($1, 'handmatig', 'bezig', now() - interval '2 hours')", [d]);
    await recordAiCall(ops, { organizationId: orgId, feature: 'samenvatting', model: 'claude-opus-5-5', usage: { input_tokens: 12000, output_tokens: 800 } });
    await ensureAgent(p.pool, { key: 'test-agent', name: 'Testagent', description: 'Voor tests' });
  });
  afterAll(async () => p?.close());

  const post = (path: string, body: unknown, cookie?: string) =>
    app.request(path, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
  const get = (path: string, cookie?: string) => app.request(path, cookie ? { headers: { cookie } } : undefined);
  const cookieOf = (res: Response) => res.headers.get('set-cookie')!.split(';')[0]!;

  async function login(email: string, role: StaffRole): Promise<string> {
    await addStaff(cockpit, email, role, SYS);
    await post('/api/inloglink', { email });
    const half = cookieOf(await post('/api/inloggen', { token: extractToken(p.mailer.last(email)!.text, 'qcl_')! }));
    await get('/mfa', half);
    const r = await p.pool.query('SELECT m.user_id, m.totp_secret_sealed FROM staff_member m JOIN app_user u ON u.id = m.user_id WHERE u.email = $1', [email]);
    const secret = cockpit.box.open(r.rows[0].totp_secret_sealed, { organizationId: 'qbicle-cockpit', sourceId: `totp:${r.rows[0].user_id}` });
    return cookieOf(await post('/api/mfa', { code: totpCode(secret, stepAt(Date.now())) }, half));
  }

  it('pagina’s tonen gebruik, gezondheid en support met klantcontext', async () => {
    const c = await login('lezer@qbicle.test', 'lezer');
    const gebruik = await (await get('/gebruik', c)).text();
    expect(gebruik).toContain('Garage De Vries');
    expect(gebruik).toContain('samenvatting');
    expect(gebruik).not.toContain('Dit onderdeel wordt nu gebouwd');
    expect((await get(`/gebruik/${orgId}`, c)).status).toBe(200);
    expect((await get('/gebruik/niet-een-id', c)).status).toBe(404);
    const gz = await (await get('/gezondheid', c)).text();
    expect(gz).toContain('devries.nl');
    expect(gz).toContain('Vast');
    for (const t of ['fouten', 'mail']) expect((await get(`/gezondheid?tab=${t}`, c)).status).toBe(200);
    // Lezer mag niets wijzigen.
    expect((await post('/api/support', { email: 'piet@devries.nl', onderwerp: 'x', bericht: 'x' }, c)).status).toBe(403);
  });

  it('support: ticket aanmaken, antwoorden mailt de klant, notitie niet', async () => {
    const c = await login('support@qbicle.test', 'support');
    const res = await post('/api/support', { email: 'piet@devries.nl', onderwerp: 'Scan hangt', bericht: 'Mijn scan loopt al uren' }, c);
    expect(res.status).toBe(201);
    const { ticket } = (await res.json()) as { ticket: string };
    const page = await (await get(`/support/${ticket}`, c)).text();
    expect(page).toContain('Garage De Vries');
    expect(page).toContain('devries.nl');
    const before = p.mailer.sent.length;
    expect((await post(`/api/support/${ticket}/bericht`, { bericht: 'Interne check', soort: 'notitie' }, c)).status).toBe(200);
    expect(p.mailer.sent.length).toBe(before);
    expect((await post(`/api/support/${ticket}/bericht`, { bericht: 'We kijken ernaar', soort: 'antwoord' }, c)).status).toBe(200);
    expect(p.mailer.last('piet@devries.nl')!.subject).toContain('Scan hangt');
    expect((await post(`/api/support/${ticket}`, { status: 'opgelost', toewijzen: 'mij' }, c)).status).toBe(200);
    expect(await (await get('/support?status=opgelost', c)).text()).toContain('Scan hangt');
  });

  it('agents: rol bepaalt wie goedkeurt; goedkeuren voert direct uit', async () => {
    const sup = await login('sup2@qbicle.test', 'support');
    const fin = await login('fin@qbicle.test', 'financieel');
    const { proposal } = await propose(ops, agent, {
      kind: 'limiet.aanpassen',
      title: 'Meer scans voor Garage De Vries',
      rationale: 'Klant heeft 12 vestigingen',
      payload: { metric: 'scans_maand', limit: 100, reason: 'Maatwerk' },
      organizationId: orgId,
    });
    const page = await (await get('/agents', sup)).text();
    expect(page).toContain('Meer scans voor Garage De Vries');
    expect(page).toContain('kan dit goedkeuren');
    expect((await post(`/api/agents/voorstellen/${proposal.id}`, { besluit: 'goedkeuren' }, sup)).status).toBe(403);
    expect(await (await get('/agents', fin)).text()).toContain('Goedkeuren en uitvoeren');
    const ok = await post(`/api/agents/voorstellen/${proposal.id}`, { besluit: 'goedkeuren', toelichting: 'Akkoord' }, fin);
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { status: string }).status).toBe('uitgevoerd');
    expect(await (await get(`/gebruik/${orgId}`, fin)).text()).toContain('maatwerk');
    for (const t of ['agents', 'geschiedenis', 'activiteit']) expect((await get(`/agents?tab=${t}`, fin)).status).toBe(200);
  });

  it('noodrem en Bewaker alleen voor beheerders', async () => {
    const fin = await login('fin2@qbicle.test', 'financieel');
    const admin = await login('admin@qbicle.test', 'beheerder');
    expect((await post('/api/agents/test-agent/pauzeren', {}, fin)).status).toBe(403);
    expect((await post('/api/agents/test-agent/pauzeren', { reden: 'Test' }, admin)).status).toBe(200);
    expect(await (await get('/agents?tab=agents', admin)).text()).toContain('Gepauzeerd');
    expect((await post('/api/agents/test-agent/hervatten', {}, admin)).status).toBe(200);
    const r = await post('/api/agents/bewaker/ronde', {}, admin);
    expect(r.status).toBe(200);
    expect(((await r.json()) as { stats: { scansOpnieuw: number } }).stats.scansOpnieuw).toBe(1);
  });
});
