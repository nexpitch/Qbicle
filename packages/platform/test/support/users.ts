import { extractToken, login, requestLoginLink, type Actor } from '../../src/index.ts';
import type { TestPlatform } from './db.ts';

let ipCounter = 1;

/** Logt een gebruiker in via de echte inloglink-flow en geeft een actor terug. */
export async function loginAs(p: TestPlatform, email: string): Promise<Actor & { userId: string; email: string; sessionToken: string }> {
  const ip = `192.0.2.${ipCounter++ % 250}`;
  await requestLoginLink(p, email, { userId: null, ip });
  const mail = p.mailer.last(email);
  const token = extractToken(mail!.text, 'qbl_');
  const r = await login(p, token!, { userId: null, ip });
  return { userId: r.session.user.id, email: r.session.user.email, ip, sessionToken: r.sessionToken };
}
