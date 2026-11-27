import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryMailer, many, one } from '@qbicle/platform';
import { healthSummary, loadUsageConfig } from '@qbicle/ops';
import { scanDomain } from '@qbicle/scanner';
import { createTestPlatform, hasDb, type TestPlatform } from '../../platform/test/support/db.ts';
import { fakeNet, healthyConfig, type FakeNetConfig } from '../../scanner/test/fake-net.ts';
import { claimNextScan, drainQueue, planScans, runScanJob, type WorkerContext } from '../src/index.ts';

const D = 'drukkerij-eva.nl';

describe.skipIf(!hasDb)('scan-worker', () => {
  let p: TestPlatform;
  let org: string;
  let domain: string;
  let cfg: FakeNetConfig;

  const ctx = (over: Partial<WorkerContext> = {}): WorkerContext => ({
    pool: p.pool,
    net: fakeNet(cfg),
    workerId: 'test-worker',
    timeoutMinutes: 1,
    ...over,
  });
  const queue = async () => {
    await p.pool.query(`INSERT INTO scan (domain_id, trigger) VALUES ($1, 'handmatig')`, [domain]);
  };
  const open = () =>
    many<{ finding_key: string; resolved_at: Date | null }>(
      p.pool,
      `SELECT f.finding_key, f.resolved_at FROM finding f JOIN asset a ON a.id = f.asset_id
        WHERE a.organization_id = $1 AND f.resolved_at IS NULL ORDER BY f.finding_key`,
      [org],
    );

  beforeAll(async () => {
    p = await createTestPlatform();
  });
  afterAll(async () => {
    await p?.close();
  });
  beforeEach(async () => {
    await p.pool.query('TRUNCATE organization, scan_opt_out, system_error, worker_heartbeat, vuln CASCADE');
    org = (await one<{ id: string }>(p.pool, `INSERT INTO organization (name, kind) VALUES ('Drukkerij Eva', 'klant') RETURNING id`))!.id;
    domain = (await one<{ id: string }>(
      p.pool,
      `INSERT INTO domain (organization_id, name, verified_at, verification_method, verification_token) VALUES ($1, $2, now(), 'dns-txt', 'qbicle-test') RETURNING id`,
      [org, D],
    ))!.id;
    cfg = healthyConfig(D);
    cfg.txt![`_dmarc.${D}`] = [];
  });

  it('eerste scan van een bevestigd domein slaat assets, checks, bevindingen en score op', async () => {
    const planned = await planScans(p.pool);
    expect(planned).toEqual([expect.objectContaining({ domain: D, reason: 'eerste' })]);
    expect(await drainQueue(ctx())).toEqual({ klaar: 1, mislukt: 0 });

    const scan = await one<{ id: string; status: string; scanner_version: string }>(p.pool, 'SELECT id, status, scanner_version FROM scan');
    expect(scan!.status).toBe('klaar');
    expect(scan!.scanner_version).toBeTruthy();
    const assets = await many<{ type: string; value: string; exposure: string; domain_id: string }>(
      p.pool, 'SELECT type, value, exposure, domain_id FROM asset WHERE organization_id = $1 ORDER BY type', [org]);
    expect(assets.map((a) => `${a.type}:${a.value}`)).toEqual([`domein:${D}`, `website:https://${D}`]);
    expect(assets.every((a) => a.exposure === 'internet' && a.domain_id === domain)).toBe(true);
    expect(Number((await one<{ n: string }>(p.pool, 'SELECT count(*) AS n FROM check_run WHERE scan_id = $1', [scan!.id]))!.n)).toBeGreaterThan(5);
    expect((await open()).map((f) => f.finding_key)).toContain('dmarc.missing');
    const snap = await one<{ urgency: number }>(p.pool, 'SELECT urgency FROM score_snapshot WHERE scan_id = $1', [scan!.id]);
    expect(snap!.urgency).toBeGreaterThan(0);
    // Hartslag voor de cockpit.
    expect(await one(p.pool, `SELECT scans_klaar FROM worker_heartbeat WHERE worker_id = 'test-worker'`)).toEqual({ scans_klaar: 1 });
  });

  it('slaat per bevinding de eigenaar en het platform op (Wix)', async () => {
    cfg.http![`https://${D}/`] = { status: 200, headers: { 'strict-transport-security': 'max-age=31536000', 'x-wix-request-id': '1' } };
    await queue();
    await drainQueue(ctx());
    const rows = await many<{ finding_key: string; owner: string | null; platform: string | null }>(
      p.pool, 'SELECT finding_key, owner, platform FROM finding ORDER BY finding_key');
    expect(rows.find((r) => r.finding_key === 'web.csp_missing')).toMatchObject({ owner: 'platform', platform: 'Wix' });
    expect(rows.find((r) => r.finding_key === 'dmarc.missing')).toMatchObject({ owner: 'zelf', platform: null });
  });

  it('dezelfde bevinding twee keer is één rij; opgelost als de check hem niet meer ziet; terug is een nieuwe rij', async () => {
    await queue();
    await drainQueue(ctx());
    await queue();
    await drainQueue(ctx());
    const rows = () => many<{ id: string; first_seen: Date; last_seen: Date; resolved_at: Date | null; resolved_scan_id: string | null }>(
      p.pool, `SELECT id, first_seen, last_seen, resolved_at, resolved_scan_id FROM finding WHERE finding_key = 'dmarc.missing' ORDER BY first_seen`);
    let r = await rows();
    expect(r).toHaveLength(1);
    expect(r[0]!.last_seen.getTime()).toBeGreaterThan(r[0]!.first_seen.getTime() - 1);

    cfg = healthyConfig(D); // DMARC staat er nu
    await queue();
    await drainQueue(ctx());
    r = await rows();
    expect(r).toHaveLength(1);
    expect(r[0]!.resolved_at).not.toBeNull();
    expect(r[0]!.resolved_scan_id).not.toBeNull();
    expect(await open()).toEqual([]);

    cfg.txt![`_dmarc.${D}`] = [];
    await queue();
    await drainQueue(ctx());
    r = await rows();
    expect(r).toHaveLength(2);
    expect(r[0]!.resolved_at).not.toBeNull();
    expect(r[1]!.resolved_at).toBeNull();
  });

  it('kon een check niet draaien, dan blijft de bevinding open (nooit stilzwijgend opgelost)', async () => {
    await queue();
    await drainQueue(ctx());
    expect((await open()).map((f) => f.finding_key)).toContain('dmarc.missing');
    cfg.txt![`_dmarc.${D}`] = Object.assign(new Error('SERVFAIL'), { code: 'ESERVFAIL' });
    await queue();
    await drainQueue(ctx());
    expect((await open()).map((f) => f.finding_key)).toContain('dmarc.missing');
  });

  it('website die weg is wordt verdwenen; een geaccepteerde bevinding blijft geaccepteerd', async () => {
    cfg.addresses![`www.${D}`] = ['203.0.114.11'];
    cfg.tls![`www.${D}`] = cfg.tls![D]!;
    await queue();
    await drainQueue(ctx());
    await p.pool.query(`UPDATE finding SET accepted_at = now() WHERE finding_key = 'dmarc.missing'`);
    cfg.addresses![`www.${D}`] = [];
    await queue();
    await drainQueue(ctx());
    const www = await one<{ status: string }>(p.pool, `SELECT status FROM asset WHERE value = $1`, [`https://www.${D}`]);
    expect(www!.status).toBe('verdwenen');
    const f = await one<{ accepted_at: Date | null; resolved_at: Date | null }>(
      p.pool, `SELECT accepted_at, resolved_at FROM finding WHERE finding_key = 'dmarc.missing'`);
    expect(f!.accepted_at).not.toBeNull();
    expect(f!.resolved_at).toBeNull();
  });

  it('scant niet als het domein niet meer bevestigd is of op de opt-outlijst staat', async () => {
    await queue();
    await p.pool.query('UPDATE domain SET verified_at = NULL, verification_method = NULL');
    expect(await drainQueue(ctx())).toEqual({ klaar: 0, mislukt: 1 });
    const s = await one<{ status: string; error: string }>(p.pool, 'SELECT status, error FROM scan');
    expect(s!.error).toMatch(/niet \(meer\) bevestigd/);
    expect(await many(p.pool, 'SELECT 1 FROM asset')).toEqual([]);
    // Geen storing van Qbicle: geen fout in de cockpit.
    expect(await many(p.pool, 'SELECT 1 FROM system_error')).toEqual([]);

    await p.pool.query("UPDATE domain SET verified_at = now(), verification_method = 'dns-txt'");
    await p.pool.query('INSERT INTO scan_opt_out (name) VALUES ($1)', [D]);
    expect(await planScans(p.pool)).toEqual([]);
  });

  it('onverwachte fout: scan mislukt, fout in de cockpit, opnieuw na 6 uur, maximaal 3 keer', async () => {
    const broken = (async () => {
      throw new Error('kapot');
    }) as unknown as typeof scanDomain;
    await planScans(p.pool);
    expect(await drainQueue(ctx({ scan: broken }))).toEqual({ klaar: 0, mislukt: 1 });
    const e = await one<{ source: string; organization_id: string }>(p.pool, 'SELECT source, organization_id FROM system_error');
    expect(e).toEqual({ source: 'scanner', organization_id: org });

    expect(await planScans(p.pool)).toEqual([]); // te snel
    const later = (h: number) => new Date(Date.now() + h * 3600_000);
    expect(await planScans(p.pool, undefined, later(7))).toEqual([expect.objectContaining({ reason: 'na-fout' })]);
    await drainQueue(ctx({ scan: broken }));
    expect(await planScans(p.pool, undefined, later(7))).toHaveLength(1);
    await drainQueue(ctx({ scan: broken }));
    // Drie keer achter elkaar mislukt: wachten op een mens.
    expect(await planScans(p.pool, undefined, later(30))).toEqual([]);
  });

  it('time-out: een scan die te lang duurt wordt afgebroken en mislukt', async () => {
    const hang = (() => new Promise(() => {})) as unknown as typeof scanDomain;
    await queue();
    const r = await runScanJob(ctx({ scan: hang, timeoutMinutes: 0.001 }), (await claimNextScan(p.pool, 'test-worker'))!);
    expect(r).toEqual({ status: 'mislukt', error: expect.stringMatching(/afgebroken/) });
  });

  it('periodiek opnieuw alleen met abonnement en als de laatste scan ouder is dan het interval', async () => {
    await queue();
    await drainQueue(ctx());
    const in8d = new Date(Date.now() + 8 * 86400_000);
    expect(await planScans(p.pool, undefined, in8d)).toEqual([]); // geen abonnement
    await p.pool.query(
      `INSERT INTO subscription (organization_id, plan, billing_interval, monthly_price_cents, status)
       VALUES ($1, 'mkb', 'jaar', 4900, 'actief')`,
      [org],
    );
    expect(await planScans(p.pool, undefined, new Date(Date.now() + 86400_000))).toEqual([]); // nog vers
    expect(await planScans(p.pool, undefined, in8d)).toEqual([expect.objectContaining({ reason: 'periodiek' })]);
    expect(await planScans(p.pool, undefined, in8d)).toEqual([]); // staat al in de wachtrij
  });

  it('mailt eigenaren na de eerste geslaagde scan, niet na de volgende', async () => {
    const u = (await one<{ id: string }>(p.pool, `INSERT INTO app_user (email) VALUES ('eva@drukkerij-eva.nl') RETURNING id`))!.id;
    await p.pool.query(`INSERT INTO membership (organization_id, user_id, role) VALUES ($1, $2, 'eigenaar')`, [org, u]);
    const mailer = new MemoryMailer();
    await queue();
    await drainQueue(ctx({ mailer, appOrigin: 'https://app.qbicle.test' }));
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]!.subject).toBe(`De eerste scan van ${D} is klaar`);
    expect(mailer.sent[0]!.text).toContain(`https://app.qbicle.test/o/${org}/overzicht`);
    await queue();
    await drainQueue(ctx({ mailer }));
    expect(mailer.sent).toHaveLength(1);
  });

  it('cockpit-gezondheid: storing als er scans wachten en geen worker draait', async () => {
    const ops = { pool: p.pool, config: loadUsageConfig() };
    await queue();
    let h = await healthSummary(ops);
    expect(h.scans.workersActief).toBe(0);
    expect(h.oordeel).toBe('storing');
    expect(h.redenen.join(' ')).toMatch(/geen scan-worker/);
    await drainQueue(ctx());
    h = await healthSummary(ops);
    expect(h.scans.workersActief).toBe(1);
    expect(h.redenen.join(' ')).not.toMatch(/scan-worker/);
  });

  it('een scan die de Bewaker intussen opnieuw in de wachtrij zette, wordt niet dubbel opgeslagen', async () => {
    await queue();
    const job = (await claimNextScan(p.pool, 'test-worker'))!;
    await p.pool.query(`UPDATE scan SET status = 'wachtrij', claimed_by = NULL WHERE id = $1`, [job.id]);
    expect(await runScanJob(ctx(), job)).toEqual({ status: 'overgeslagen' });
    expect(await many(p.pool, 'SELECT 1 FROM finding')).toEqual([]);
    expect((await one<{ status: string }>(p.pool, 'SELECT status FROM scan'))!.status).toBe('wachtrij');
  });
});
