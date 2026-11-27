import { SecretBox } from '@qbicle/devices';
import { extractToken, SYSTEM_ACTOR } from '@qbicle/platform';
import { createTestPlatform, type TestPlatform } from '../../../packages/platform/test/support/db.ts';
import { createCockpit } from '../src/app.tsx';
import type { StaffRole } from '../src/core/roles.ts';
import { addStaff, DEFAULT_COCKPIT_CONFIG, type Cockpit } from '../src/core/staff.ts';
import { stepAt, totpCode } from '../src/core/totp.ts';

export const ORIGIN = 'https://cockpit.qbicle.test';

/** Testopstelling: verse database, cockpit-app en hulpfuncties om in te loggen. */
export async function cockpitHarness() {
  const p: TestPlatform = await createTestPlatform();
  const cockpit: Cockpit = {
    p,
    config: { ...DEFAULT_COCKPIT_CONFIG, origin: ORIGIN },
    box: new SecretBox({ currentId: 'test', keys: new Map([['test', Buffer.alloc(32, 7)]]) }),
  };
  const app = createCockpit(cockpit, { secureCookies: true, trustProxy: false });
  const post = (path: string, body: unknown, cookie?: string) =>
    app.request(path, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    });
  const get = (path: string, cookie?: string) => app.request(path, cookie ? { headers: { cookie } } : undefined);
  const cookieOf = (res: Response) => res.headers.get('set-cookie')!.split(';')[0]!;

  async function login(email: string, role: StaffRole): Promise<string> {
    await addStaff(cockpit, email, role, { ...SYSTEM_ACTOR, kind: 'medewerker' });
    await post('/api/inloglink', { email });
    const half = cookieOf(await post('/api/inloggen', { token: extractToken(p.mailer.last(email)!.text, 'qcl_')! }));
    await get('/mfa', half);
    const r = await p.pool.query(
      'SELECT m.user_id, m.totp_secret_sealed FROM staff_member m JOIN app_user u ON u.id = m.user_id WHERE u.email = $1',
      [email],
    );
    const secret = cockpit.box.open(r.rows[0].totp_secret_sealed, { organizationId: 'qbicle-cockpit', sourceId: `totp:${r.rows[0].user_id}` });
    return cookieOf(await post('/api/mfa', { code: totpCode(secret, stepAt(Date.now())) }, half));
  }

  return { p, cockpit, app, post, get, login, close: () => p.close() };
}
