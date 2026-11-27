import { SecretBox } from '@qbicle/devices';
import { extractToken, SYSTEM_ACTOR } from '@qbicle/platform';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestPlatform, hasDb, type TestPlatform } from '../../../packages/platform/test/support/db.ts';
import { createWeb } from '../../web/src/app.tsx';
import { createCockpit } from '../src/app.tsx';
import type { StaffRole } from '../src/core/roles.ts';
import { addStaff, DEFAULT_COCKPIT_CONFIG, type Cockpit } from '../src/core/staff.ts';
import { stepAt, totpCode } from '../src/core/totp.ts';

const ORIGIN = 'https://cockpit.qbicle.test';
const SYS = { ...SYSTEM_ACTOR, kind: 'medewerker' as const };

describe.skipIf(!hasDb)('cockpit', () => {
  let p: TestPlatform;
  let cockpit: Cockpit;
  let app: ReturnType<typeof createCockpit>;

  beforeAll(async () => {
    p = await createTestPlatform();
    cockpit = {
      p,
      config: { ...DEFAULT_COCKPIT_CONFIG, origin: ORIGIN },
      box: new SecretBox({ currentId: 'test', keys: new Map([['test', Buffer.alloc(32, 7)]]) }),
    };
    app = createCockpit(cockpit, { secureCookies: true, trustProxy: false });
  });
  afterAll(async () => p?.close());

  const post = (path: string, body: unknown, cookie?: string, origin = ORIGIN) =>
    app.request(path, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    });
  const get = (path: string, cookie?: string) => app.request(path, cookie ? { headers: { cookie } } : undefined);
  const cookieOf = (res: Response) => res.headers.get('set-cookie')!.split(';')[0]!;

  async function secretOf(email: string): Promise<string> {
    const r = await p.pool.query(
      'SELECT m.user_id, m.totp_secret_sealed FROM staff_member m JOIN app_user u ON u.id = m.user_id WHERE u.email = $1',
      [email],
    );
    return cockpit.box.open(r.rows[0].totp_secret_sealed, { organizationId: 'qbicle-cockpit', sourceId: `totp:${r.rows[0].user_id}` });
  }

  async function linkLogin(email: string): Promise<string> {
    expect((await post('/api/inloglink', { email })).status).toBe(202);
    const token = extractToken(p.mailer.last(email)!.text, 'qcl_')!;
    expect(token).toBeTruthy();
    const res = await post('/api/inloggen', { token });
    expect(res.status).toBe(200);
    return cookieOf(res);
  }

  /** Volledig inloggen: link, authenticator instellen, code. */
  async function login(email: string, role: StaffRole): Promise<string> {
    await addStaff(cockpit, email, role, SYS);
    const half = await linkLogin(email);
    expect((await get('/mfa', half)).status).toBe(200);
    const code = totpCode(await secretOf(email), stepAt(Date.now()));
    const res = await post('/api/mfa', { code }, half);
    expect(res.status).toBe(200);
    return cookieOf(res);
  }

  it('zonder sessie naar inloggen; statische bestanden, CSP en geen indexering', async () => {
    expect((await get('/')).headers.get('location')).toBe('/inloggen');
    expect((await get('/medewerkers')).headers.get('location')).toBe('/inloggen');
    const res = await get('/inloggen');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect(await res.text()).not.toMatch(/style="|fonts\.googleapis/);
    expect((await get('/static/cockpit.css')).status).toBe(200);
    expect((await get('/static/woordmerk.png')).headers.get('content-type')).toBe('image/png');
    expect((await post('/api/medewerkers', { email: 'x@y.nl', rol: 'lezer' })).status).toBe(401);
  });

  it('inloglink alleen voor medewerkers, zelfde antwoord voor onbekende adressen', async () => {
    const before = p.mailer.sent.length;
    const res = await post('/api/inloglink', { email: 'onbekend@klant.nl' });
    expect(res.status).toBe(202);
    expect(p.mailer.sent.length).toBe(before);
  });

  it('wijzigingen alleen vanaf de eigen herkomst en als JSON', async () => {
    expect((await post('/api/inloglink', { email: 'a@b.nl' }, undefined, 'https://kwaadwillend.test')).status).toBe(403);
    const res = await app.request('/api/inloglink', { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'text/plain' }, body: 'x' });
    expect(res.status).toBe(415);
  });

  it('inloggen met verplichte MFA; sessie wordt na de code vervangen', async () => {
    await addStaff(cockpit, 'erik@qbicle.test', 'beheerder', SYS);
    const half = await linkLogin('erik@qbicle.test');
    expect((await post('/api/inloggen', { token: 'qcl_' + 'a'.repeat(43) })).status).toBe(410);
    // Zonder MFA geen toegang tot de cockpit.
    expect((await get('/', half)).headers.get('location')).toBe('/mfa');
    expect((await post('/api/medewerkers', { email: 'x@y.nl', rol: 'lezer' }, half)).status).toBe(401);

    const setup = await (await get('/mfa', half)).text();
    expect(setup).toContain('<svg');
    expect(setup).toContain('Authenticator instellen');

    expect((await post('/api/mfa', { code: '000000' }, half)).status).toBe(400);
    const secret = await secretOf('erik@qbicle.test');
    const code = totpCode(secret, stepAt(Date.now()));
    const ok = await post('/api/mfa', { code }, half);
    expect(ok.status).toBe(200);
    const full = cookieOf(ok);
    expect(full).not.toBe(half);
    expect(ok.headers.get('set-cookie')).toContain('__Host-qbicle_cockpit=');
    expect(ok.headers.get('set-cookie')).toContain('SameSite=Strict');

    // Oude (halve) sessie werkt niet meer.
    expect((await get('/', half)).headers.get('location')).toBe('/inloggen');
    const home = await get('/', full);
    expect(home.status).toBe(200);
    const html = await home.text();
    expect(html).toContain('Aandacht nodig');
    expect(html).toContain('MRR');
    expect(html).toContain('Medewerkers');

    // Dezelfde code werkt geen tweede keer.
    expect((await post('/api/uitloggen', {}, full)).status).toBe(204);
    expect((await get('/', full)).headers.get('location')).toBe('/inloggen');
    const again = await linkLogin('erik@qbicle.test');
    expect(await (await get('/mfa', again)).text()).toContain('Code invullen');
    expect((await post('/api/mfa', { code }, again)).status).toBe(400);

    const log = await p.pool.query(`SELECT action, actor FROM audit_log WHERE action LIKE 'cockpit.%' ORDER BY id`);
    const actions = log.rows.map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['cockpit.inloglink_gebruikt', 'cockpit.mfa_mislukt', 'cockpit.mfa_ingesteld', 'cockpit.uitgelogd']));
    expect(log.rows.find((r) => r.action === 'cockpit.mfa_ingesteld')!.actor).toMatch(/^medewerker:/);
  });

  it('een klantsessie geeft geen toegang tot de cockpit', async () => {
    const web = createWeb(p, { secureCookies: true, trustProxy: false });
    await web.request('/api/v1/auth/inloglink', {
      method: 'POST',
      headers: { origin: 'https://app.qbicle.test', 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'klant@bedrijf.nl' }),
    });
    const token = extractToken(p.mailer.last('klant@bedrijf.nl')!.text, 'qbl_')!;
    const res = await web.request('/api/v1/auth/inloggen', {
      method: 'POST',
      headers: { origin: 'https://app.qbicle.test', 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    const klantSessie = res.headers.get('set-cookie')!.split(';')[0]!.split('=')[1]!;
    expect((await get('/', `__Host-qbicle_cockpit=${klantSessie}`)).headers.get('location')).toBe('/inloggen');
    // En een klant-inloglink werkt niet in de cockpit.
    expect((await post('/api/inloggen', { token })).status).toBe(410);
  });

  it('rollen: lezer ziet de cockpit maar mag geen medewerkers beheren', async () => {
    const lezer = await login('lezer@qbicle.test', 'lezer');
    const page = await (await get('/medewerkers', lezer)).text();
    expect(page).toContain('lezer@qbicle.test');
    expect(page).not.toContain('Medewerker toevoegen');
    const res = await post('/api/medewerkers', { email: 'nieuw@qbicle.test', rol: 'support' }, lezer);
    expect(res.status).toBe(403);
  });

  it('medewerkers beheren met audit-log; laatste beheerder blijft', async () => {
    const admin = await login('beheer@qbicle.test', 'beheerder');
    expect((await post('/api/medewerkers', { email: 'Support@Qbicle.test', rol: 'support' }, admin)).status).toBe(201);
    expect((await post('/api/medewerkers', { email: 'support@qbicle.test', rol: 'support' }, admin)).status).toBe(409);
    const id = (await p.pool.query(`SELECT id FROM app_user WHERE email = 'support@qbicle.test'`)).rows[0].id as string;

    expect((await post(`/api/medewerkers/${id}/rol`, { rol: 'financieel' }, admin)).status).toBe(200);
    expect((await post(`/api/medewerkers/${id}/rol`, { rol: 'baas' }, admin)).status).toBe(400);
    expect((await post(`/api/medewerkers/${id}/intrekken`, {}, admin)).status).toBe(200);
    expect((await post('/api/inloglink', { email: 'support@qbicle.test' })).status).toBe(202);
    expect(p.mailer.last('support@qbicle.test')).toBeUndefined();

    // Jezelf intrekken of je eigen rol wijzigen kan niet.
    const self = (await p.pool.query(`SELECT id FROM app_user WHERE email = 'beheer@qbicle.test'`)).rows[0].id as string;
    expect((await post(`/api/medewerkers/${self}/intrekken`, {}, admin)).status).toBe(409);
    expect((await post(`/api/medewerkers/${self}/rol`, { rol: 'lezer' }, admin)).status).toBe(409);
    expect((await post('/api/medewerkers/geen-uuid/intrekken', {}, admin)).status).toBe(404);

    const audit = await (await get('/audit', admin)).text();
    expect(audit).toContain('Medewerker toegevoegd');
    expect(audit).toContain('Rol van medewerker gewijzigd');
    expect(audit).toContain('Toegang medewerker ingetrokken');
  });

  it('ingetrokken medewerker verliest direct zijn sessie; MFA-reset dwingt opnieuw instellen', async () => {
    const admin = await login('baas@qbicle.test', 'beheerder');
    const fin = await login('fin@qbicle.test', 'financieel');
    expect((await get('/', fin)).status).toBe(200);
    const id = (await p.pool.query(`SELECT id FROM app_user WHERE email = 'fin@qbicle.test'`)).rows[0].id as string;

    expect((await post(`/api/medewerkers/${id}/mfa-reset`, {}, admin)).status).toBe(200);
    expect((await get('/', fin)).headers.get('location')).toBe('/inloggen');
    const half = await linkLogin('fin@qbicle.test');
    expect(await (await get('/mfa', half)).text()).toContain('Authenticator instellen');

    expect((await post(`/api/medewerkers/${id}/intrekken`, {}, admin)).status).toBe(200);
    expect((await get('/mfa', half)).headers.get('location')).toBe('/inloggen');
  });

  it('placeholders voor onderdelen die nog komen', async () => {
    const c = await login('kijker@qbicle.test', 'lezer');
    for (const path of ['/incasso']) {
      const res = await get(path, c);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('Dit onderdeel wordt nu gebouwd');
    }
    expect((await get('/bestaat-niet', c)).status).toBe(404);
  });
});
