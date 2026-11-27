import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  acceptInvitation,
  buildChecklist,
  createOrganization,
  extractToken,
  controleSamenvatting,
  getChecklist,
  getScan,
  inviteMember,
  many,
  one,
  updateTask,
} from '@qbicle/platform';
import { createTestPlatform, hasDb, type TestPlatform } from '../../platform/test/support/db.ts';
import { loginAs } from '../../platform/test/support/users.ts';
import { fakeNet, healthyConfig, type FakeNetConfig } from '../../scanner/test/fake-net.ts';
import { drainQueue, type WorkerContext } from '../src/index.ts';

const D = 'bakkerij-checklist.nl';
const ACTIE = 'dmarc-instellen';

describe('checklist samenvoegen (zonder database)', () => {
  const actie = { key: ACTIE, title: 'Zet DMARC aan', why: 'w', forWho: 'it-partner' as const, weight: 20, level: 'warn' as const, findingCount: 1, assets: [] };
  const task = (over: object) => ({
    action_key: ACTIE, status: 'open', note: null, reason: null, assigned_to: null, assignee_name: null, updated_at: new Date(),
    updated_by_email: null, done_at: null, done_by_email: null, still_seen_at: null, confirmed_at: null, ...over,
  });

  it('zonder vastlegging staat alles open', () => {
    const c = buildChecklist([actie], [], []);
    expect(c.items[0]!.statusLabel).toBe('Nog niet opgepakt');
    expect(c.summary).toMatchObject({ total: 1, done: 0, open: 1 });
  });

  it('afgevinkt telt als gedaan; nog gezien door de scan niet', () => {
    expect(buildChecklist([actie], [task({ status: 'gedaan', done_at: new Date() }) as never], []).summary).toMatchObject({ done: 1, wachtOpScan: 1 });
    const c = buildChecklist([actie], [task({ status: 'gedaan', still_seen_at: new Date() }) as never], []);
    expect(c.items[0]!.statusLabel).toBe('Nog niet opgelost');
    expect(c.summary).toMatchObject({ done: 0, nogNietOpgelost: 1 });
  });

  it('bewust niet telt niet mee in het totaal; bevestigd blijft 90 dagen zichtbaar', () => {
    const now = new Date('2026-12-01T12:00:00Z');
    const old = task({ action_key: 'caa-instellen', status: 'bevestigd', confirmed_at: new Date('2026-08-01T00:00:00Z') });
    const recent = task({ action_key: 'dnssec-aanzetten', status: 'bevestigd', confirmed_at: new Date('2026-11-30T00:00:00Z') });
    const c = buildChecklist([actie], [task({ status: 'genegeerd', reason: 'Geen mail' }), old, recent] as never, [], now);
    expect(c.items.map((i) => i.key)).toEqual([ACTIE, 'dnssec-aanzetten']);
    expect(c.summary).toMatchObject({ total: 1, done: 1, bevestigd: 1, genegeerd: 1 });
  });
});

describe('samenvatting van controles', () => {
  it('telt alleen echt uitgevoerde controles en hun bevindingen', () => {
    const c = (uitkomst: 'ok' | 'finding' | 'unknown' | 'not_applicable', bevindingen = 0) => ({ key: 'k', titel: 't', groep: 'e-mail', asset: 'a', uitkomst, bevindingen });
    expect(controleSamenvatting([c('ok'), c('finding', 2), c('unknown'), c('not_applicable')])).toEqual({ uitgevoerd: 2, bevindingen: 2, nietGelukt: 1 });
  });
});

describe.skipIf(!hasDb)('checklist en scans', () => {
  let p: TestPlatform;
  let eigenaar: Awaited<ReturnType<typeof loginAs>>;
  let lezer: Awaited<ReturnType<typeof loginAs>>;
  let org: string;
  let domain: string;
  let cfg: FakeNetConfig;
  const ctx = (): WorkerContext => ({ pool: p.pool, net: fakeNet(cfg), workerId: 'test-worker', timeoutMinutes: 1 });
  const scan = async () => {
    await p.pool.query(`INSERT INTO scan (domain_id, trigger) VALUES ($1, 'handmatig')`, [domain]);
    expect(await drainQueue(ctx())).toEqual({ klaar: 1, mislukt: 0 });
  };
  const item = async () => (await getChecklist(p, eigenaar.userId, org)).items.find((i) => i.key === ACTIE);

  beforeAll(async () => {
    p = await createTestPlatform();
    eigenaar = await loginAs(p, 'eigenaar@checklist.nl');
    lezer = await loginAs(p, 'lezer@checklist.nl');
  });
  afterAll(async () => p?.close());
  beforeEach(async () => {
    await p.pool.query('TRUNCATE scan, worker_heartbeat CASCADE');
    org = (await createOrganization(p, eigenaar, { name: `Bakkerij ${Math.random()}`, kind: 'klant' })).id;
    await inviteMember(p, eigenaar, org, { email: lezer.email, role: 'lezer' });
    await acceptInvitation(p, lezer, extractToken(p.mailer.last(lezer.email)!.text, 'qbu_')!);
    await p.pool.query(`DELETE FROM domain WHERE name = $1`, [D]);
    domain = (await one<{ id: string }>(
      p.pool,
      `INSERT INTO domain (organization_id, name, verified_at, verification_method, verification_token) VALUES ($1, $2, now(), 'dns-txt', 'qbicle-test') RETURNING id`,
      [org, D],
    ))!.id;
    cfg = healthyConfig(D);
    cfg.txt![`_dmarc.${D}`] = [];
  });

  it('afvinken, scan ziet het nog, oplossen, bevestigd, en terug = weer open; alles in het logboek', async () => {
    await scan();
    expect((await item())?.status).toBe('open');

    await updateTask(p, eigenaar, org, ACTIE, { status: 'gedaan', note: 'DNS-regel gezet bij TransIP', assignedTo: 'it-partner', assigneeName: 'Jan van IT' });
    let i = (await item())!;
    expect(i.status).toBe('gedaan');
    expect(i.doneBy).toBe(eigenaar.email);
    expect(i.assigneeName).toBe('Jan van IT');

    // De scan ziet de bevinding nog: "Nog niet opgelost".
    await scan();
    i = (await item())!;
    expect(i.nogNietOpgelost).toBe(true);
    expect(i.statusLabel).toBe('Nog niet opgelost');

    // Echt opgelost: de scan bevestigt.
    cfg = healthyConfig(D);
    await scan();
    i = (await item())!;
    expect(i.status).toBe('bevestigd');
    expect(i.statusLabel).toBe('Bevestigd door scan');
    expect(i.confirmedAt).not.toBeNull();
    const c = await getChecklist(p, eigenaar.userId, org);
    expect(c.summary.bevestigd).toBeGreaterThanOrEqual(1);

    // Komt terug: weer open.
    cfg.txt![`_dmarc.${D}`] = [];
    await scan();
    expect((await item())!.status).toBe('open');

    const log = await many<{ kind: string; to_status: string | null; actor_user_id: string | null }>(
      p.pool, 'SELECT kind, to_status, actor_user_id FROM action_task_log WHERE organization_id = $1 AND action_key = $2 ORDER BY at', [org, ACTIE]);
    expect(log.map((l) => `${l.kind}:${l.to_status ?? ''}`)).toEqual([
      'status:gedaan', 'notitie:', 'toewijzing:', 'scan:gedaan', 'scan:bevestigd', 'scan:open',
    ]);
    expect(log.filter((l) => l.kind === 'scan').every((l) => l.actor_user_id === null)).toBe(true);
  });

  it('afvinken tijdens een lopende scan geeft geen onterecht "nog niet opgelost"', async () => {
    await scan();
    // Scan begint vóór het afvinken.
    await p.pool.query(`INSERT INTO scan (domain_id, trigger) VALUES ($1, 'handmatig')`, [domain]);
    await updateTask(p, eigenaar, org, ACTIE, { status: 'gedaan' });
    await p.pool.query(`UPDATE action_task SET done_at = now() + interval '1 minute' WHERE organization_id = $1`, [org]);
    await drainQueue(ctx());
    expect((await item())!.nogNietOpgelost).toBe(false);
  });

  it('scan legt elke controle met uitslag vast voor de voortgangsweergave', async () => {
    await scan();
    const id = (await one<{ id: string }>(p.pool, 'SELECT id FROM scan ORDER BY created_at DESC LIMIT 1'))!.id;
    const s = await getScan(p, eigenaar.userId, org, id);
    expect(s.controles.length).toBeGreaterThan(5);
    const dmarc = s.controles.find((c) => c.key === 'mail.dmarc')!;
    expect(dmarc).toMatchObject({ groep: 'e-mail', asset: D, uitkomst: 'finding', bevindingen: 1 });
    expect(s.samenvatting!.bevindingen).toBeGreaterThanOrEqual(1);
    expect(s.samenvatting!.uitgevoerd).toBeLessThanOrEqual(s.controles.length);
    expect(s.steps.every((st) => st.bezig.startsWith('We controleren'))).toBe(true);
  });

  it('zonder afvinken opgelost = toch bevestigd door scan', async () => {
    await scan();
    cfg = healthyConfig(D);
    await scan();
    expect((await item())?.status).toBe('bevestigd');
  });

  it('bewust niet vraagt een reden; een lezer mag niets wijzigen', async () => {
    await scan();
    await expect(updateTask(p, eigenaar, org, ACTIE, { status: 'genegeerd' })).rejects.toThrow(/waarom/);
    await updateTask(p, eigenaar, org, ACTIE, { status: 'genegeerd', reason: 'We mailen niet vanaf dit domein' });
    expect((await item())!.reason).toBe('We mailen niet vanaf dit domein');
    expect((await getChecklist(p, lezer.userId, org)).magBijwerken).toBe(false);
    await expect(updateTask(p, lezer, org, ACTIE, { status: 'gedaan' })).rejects.toThrow(/geen toestemming/);
    await expect(updateTask(p, eigenaar, org, 'bestaat-niet', { status: 'gedaan' })).rejects.toThrow(/bestaat niet/);
  });
});
