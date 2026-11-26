import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authenticate, extractToken, login, logout, logoutEverywhere, PlatformError, requestLoginLink } from '../src/index.ts';
import { createTestPlatform, hasDb, type TestPlatform } from './support/db.ts';
import { loginAs } from './support/users.ts';

describe.skipIf(!hasDb)('inloggen met een link', () => {
  let p: TestPlatform;
  beforeAll(async () => {
    p = await createTestPlatform();
  });
  afterAll(async () => p?.close());

  it('maakt bij de eerste keer een account aan en geeft een sessie', async () => {
    await requestLoginLink(p, '  Anna@Bakkerij.NL ', { userId: null, ip: '198.51.100.1' });
    const mail = p.mailer.last('anna@bakkerij.nl')!;
    expect(mail.text).toContain('https://app.qbicle.test/inloggen/bevestigen#token=qbl_');
    const token = extractToken(mail.text, 'qbl_')!;

    const r = await login(p, token, { userId: null, ip: '198.51.100.1' });
    expect(r.isNewUser).toBe(true);
    expect(r.session.user.email).toBe('anna@bakkerij.nl');

    const s = await authenticate(p, r.sessionToken);
    expect(s?.user.id).toBe(r.session.user.id);
  });

  it('een link werkt maar één keer', async () => {
    await requestLoginLink(p, 'bert@bakkerij.nl', { userId: null });
    const token = extractToken(p.mailer.last('bert@bakkerij.nl')!.text, 'qbl_')!;
    await login(p, token, { userId: null });
    await expect(login(p, token, { userId: null })).rejects.toMatchObject({ code: 'verlopen' });
  });

  it('gelijktijdig inwisselen levert maar één sessie op', async () => {
    await requestLoginLink(p, 'race@bakkerij.nl', { userId: null });
    const token = extractToken(p.mailer.last('race@bakkerij.nl')!.text, 'qbl_')!;
    const results = await Promise.allSettled([1, 2, 3, 4].map(() => login(p, token, { userId: null })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('een verlopen link werkt niet', async () => {
    await requestLoginLink(p, 'oud@bakkerij.nl', { userId: null });
    const token = extractToken(p.mailer.last('oud@bakkerij.nl')!.text, 'qbl_')!;
    await p.pool.query("UPDATE login_token SET expires_at = now() - interval '1 second' WHERE email = 'oud@bakkerij.nl'");
    await expect(login(p, token, { userId: null })).rejects.toBeInstanceOf(PlatformError);
  });

  it('slaat het token niet leesbaar op', async () => {
    await requestLoginLink(p, 'hash@bakkerij.nl', { userId: null });
    const token = extractToken(p.mailer.last('hash@bakkerij.nl')!.text, 'qbl_')!;
    const r = await p.pool.query("SELECT encode(token_hash, 'escape') AS h FROM login_token WHERE email = 'hash@bakkerij.nl'");
    expect(r.rows[0].h).not.toContain(token.slice(4));
  });

  it('ongeldige e-mailadressen worden geweigerd', async () => {
    await expect(requestLoginLink(p, 'geen-adres', { userId: null })).rejects.toMatchObject({ code: 'ongeldige_invoer' });
  });

  it('een uitgeschakeld account krijgt geen mail, maar hetzelfde antwoord', async () => {
    await p.pool.query("INSERT INTO app_user (email, disabled_at) VALUES ('weg@bakkerij.nl', now())");
    const before = p.mailer.sent.length;
    await expect(requestLoginLink(p, 'weg@bakkerij.nl', { userId: null })).resolves.toBeUndefined();
    expect(p.mailer.sent.length).toBe(before);
  });

  it('beperkt het aantal inloglinks per adres', async () => {
    for (let i = 0; i < 5; i++) await requestLoginLink(p, 'veel@bakkerij.nl', { userId: null });
    await expect(requestLoginLink(p, 'veel@bakkerij.nl', { userId: null })).rejects.toMatchObject({ code: 'te_veel_verzoeken' });
  });

  it('uitloggen trekt de sessie in', async () => {
    const u = await loginAs(p, 'uit@bakkerij.nl');
    const s = (await authenticate(p, u.sessionToken))!;
    await logout(p, s, u);
    expect(await authenticate(p, u.sessionToken)).toBeUndefined();
  });

  it('overal uitloggen trekt alle sessies in', async () => {
    const a = await loginAs(p, 'overal@bakkerij.nl');
    const b = await loginAs(p, 'overal@bakkerij.nl');
    expect(await logoutEverywhere(p, a.userId, a)).toBe(2);
    expect(await authenticate(p, a.sessionToken)).toBeUndefined();
    expect(await authenticate(p, b.sessionToken)).toBeUndefined();
  });

  it('een sessie die te lang niet gebruikt is, vervalt', async () => {
    const u = await loginAs(p, 'stil@bakkerij.nl');
    await p.pool.query("UPDATE user_session SET last_seen_at = now() - interval '8 days' WHERE user_id = $1", [u.userId]);
    expect(await authenticate(p, u.sessionToken)).toBeUndefined();
  });

  it('onzin of een ander soort token geeft geen sessie', async () => {
    expect(await authenticate(p, undefined)).toBeUndefined();
    expect(await authenticate(p, 'qbs_bestaatniet')).toBeUndefined();
    const u = await loginAs(p, 'soort@bakkerij.nl');
    expect(await authenticate(p, u.sessionToken.replace('qbs_', 'qbl_'))).toBeUndefined();
  });

  it('legt inloggen vast in het audit-log', async () => {
    const u = await loginAs(p, 'audit@bakkerij.nl');
    const r = await p.pool.query("SELECT action FROM audit_log WHERE actor_user_id = $1 ORDER BY id", [u.userId]);
    expect(r.rows.map((x) => x.action)).toEqual(['auth.account_aangemaakt', 'auth.ingelogd']);
  });
});
