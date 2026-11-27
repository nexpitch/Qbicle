import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createOrganization, domainScanInfo, getAssetOplossingen, getRecheck, many, one, requestRecheck } from '@qbicle/platform';
import { CHECKS } from '@qbicle/scanner';
import { HERCONTROLE_CHECKS } from '@qbicle/platform';
import { createTestPlatform, hasDb, type TestPlatform } from '../../platform/test/support/db.ts';
import { loginAs } from '../../platform/test/support/users.ts';
import { fakeNet, healthyConfig, type FakeNetConfig } from '../../scanner/test/fake-net.ts';
import { drainQueue, planScans, type WorkerContext } from '../src/index.ts';

const D = 'bloemist-hercontrole.nl';

it('elke check die we los kunnen controleren bestaat in de scanner', () => {
  const keys = new Set(CHECKS.map((c) => c.key));
  for (const k of HERCONTROLE_CHECKS) expect(keys.has(k), k).toBe(true);
});

describe.skipIf(!hasDb)('hercontrole van één bevinding', () => {
  let p: TestPlatform;
  let user: Awaited<ReturnType<typeof loginAs>>;
  let org: string;
  let domain: string;
  let cfg: FakeNetConfig;

  const ctx = (): WorkerContext => ({ pool: p.pool, net: fakeNet(cfg), workerId: 'test-worker', timeoutMinutes: 1 });
  const dmarc = () =>
    one<{ id: string; asset_id: string; resolved_at: Date | null }>(
      p.pool,
      `SELECT f.id, f.asset_id, f.resolved_at FROM finding f JOIN asset a ON a.id = f.asset_id
        WHERE a.organization_id = $1 AND f.finding_key = 'dmarc.missing' ORDER BY f.first_seen DESC LIMIT 1`,
      [org],
    );
  /** De afkoeltijd tussen twee hercontroles overslaan. */
  const ouder = () => p.pool.query("UPDATE scan SET created_at = created_at - interval '5 minutes' WHERE finding_id IS NOT NULL");

  beforeAll(async () => {
    p = await createTestPlatform();
    user = await loginAs(p, 'iris@bloemist.nl');
  });
  afterAll(async () => p?.close());
  beforeEach(async () => {
    await p.pool.query('TRUNCATE organization, scan_opt_out, worker_heartbeat, rate_limit_hit CASCADE');
    org = (await createOrganization(p, user, { name: 'Bloemist', kind: 'klant' })).id;
    domain = (await one<{ id: string }>(
      p.pool,
      `INSERT INTO domain (organization_id, name, verified_at, verification_method, verification_token) VALUES ($1, $2, now(), 'dns-txt', 'x') RETURNING id`,
      [org, D],
    ))!.id;
    cfg = healthyConfig(D);
    cfg.txt![`_dmarc.${D}`] = [];
    await p.pool.query(`INSERT INTO scan (domain_id, trigger) VALUES ($1, 'handmatig')`, [domain]);
    await drainQueue(ctx());
  });

  it('draait alleen die check, lost op als hij goed staat en telt niet als volledige scan', async () => {
    const f = (await dmarc())!;
    expect(f.resolved_at).toBeNull();
    const voor = await domainScanInfo(p, user.userId, org);

    // Nog niet aangepast: de controle draait, de bevinding blijft open.
    const h1 = await requestRecheck(p, user, org, f.id);
    expect(h1.status).toBe('wachtrij');
    const scan = await one<{ check_keys: string[]; finding_id: string }>(p.pool, 'SELECT check_keys, finding_id FROM scan WHERE id = $1', [h1.scanId]);
    expect(scan).toEqual({ check_keys: ['mail.dmarc', 'dns.dnssec'], finding_id: f.id });
    // Twee keer klikken geeft dezelfde controle.
    expect((await requestRecheck(p, user, org, f.id)).scanId).toBe(h1.scanId);
    await drainQueue(ctx());
    expect(await getRecheck(p, user.userId, org, h1.scanId)).toMatchObject({ status: 'klaar', uitkomst: 'nog-open' });
    expect((await dmarc())!.resolved_at).toBeNull();
    // Meteen nog eens mag niet (afkoeltijd).
    await expect(requestRecheck(p, user, org, f.id)).rejects.toMatchObject({ code: 'te_veel_verzoeken' });

    // Nu wel aangepast.
    await ouder();
    cfg.txt![`_dmarc.${D}`] = [`v=DMARC1; p=none; rua=mailto:dmarc@${D}`];
    const h2 = await requestRecheck(p, user, org, f.id);
    await drainQueue(ctx());
    expect(await getRecheck(p, user.userId, org, h2.scanId)).toMatchObject({ status: 'klaar', uitkomst: 'opgelost' });
    expect((await dmarc())!.resolved_at).not.toBeNull();

    // Alleen de gevraagde checks, geen score, websites niet als verdwenen gemarkeerd.
    const runs = await many<{ check_key: string }>(p.pool, 'SELECT check_key FROM check_run WHERE scan_id = $1 ORDER BY check_key', [h2.scanId]);
    expect(runs.map((r) => r.check_key)).toEqual(['dns.dnssec', 'mail.dmarc']);
    expect(await one(p.pool, 'SELECT 1 FROM score_snapshot WHERE scan_id = $1', [h2.scanId])).toBeUndefined();
    expect(await one(p.pool, "SELECT count(*)::int AS n FROM asset WHERE organization_id = $1 AND status = 'verdwenen'", [org])).toEqual({ n: 0 });
    // De nieuwe bevinding p=none is wél gemeld door dezelfde check.
    expect(await one(p.pool, "SELECT count(*)::int AS n FROM finding WHERE finding_key = 'dmarc.p_none' AND resolved_at IS NULL")).toEqual({ n: 1 });

    // Laatste volledige scan en planning blijven gelijk.
    const na = await domainScanInfo(p, user.userId, org);
    expect(na.domains.get(domain)!.last!.id).toBe(voor.domains.get(domain)!.last!.id);
    expect(na.domains.get(domain)!.canStartAt).toEqual(voor.domains.get(domain)!.canStartAt);
    expect(await planScans(p.pool)).toEqual([]);

    // De assetpagina meldt het als net opgelost.
    const opl = await getAssetOplossingen(p, user.userId, org, f.asset_id);
    expect(opl.netOpgelost.map((n) => n.title).length).toBe(1);
  });

  it('weigert bevindingen van een andere organisatie en opgeloste bevindingen', async () => {
    const f = (await dmarc())!;
    const ander = await loginAs(p, 'kees@ander.nl');
    const anderOrg = (await createOrganization(p, ander, { name: 'Ander', kind: 'klant' })).id;
    await expect(requestRecheck(p, ander, anderOrg, f.id)).rejects.toMatchObject({ code: 'niet_gevonden' });
    await p.pool.query('UPDATE finding SET resolved_at = now() WHERE id = $1', [f.id]);
    await expect(requestRecheck(p, user, org, f.id)).rejects.toMatchObject({ code: 'conflict' });
  });

  it('geeft per open bevinding een uitleg, met de korte naam en de mailpartij', async () => {
    const f = (await dmarc())!;
    const lookup = {
      resolveNs: async (n: string) => (n === D ? ['ns0.transip.net', 'ns1.transip.nl'] : []),
      resolveMx: async () => [`${D.replace('.', '-')}.mail.protection.outlook.com`],
      registrar: async () => 'TransIP B.V.',
    };
    const opl = await getAssetOplossingen({ ...p, hostLookup: lookup }, user.userId, org, f.asset_id);
    const o = opl.perBevinding.get(f.id)!;
    expect(o.kanHercontrole).toBe(true);
    expect(o.gids!.ingreep).toBe('dns-toevoegen');
    expect(o.gids!.regels[0]).toMatchObject({ type: 'TXT', naam: `_dmarc.${D}`, kort: '_dmarc', waarde: `v=DMARC1; p=none; rua=mailto:dmarc@${D}` });
    expect(o.gids!.inlog).toMatchObject({ naam: 'TransIP' });
    expect(opl.dnsBeheer).toBe('TransIP');
  });
});
