import { audit, type Actor } from './audit.ts';
import type { Platform } from './context.ts';
import { one, withTransaction } from './db.ts';
import { PlatformError } from './errors.ts';
import { hit, LIMITS } from './ratelimit.ts';
import { hashToken, looksLikeToken, newToken } from './tokens.ts';

/**
 * Inloggen zonder wachtwoord: een eenmalige link per e-mail (magic link).
 *
 * - Het antwoord is altijd hetzelfde, of het adres nu bekend is of niet
 *   (geen lekken van wie klant is).
 * - Het token staat in het #-deel van de link, zodat het niet in serverlogs of
 *   Referer-headers belandt. De pagina stuurt het daarna met een POST door;
 *   een virusscanner die links "voorproeft" verbruikt het dus niet.
 * - Eenmalig, 15 minuten geldig, alleen als hash opgeslagen.
 * - Bij inloggen komt er een nieuwe sessie (sessie-fixatie is niet mogelijk).
 */

export interface SessionUser {
  id: string;
  email: string;
  displayName: string | null;
}

export interface Session {
  id: string;
  user: SessionUser;
  expiresAt: Date;
}

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,253}\.[^\s@]{2,}$/;

export function normalizeEmail(input: string): string {
  const email = input.trim().toLowerCase();
  if (email.length > 254 || !EMAIL_RE.test(email)) {
    throw new PlatformError('ongeldige_invoer', 'Vul een geldig e-mailadres in.');
  }
  return email;
}

export async function requestLoginLink(p: Platform, rawEmail: string, actor: Actor): Promise<void> {
  const email = normalizeEmail(rawEmail);
  if (actor.ip) await hit(p.pool, LIMITS.inloglinkPerIp, actor.ip);
  await hit(p.pool, LIMITS.inloglinkPerEmail, email);

  const disabled = await one(p.pool, 'SELECT 1 FROM app_user WHERE email = $1 AND disabled_at IS NOT NULL', [email]);
  if (disabled) return; // zelfde antwoord, geen mail

  const { token, hash } = newToken('login');
  await p.pool.query(
    `INSERT INTO login_token (email, token_hash, expires_at)
     VALUES ($1, $2, now() + make_interval(mins => $3))`,
    [email, hash, p.config.loginTokenMinutes],
  );
  await audit(p.pool, actor, { organizationId: null, action: 'auth.inloglink_aangevraagd', subject: email });

  const link = `${p.config.appOrigin}/inloggen/bevestigen#token=${token}`;
  await p.mailer.send({
    to: email,
    subject: 'Inloggen bij Qbicle',
    text:
      `Klik op de link hieronder om in te loggen bij Qbicle. De link werkt ${p.config.loginTokenMinutes} minuten en één keer.\n\n` +
      `${link}\n\n` +
      `Heb je dit niet zelf aangevraagd? Dan kun je deze mail negeren; er gebeurt niets.`,
  });
}

/** Wisselt een inloglink in voor een sessie. Maakt het account aan bij de eerste keer. */
export async function login(
  p: Platform,
  loginToken: string,
  actor: Actor,
): Promise<{ sessionToken: string; session: Session; isNewUser: boolean }> {
  if (actor.ip) await hit(p.pool, LIMITS.inloggenPerIp, actor.ip);
  const invalid = new PlatformError('verlopen', 'Deze inloglink is verlopen of al gebruikt. Vraag een nieuwe aan.');
  if (!looksLikeToken('login', loginToken)) throw invalid;

  return withTransaction(p.pool, async (q) => {
    // Eenmalig: alleen de eerste die het token gebruikt krijgt een rij terug.
    const row = await one<{ email: string }>(
      q,
      `UPDATE login_token SET used_at = now()
        WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
        RETURNING email::text`,
      [hashToken(loginToken)],
    );
    if (!row) throw invalid;

    let user = await one<{ id: string; email: string; display_name: string | null; disabled_at: Date | null }>(
      q,
      'SELECT id, email::text, display_name, disabled_at FROM app_user WHERE email = $1',
      [row.email],
    );
    let isNewUser = false;
    if (!user) {
      user = await one(
        q,
        'INSERT INTO app_user (email) VALUES ($1) RETURNING id, email::text, display_name, disabled_at',
        [row.email],
      );
      isNewUser = true;
      await audit(q, { ...actor, userId: user!.id }, { organizationId: null, action: 'auth.account_aangemaakt', subject: user!.id });
    }
    if (user!.disabled_at) throw invalid;

    await q.query('UPDATE app_user SET last_login_at = now() WHERE id = $1', [user!.id]);
    const { token, hash } = newToken('sessie');
    const s = await one<{ id: string; expires_at: Date }>(
      q,
      `INSERT INTO user_session (user_id, token_hash, expires_at, ip, user_agent)
       VALUES ($1, $2, now() + make_interval(days => $3), $4, $5)
       RETURNING id, expires_at`,
      [user!.id, hash, p.config.sessionMaxDays, actor.ip ?? null, actor.userAgent?.slice(0, 400) ?? null],
    );
    await audit(q, { ...actor, userId: user!.id }, { organizationId: null, action: 'auth.ingelogd', subject: s!.id });
    return {
      sessionToken: token,
      session: {
        id: s!.id,
        expiresAt: s!.expires_at,
        user: { id: user!.id, email: user!.email, displayName: user!.display_name },
      },
      isNewUser,
    };
  });
}

/**
 * Zoekt de sessie bij een cookie. Geeft undefined bij een onbekende, verlopen,
 * ingetrokken of te lang ongebruikte sessie.
 */
export async function authenticate(p: Platform, sessionToken: string | undefined): Promise<Session | undefined> {
  if (!looksLikeToken('sessie', sessionToken)) return undefined;
  const row = await one<{
    id: string;
    expires_at: Date;
    user_id: string;
    email: string;
    display_name: string | null;
    stale: boolean;
  }>(
    p.pool,
    `SELECT s.id, s.expires_at, u.id AS user_id, u.email::text, u.display_name,
            s.last_seen_at < now() - interval '5 minutes' AS stale
       FROM user_session s JOIN app_user u ON u.id = s.user_id
      WHERE s.token_hash = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > now()
        AND s.last_seen_at > now() - make_interval(days => $2)
        AND u.disabled_at IS NULL`,
    [hashToken(sessionToken), p.config.sessionIdleDays],
  );
  if (!row) return undefined;
  if (row.stale) {
    await p.pool.query('UPDATE user_session SET last_seen_at = now() WHERE id = $1', [row.id]);
  }
  return {
    id: row.id,
    expiresAt: row.expires_at,
    user: { id: row.user_id, email: row.email, displayName: row.display_name },
  };
}

export async function logout(p: Platform, session: Session, actor: Actor): Promise<void> {
  await p.pool.query('UPDATE user_session SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [session.id]);
  await audit(p.pool, actor, { organizationId: null, action: 'auth.uitgelogd', subject: session.id });
}

/** Overal uitloggen, bijv. na verlies van een laptop. */
export async function logoutEverywhere(p: Platform, userId: string, actor: Actor): Promise<number> {
  const r = await p.pool.query('UPDATE user_session SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
  await audit(p.pool, actor, { organizationId: null, action: 'auth.uitgelogd', subject: userId, detail: { overal: true } });
  return r.rowCount ?? 0;
}
