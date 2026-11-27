import type { SecretBox } from '@qbicle/devices';
import {
  audit,
  hashToken,
  hit,
  many,
  normalizeEmail,
  one,
  PlatformError,
  withTransaction,
  type Actor,
  type Limit,
  type Platform,
  type Queryable,
} from '@qbicle/platform';
import { randomBytes } from 'node:crypto';
import { isStaffRole, STAFF_ROLE_LABEL, type StaffRole } from './roles.ts';
import { newTotpSecret, otpauthUri, verifyTotp } from './totp.ts';

/**
 * Inloggen in de cockpit en beheer van medewerkers.
 *
 * Inloggen gaat in twee stappen: eerst een eenmalige link per e-mail (alleen
 * voor actieve medewerkers; het antwoord is altijd hetzelfde), daarna een code
 * uit de authenticator-app (TOTP). Pas na die code is de sessie volwaardig en
 * krijgt hij een nieuw token (geen sessie-fixatie tussen de twee stappen).
 */

export interface CockpitConfig {
  /** Adres van de cockpit, bijv. https://cockpit.qbicle.nl (voor links in e-mails en de CSRF-controle). */
  origin: string;
  loginTokenMinutes: number;
  /** Maximale duur van een sessie. */
  sessionHours: number;
  /** Na zoveel minuten niets doen moet je opnieuw inloggen. */
  idleMinutes: number;
}

export const DEFAULT_COCKPIT_CONFIG: CockpitConfig = {
  origin: 'http://localhost:3100',
  loginTokenMinutes: 15,
  sessionHours: 12,
  idleMinutes: 60,
};

export interface Cockpit {
  p: Platform;
  config: CockpitConfig;
  /** Versleuteling van TOTP-geheimen (sleutel buiten de database). */
  box: SecretBox;
}

export const COCKPIT_LIMITS = {
  linkPerEmail: { bucket: 'cockpit-link-email', max: 5, windowSeconds: 3600 },
  linkPerIp: { bucket: 'cockpit-link-ip', max: 20, windowSeconds: 3600 },
  inloggenPerIp: { bucket: 'cockpit-inloggen-ip', max: 30, windowSeconds: 900 },
  mfaPerUser: { bucket: 'cockpit-mfa-user', max: 6, windowSeconds: 900 },
} as const satisfies Record<string, Limit>;

// Tokens ------------------------------------------------------------------------------

const LINK_PREFIX = 'qcl_';
const SESSION_PREFIX = 'qcs_';

function newCockpitToken(prefix: string): { token: string; hash: Buffer } {
  const token = prefix + randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

function looksLike(prefix: string, token: unknown): token is string {
  return typeof token === 'string' && token.length === prefix.length + 43 && token.startsWith(prefix) && /^[A-Za-z0-9_-]+$/.test(token.slice(prefix.length));
}

const totpCtx = (userId: string) => ({ organizationId: 'qbicle-cockpit', sourceId: `totp:${userId}` });

// Sessies -------------------------------------------------------------------------------

export interface StaffUser {
  id: string;
  email: string;
  displayName: string | null;
}

export interface StaffSession {
  id: string;
  user: StaffUser;
  role: StaffRole;
  /** MFA voor deze sessie gedaan. */
  mfa: boolean;
  /** Medewerker heeft een bevestigde authenticator. */
  mfaConfigured: boolean;
  expiresAt: Date;
}

/** Actor voor het audit-log: altijd herkenbaar als medewerker. */
export function staffActor(s: StaffSession, base: Actor): Actor {
  return { ...base, userId: s.user.id, email: s.user.email, kind: 'medewerker' };
}

export async function requestStaffLink(c: Cockpit, rawEmail: string, actor: Actor): Promise<void> {
  const email = normalizeEmail(rawEmail);
  if (actor.ip) await hit(c.p.pool, COCKPIT_LIMITS.linkPerIp, actor.ip);
  await hit(c.p.pool, COCKPIT_LIMITS.linkPerEmail, email);

  const staff = await one<{ user_id: string }>(
    c.p.pool,
    `SELECT s.user_id FROM staff_member s JOIN app_user u ON u.id = s.user_id
      WHERE u.email = $1 AND s.revoked_at IS NULL AND u.disabled_at IS NULL`,
    [email],
  );
  if (!staff) return; // zelfde antwoord: niet verklappen wie medewerker is

  const { token, hash } = newCockpitToken(LINK_PREFIX);
  await c.p.pool.query(
    `INSERT INTO staff_login_token (user_id, token_hash, expires_at) VALUES ($1, $2, now() + make_interval(mins => $3))`,
    [staff.user_id, hash, c.config.loginTokenMinutes],
  );
  await audit(c.p.pool, { ...actor, userId: staff.user_id, kind: 'medewerker' }, {
    organizationId: null,
    action: 'cockpit.inloglink_aangevraagd',
    subject: staff.user_id,
  });
  await c.p.mailer.send({
    to: email,
    subject: 'Inloggen in de Qbicle Cockpit',
    text:
      `Klik op de link hieronder om in te loggen in de Qbicle Cockpit. De link werkt ${c.config.loginTokenMinutes} minuten en één keer.\n\n` +
      `${c.config.origin}/inloggen/bevestigen#token=${token}\n\n` +
      `Daarna vraagt de cockpit om een code uit je authenticator-app.\n` +
      `Heb je dit niet zelf aangevraagd? Meld het dan direct; er gebeurt niets zonder die code.`,
  });
}

async function createSession(q: Queryable, c: Cockpit, userId: string, mfa: boolean, actor: Actor) {
  const { token, hash } = newCockpitToken(SESSION_PREFIX);
  const s = await one<{ id: string; expires_at: Date }>(
    q,
    `INSERT INTO staff_session (user_id, token_hash, expires_at, mfa_at, ip, user_agent)
     VALUES ($1, $2, now() + make_interval(hours => $3), CASE WHEN $4 THEN now() END, $5, $6)
     RETURNING id, expires_at`,
    [userId, hash, c.config.sessionHours, mfa, actor.ip ?? null, actor.userAgent?.slice(0, 400) ?? null],
  );
  return { token, id: s!.id, expiresAt: s!.expires_at };
}

/** Stap 1: inloglink inwisselen. De sessie die je krijgt mag alleen de MFA-stap doen. */
export async function staffLogin(c: Cockpit, linkToken: string, actor: Actor): Promise<{ sessionToken: string; expiresAt: Date }> {
  if (actor.ip) await hit(c.p.pool, COCKPIT_LIMITS.inloggenPerIp, actor.ip);
  const invalid = new PlatformError('verlopen', 'Deze inloglink is verlopen of al gebruikt. Vraag een nieuwe aan.');
  if (!looksLike(LINK_PREFIX, linkToken)) throw invalid;
  return withTransaction(c.p.pool, async (q) => {
    const row = await one<{ user_id: string }>(
      q,
      `UPDATE staff_login_token t SET used_at = now()
         FROM staff_member s JOIN app_user u ON u.id = s.user_id
        WHERE t.token_hash = $1 AND t.used_at IS NULL AND t.expires_at > now()
          AND s.user_id = t.user_id AND s.revoked_at IS NULL AND u.disabled_at IS NULL
        RETURNING t.user_id`,
      [hashToken(linkToken)],
    );
    if (!row) throw invalid;
    const s = await createSession(q, c, row.user_id, false, actor);
    await audit(q, { ...actor, userId: row.user_id, kind: 'medewerker' }, { organizationId: null, action: 'cockpit.inloglink_gebruikt', subject: s.id });
    return { sessionToken: s.token, expiresAt: s.expiresAt };
  });
}

export async function authenticateStaff(c: Cockpit, sessionToken: string | undefined): Promise<StaffSession | undefined> {
  if (!looksLike(SESSION_PREFIX, sessionToken)) return undefined;
  const row = await one<{
    id: string;
    expires_at: Date;
    mfa_at: Date | null;
    user_id: string;
    email: string;
    display_name: string | null;
    role: string;
    totp_confirmed_at: Date | null;
    stale: boolean;
  }>(
    c.p.pool,
    `SELECT ss.id, ss.expires_at, ss.mfa_at, u.id AS user_id, u.email::text, u.display_name,
            m.role, m.totp_confirmed_at, ss.last_seen_at < now() - interval '1 minute' AS stale
       FROM staff_session ss
       JOIN app_user u ON u.id = ss.user_id
       JOIN staff_member m ON m.user_id = ss.user_id
      WHERE ss.token_hash = $1
        AND ss.revoked_at IS NULL
        AND ss.expires_at > now()
        AND ss.last_seen_at > now() - make_interval(mins => $2)
        AND m.revoked_at IS NULL
        AND u.disabled_at IS NULL`,
    [hashToken(sessionToken), c.config.idleMinutes],
  );
  if (!row || !isStaffRole(row.role)) return undefined;
  if (row.stale) await c.p.pool.query('UPDATE staff_session SET last_seen_at = now() WHERE id = $1', [row.id]);
  return {
    id: row.id,
    expiresAt: row.expires_at,
    role: row.role,
    mfa: row.mfa_at !== null && row.totp_confirmed_at !== null,
    mfaConfigured: row.totp_confirmed_at !== null,
    user: { id: row.user_id, email: row.email, displayName: row.display_name },
  };
}

export async function logoutStaff(c: Cockpit, s: StaffSession, actor: Actor): Promise<void> {
  await c.p.pool.query('UPDATE staff_session SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [s.id]);
  await audit(c.p.pool, staffActor(s, actor), { organizationId: null, action: 'cockpit.uitgelogd', subject: s.id });
}

// MFA -------------------------------------------------------------------------------------

/**
 * Geheim voor de authenticator-app. Zolang het nog niet bevestigd is, blijft
 * hetzelfde geheim staan (een pagina verversen geeft geen nieuwe QR-code).
 */
export async function mfaSetupSecret(c: Cockpit, s: StaffSession): Promise<{ secret: string; uri: string }> {
  if (s.mfaConfigured) throw new PlatformError('conflict', 'Je authenticator is al ingesteld.');
  const row = await one<{ totp_secret_sealed: string | null }>(c.p.pool, 'SELECT totp_secret_sealed FROM staff_member WHERE user_id = $1', [s.user.id]);
  let secret: string;
  if (row?.totp_secret_sealed) {
    secret = c.box.open(row.totp_secret_sealed, totpCtx(s.user.id));
  } else {
    secret = newTotpSecret();
    await c.p.pool.query(
      'UPDATE staff_member SET totp_secret_sealed = $2, updated_at = now() WHERE user_id = $1 AND totp_confirmed_at IS NULL',
      [s.user.id, c.box.seal(secret, totpCtx(s.user.id))],
    );
  }
  return { secret, uri: otpauthUri(secret, s.user.email) };
}

/**
 * Stap 2: code uit de app controleren. Bij de eerste keer wordt de authenticator
 * daarmee bevestigd. Geeft een nieuw sessietoken; het oude vervalt.
 */
export async function verifyStaffMfa(
  c: Cockpit,
  s: StaffSession,
  code: string,
  actor: Actor,
  nowMs = Date.now(),
): Promise<{ sessionToken: string; expiresAt: Date }> {
  const a = staffActor(s, actor);
  await hit(c.p.pool, COCKPIT_LIMITS.mfaPerUser, s.user.id);
  const result = await withTransaction(c.p.pool, async (q) => {
    const m = await one<{ totp_secret_sealed: string | null; totp_confirmed_at: Date | null; totp_last_step: string | null }>(
      q,
      'SELECT totp_secret_sealed, totp_confirmed_at, totp_last_step FROM staff_member WHERE user_id = $1 FOR UPDATE',
      [s.user.id],
    );
    if (!m?.totp_secret_sealed) throw new PlatformError('conflict', 'Stel eerst je authenticator in.');
    const secret = c.box.open(m.totp_secret_sealed, totpCtx(s.user.id));
    const step = verifyTotp(secret, code, nowMs, m.totp_last_step === null ? -1 : Number(m.totp_last_step));
    if (step === undefined) return undefined;
    const first = m.totp_confirmed_at === null;
    await q.query(
      `UPDATE staff_member SET totp_last_step = $2, totp_confirmed_at = coalesce(totp_confirmed_at, now()), updated_at = now() WHERE user_id = $1`,
      [s.user.id, step],
    );
    await q.query('UPDATE staff_session SET revoked_at = now() WHERE id = $1', [s.id]);
    const ns = await createSession(q, c, s.user.id, true, actor);
    await audit(q, a, { organizationId: null, action: first ? 'cockpit.mfa_ingesteld' : 'cockpit.ingelogd', subject: ns.id });
    return { sessionToken: ns.token, expiresAt: ns.expiresAt };
  });
  if (!result) {
    await audit(c.p.pool, a, { organizationId: null, action: 'cockpit.mfa_mislukt', subject: s.id });
    throw new PlatformError('ongeldige_invoer', 'Die code klopt niet of is al gebruikt. Wacht op de volgende code en probeer opnieuw.');
  }
  return result;
}

// Medewerkers ---------------------------------------------------------------------------

export interface StaffRow {
  user_id: string;
  email: string;
  display_name: string | null;
  role: StaffRole;
  created_at: Date;
  revoked_at: Date | null;
  mfa: boolean;
  last_login_at: Date | null;
}

export async function listStaff(c: Cockpit): Promise<StaffRow[]> {
  return many<StaffRow>(
    c.p.pool,
    `SELECT m.user_id, u.email::text, u.display_name, m.role, m.created_at, m.revoked_at,
            m.totp_confirmed_at IS NOT NULL AS mfa,
            (SELECT max(ss.mfa_at) FROM staff_session ss WHERE ss.user_id = m.user_id) AS last_login_at
       FROM staff_member m JOIN app_user u ON u.id = m.user_id
      ORDER BY m.revoked_at IS NOT NULL, u.email`,
  );
}

async function activeAdmins(q: Queryable): Promise<number> {
  const r = await one<{ n: number }>(q, `SELECT count(*)::int AS n FROM staff_member WHERE role = 'beheerder' AND revoked_at IS NULL`);
  return r?.n ?? 0;
}

/** Voegt een medewerker toe of zet een ingetrokken medewerker terug. */
export async function addStaff(c: Cockpit, rawEmail: string, role: StaffRole, actor: Actor): Promise<{ userId: string }> {
  const email = normalizeEmail(rawEmail);
  if (!isStaffRole(role)) throw new PlatformError('ongeldige_invoer', 'Onbekende rol.');
  return withTransaction(c.p.pool, async (q) => {
    await q.query('INSERT INTO app_user (email) VALUES ($1) ON CONFLICT (email) DO NOTHING', [email]);
    const u = (await one<{ id: string }>(q, 'SELECT id FROM app_user WHERE email = $1', [email]))!;
    const existing = await one<{ revoked_at: Date | null }>(q, 'SELECT revoked_at FROM staff_member WHERE user_id = $1 FOR UPDATE', [u.id]);
    if (existing && !existing.revoked_at) throw new PlatformError('conflict', `${email} is al medewerker.`);
    if (existing) {
      // Terugzetten: opnieuw MFA instellen, oude geheimen weg.
      await q.query(
        `UPDATE staff_member SET role = $2, revoked_at = NULL, revoked_by = NULL, added_by = $3, updated_at = now(),
                totp_secret_sealed = NULL, totp_confirmed_at = NULL, totp_last_step = NULL
          WHERE user_id = $1`,
        [u.id, role, actor.userId],
      );
    } else {
      await q.query('INSERT INTO staff_member (user_id, role, added_by) VALUES ($1, $2, $3)', [u.id, role, actor.userId]);
    }
    await audit(q, { ...actor, kind: 'medewerker' }, { organizationId: null, action: 'cockpit.medewerker_toegevoegd', subject: u.id, detail: { email, rol: role } });
    return { userId: u.id };
  });
}

export async function changeStaffRole(c: Cockpit, userId: string, role: StaffRole, actor: Actor): Promise<void> {
  if (!isStaffRole(role)) throw new PlatformError('ongeldige_invoer', 'Onbekende rol.');
  await withTransaction(c.p.pool, async (q) => {
    const m = await one<{ role: StaffRole }>(q, 'SELECT role FROM staff_member WHERE user_id = $1 AND revoked_at IS NULL FOR UPDATE', [userId]);
    if (!m) throw new PlatformError('niet_gevonden', 'Deze medewerker bestaat niet.');
    if (m.role === role) return;
    if (m.role === 'beheerder' && (await activeAdmins(q)) <= 1) {
      throw new PlatformError('conflict', 'Er moet minstens één beheerder overblijven.');
    }
    await q.query('UPDATE staff_member SET role = $2, updated_at = now() WHERE user_id = $1', [userId, role]);
    await audit(q, { ...actor, kind: 'medewerker' }, {
      organizationId: null,
      action: 'cockpit.medewerker_rol_gewijzigd',
      subject: userId,
      detail: { van: STAFF_ROLE_LABEL[m.role], naar: STAFF_ROLE_LABEL[role] },
    });
  });
}

export async function revokeStaff(c: Cockpit, userId: string, actor: Actor): Promise<void> {
  if (userId === actor.userId) throw new PlatformError('conflict', 'Je kunt je eigen toegang niet intrekken.');
  await withTransaction(c.p.pool, async (q) => {
    const m = await one<{ role: StaffRole }>(q, 'SELECT role FROM staff_member WHERE user_id = $1 AND revoked_at IS NULL FOR UPDATE', [userId]);
    if (!m) throw new PlatformError('niet_gevonden', 'Deze medewerker bestaat niet.');
    if (m.role === 'beheerder' && (await activeAdmins(q)) <= 1) {
      throw new PlatformError('conflict', 'Er moet minstens één beheerder overblijven.');
    }
    await q.query('UPDATE staff_member SET revoked_at = now(), revoked_by = $2, updated_at = now() WHERE user_id = $1', [userId, actor.userId]);
    await q.query('UPDATE staff_session SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
    await audit(q, { ...actor, kind: 'medewerker' }, { organizationId: null, action: 'cockpit.medewerker_ingetrokken', subject: userId });
  });
}

/** Authenticator kwijt: MFA opnieuw laten instellen en alle sessies beëindigen. */
export async function resetStaffMfa(c: Cockpit, userId: string, actor: Actor): Promise<void> {
  if (userId === actor.userId) throw new PlatformError('conflict', 'Laat een andere beheerder je authenticator resetten.');
  await withTransaction(c.p.pool, async (q) => {
    const r = await q.query(
      `UPDATE staff_member SET totp_secret_sealed = NULL, totp_confirmed_at = NULL, totp_last_step = NULL, updated_at = now()
        WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId],
    );
    if (!r.rowCount) throw new PlatformError('niet_gevonden', 'Deze medewerker bestaat niet.');
    await q.query('UPDATE staff_session SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
    await audit(q, { ...actor, kind: 'medewerker' }, { organizationId: null, action: 'cockpit.mfa_gereset', subject: userId });
  });
}

/** Zijn er al medewerkers? (Voor de eerste keer opstarten.) */
export async function hasStaff(c: Pick<Cockpit, 'p'>): Promise<boolean> {
  return Boolean(await one(c.p.pool, 'SELECT 1 FROM staff_member WHERE revoked_at IS NULL LIMIT 1'));
}
