import { audit, type Actor } from './audit.ts';
import { normalizeEmail } from './auth.ts';
import type { Platform } from './context.ts';
import { isUniqueViolation, many, one, withTransaction, type Queryable } from './db.ts';
import { notFound, PlatformError } from './errors.ts';
import { authorize, isUuid } from './organizations.ts';
import { hit, LIMITS } from './ratelimit.ts';
import { mayAssignRole, rank, type Role } from './roles.ts';
import { hashToken, looksLikeToken, newToken } from './tokens.ts';

type UserActor = Actor & { userId: string };

export interface Member {
  userId: string;
  email: string;
  displayName: string | null;
  role: Role;
  since: Date;
}

export async function listMembers(p: Platform, userId: string, organizationId: string): Promise<Member[]> {
  await authorize(p.pool, userId, organizationId, 'leden:lezen');
  const rows = await many<{ user_id: string; email: string; display_name: string | null; role: Role; created_at: Date }>(
    p.pool,
    `SELECT m.user_id, u.email::text, u.display_name, m.role, m.created_at
       FROM membership m JOIN app_user u ON u.id = m.user_id
      WHERE m.organization_id = $1 ORDER BY u.email`,
    [organizationId],
  );
  return rows.map((r) => ({ userId: r.user_id, email: r.email, displayName: r.display_name, role: r.role, since: r.created_at }));
}

async function ownerCount(q: Queryable, organizationId: string): Promise<number> {
  const r = await one<{ n: number }>(
    q,
    "SELECT count(*)::int AS n FROM membership WHERE organization_id = $1 AND role = 'eigenaar'",
    [organizationId],
  );
  return r?.n ?? 0;
}

/** Vergrendelt de leden van een organisatie, zodat twee gelijktijdige wijzigingen niet samen de laatste eigenaar weghalen. */
async function lockMembers(q: Queryable, organizationId: string): Promise<void> {
  await q.query('SELECT 1 FROM organization WHERE id = $1 FOR UPDATE', [organizationId]);
}

export async function changeMemberRole(
  p: Platform,
  actor: UserActor,
  organizationId: string,
  memberUserId: string,
  newRole: Role,
): Promise<void> {
  await withTransaction(p.pool, async (q) => {
    const access = await authorize(q, actor.userId, organizationId, 'leden:beheren');
    await lockMembers(q, organizationId);
    const member = isUuid(memberUserId)
      ? await one<{ role: Role }>(q, 'SELECT role FROM membership WHERE organization_id = $1 AND user_id = $2', [organizationId, memberUserId])
      : undefined;
    if (!member) throw notFound('Dit lid');
    if (member.role === newRole) return;
    // Je kunt alleen iemand wijzigen die niet boven je staat, en niet naar boven je eigen rol.
    if (rank(member.role) > rank(access.role) || (member.role === 'eigenaar' && access.role !== 'eigenaar')) {
      throw new PlatformError('geen_toegang', 'Alleen een eigenaar kan de rol van een eigenaar wijzigen.');
    }
    if (!mayAssignRole(access, newRole, true)) {
      throw new PlatformError('geen_toegang', 'Je kunt niemand een hogere rol geven dan je zelf hebt.');
    }
    if (member.role === 'eigenaar' && (await ownerCount(q, organizationId)) <= 1) {
      throw new PlatformError('conflict', 'Er moet altijd minstens één eigenaar zijn. Benoem eerst een andere eigenaar.');
    }
    await q.query('UPDATE membership SET role = $3 WHERE organization_id = $1 AND user_id = $2', [organizationId, memberUserId, newRole]);
    await audit(q, actor, {
      organizationId,
      action: 'lid.rol_gewijzigd',
      subject: memberUserId,
      detail: { van: member.role, naar: newRole },
    });
  });
}

/** Lid verwijderen; je mag ook jezelf verwijderen (organisatie verlaten), behalve als laatste eigenaar. */
export async function removeMember(p: Platform, actor: UserActor, organizationId: string, memberUserId: string): Promise<void> {
  await withTransaction(p.pool, async (q) => {
    const self = memberUserId === actor.userId;
    const access = self
      ? await authorize(q, actor.userId, organizationId, 'org:lezen')
      : await authorize(q, actor.userId, organizationId, 'leden:beheren');
    await lockMembers(q, organizationId);
    const member = isUuid(memberUserId)
      ? await one<{ role: Role }>(q, 'SELECT role FROM membership WHERE organization_id = $1 AND user_id = $2', [organizationId, memberUserId])
      : undefined;
    if (!member) throw notFound('Dit lid');
    if (!self && (member.role === 'eigenaar' ? access.role !== 'eigenaar' : rank(member.role) > rank(access.role))) {
      throw new PlatformError('geen_toegang', 'Je kunt geen lid verwijderen met een hogere rol dan jij.');
    }
    if (member.role === 'eigenaar' && (await ownerCount(q, organizationId)) <= 1) {
      throw new PlatformError('conflict', 'Er moet altijd minstens één eigenaar zijn. Benoem eerst een andere eigenaar.');
    }
    await q.query('DELETE FROM membership WHERE organization_id = $1 AND user_id = $2', [organizationId, memberUserId]);
    await audit(q, actor, { organizationId, action: 'lid.verwijderd', subject: memberUserId, detail: { rol: member.role, zelf: self } });
  });
}

// Uitnodigingen ----------------------------------------------------------------

export interface Invitation {
  id: string;
  email: string;
  role: Role;
  expiresAt: Date;
  createdAt: Date;
}

export async function inviteMember(
  p: Platform,
  actor: UserActor,
  organizationId: string,
  input: { email: string; role: Role },
): Promise<Invitation> {
  const email = normalizeEmail(input.email);
  const { token, hash } = newToken('uitnodiging');
  const result = await withTransaction(p.pool, async (q) => {
    const access = await authorize(q, actor.userId, organizationId, 'leden:uitnodigen');
    const hasOwner = (await ownerCount(q, organizationId)) > 0;
    if (!mayAssignRole(access, input.role, hasOwner)) {
      throw new PlatformError('geen_toegang', 'Je kunt niemand uitnodigen met een hogere rol dan je zelf hebt.');
    }
    await hit(q, LIMITS.uitnodigingPerOrg, organizationId);
    const already = await one(
      q,
      'SELECT 1 FROM membership m JOIN app_user u ON u.id = m.user_id WHERE m.organization_id = $1 AND u.email = $2',
      [organizationId, email],
    );
    if (already) throw new PlatformError('conflict', 'Deze persoon is al lid van de organisatie.');
    await checkUserLimit(p, q, organizationId, email);

    // Een nieuwe uitnodiging vervangt een openstaande voor hetzelfde adres.
    await q.query(
      'UPDATE invitation SET revoked_at = now() WHERE organization_id = $1 AND email = $2 AND accepted_at IS NULL AND revoked_at IS NULL',
      [organizationId, email],
    );
    let inv: { id: string; expires_at: Date; created_at: Date } | undefined;
    try {
      inv = await one(
        q,
        `INSERT INTO invitation (organization_id, email, role, token_hash, invited_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, now() + make_interval(days => $6))
         RETURNING id, expires_at, created_at`,
        [organizationId, email, input.role, hash, actor.userId, p.config.invitationDays],
      );
    } catch (err) {
      if (isUniqueViolation(err)) throw new PlatformError('conflict', 'Er loopt al een uitnodiging voor dit adres.');
      throw err;
    }
    await audit(q, actor, { organizationId, action: 'uitnodiging.verstuurd', subject: inv!.id, detail: { email, rol: input.role } });
    const org = await one<{ name: string }>(q, 'SELECT name FROM organization WHERE id = $1', [organizationId]);
    return { inv: inv!, orgName: org!.name };
  });

  await p.mailer.send({
    to: email,
    subject: `Uitnodiging voor ${result.orgName} op Qbicle`,
    text:
      `${actor.email ?? 'Een collega'} nodigt je uit voor ${result.orgName} op Qbicle, als ${input.role}.\n\n` +
      `Accepteer de uitnodiging via deze link (${p.config.invitationDays} dagen geldig):\n` +
      `${p.config.appOrigin}/uitnodiging#token=${token}\n\n` +
      `Ken je de afzender niet? Dan kun je deze mail negeren.`,
  });
  return { id: result.inv.id, email, role: input.role, expiresAt: result.inv.expires_at, createdAt: result.inv.created_at };
}

/**
 * Het pakket bepaalt hoeveel gebruikers een organisatie heeft (leden plus
 * openstaande uitnodigingen). Zonder abonnement geldt geen grens, zodat
 * organisaties die een IT-partner aanmaakt gewoon werken.
 */
async function checkUserLimit(p: Platform, q: Queryable, organizationId: string, email: string): Promise<void> {
  const sub = await one<{ plan: string }>(
    q,
    `SELECT plan FROM subscription WHERE organization_id = $1 AND status IN ('proef', 'actief', 'achterstallig', 'opgezegd')`,
    [organizationId],
  );
  const plan = sub ? p.catalog.plans.find((x) => x.id === sub.plan) : undefined;
  if (!plan) return;
  const n = await one<{ n: number }>(
    q,
    `SELECT (SELECT count(*) FROM membership WHERE organization_id = $1)
          + (SELECT count(*) FROM invitation WHERE organization_id = $1 AND email <> $2
              AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()) AS n`,
    [organizationId, email],
  );
  if (Number(n?.n ?? 0) >= plan.limieten.gebruikers) {
    throw new PlatformError(
      'conflict',
      `${plan.naam} heeft ruimte voor ${plan.limieten.gebruikers} gebruikers, inclusief openstaande uitnodigingen. Trek een uitnodiging in, verwijder een gebruiker of kies een groter pakket.`,
    );
  }
}

export async function listInvitations(p: Platform, userId: string, organizationId: string): Promise<Invitation[]> {
  await authorize(p.pool, userId, organizationId, 'leden:uitnodigen');
  const rows = await many<{ id: string; email: string; role: Role; expires_at: Date; created_at: Date }>(
    p.pool,
    `SELECT id, email::text, role, expires_at, created_at FROM invitation
      WHERE organization_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()
      ORDER BY created_at DESC`,
    [organizationId],
  );
  return rows.map((r) => ({ id: r.id, email: r.email, role: r.role, expiresAt: r.expires_at, createdAt: r.created_at }));
}

export async function revokeInvitation(p: Platform, actor: UserActor, organizationId: string, invitationId: string): Promise<void> {
  await authorize(p.pool, actor.userId, organizationId, 'leden:uitnodigen');
  if (!isUuid(invitationId)) throw notFound('Deze uitnodiging');
  const r = await p.pool.query(
    `UPDATE invitation SET revoked_at = now()
      WHERE id = $1 AND organization_id = $2 AND accepted_at IS NULL AND revoked_at IS NULL`,
    [invitationId, organizationId],
  );
  if (!r.rowCount) throw notFound('Deze uitnodiging');
  await audit(p.pool, actor, { organizationId, action: 'uitnodiging.ingetrokken', subject: invitationId });
}

/**
 * Accepteren kan alleen een ingelogde gebruiker met hetzelfde e-mailadres als
 * de uitnodiging. Een doorgestuurde link werkt dus niet voor iemand anders.
 */
export async function acceptInvitation(
  p: Platform,
  actor: UserActor & { email: string },
  token: string,
): Promise<{ organizationId: string; role: Role }> {
  const invalid = new PlatformError('verlopen', 'Deze uitnodiging is verlopen, ingetrokken of al gebruikt.');
  if (!looksLikeToken('uitnodiging', token)) throw invalid;
  return withTransaction(p.pool, async (q) => {
    const inv = await one<{ id: string; organization_id: string; email: string; role: Role }>(
      q,
      `SELECT id, organization_id, email::text, role FROM invitation
        WHERE token_hash = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()
        FOR UPDATE`,
      [hashToken(token)],
    );
    if (!inv) throw invalid;
    if (inv.email.toLowerCase() !== actor.email.toLowerCase()) {
      throw new PlatformError(
        'geen_toegang',
        'Deze uitnodiging is voor een ander e-mailadres. Log in met het adres waarop je de uitnodiging kreeg.',
      );
    }
    await q.query('UPDATE invitation SET accepted_at = now(), accepted_by = $2 WHERE id = $1', [inv.id, actor.userId]);
    // Bestaat het lidmaatschap al, dan alleen ophogen, nooit verlagen.
    await q.query(
      `INSERT INTO membership (organization_id, user_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (organization_id, user_id) DO UPDATE SET role = EXCLUDED.role
       WHERE (CASE membership.role WHEN 'eigenaar' THEN 3 WHEN 'beheerder' THEN 2 ELSE 1 END)
           < (CASE EXCLUDED.role WHEN 'eigenaar' THEN 3 WHEN 'beheerder' THEN 2 ELSE 1 END)`,
      [inv.organization_id, actor.userId, inv.role],
    );
    await audit(q, actor, { organizationId: inv.organization_id, action: 'uitnodiging.geaccepteerd', subject: inv.id, detail: { rol: inv.role } });
    return { organizationId: inv.organization_id, role: inv.role };
  });
}
