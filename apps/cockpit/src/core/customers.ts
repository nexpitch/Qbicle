import { audit, many, one, PlatformError, withTransaction, type Actor, type Platform, type Queryable } from '@qbicle/platform';

/**
 * Klanten (organisaties) en gebruikers voor de cockpit. Medewerkers zien alle
 * organisaties; daarom staat deze code hier en niet in de klant-API, waar alles
 * per organisatie is afgeschermd.
 */

export const SUB_FILTERS = ['alle', 'actief', 'proef', 'achterstallig', 'opgezegd', 'geen'] as const;
export type SubFilter = (typeof SUB_FILTERS)[number];

export interface OrgListRow {
  id: string;
  name: string;
  kind: string;
  created_at: Date;
  plan: string | null;
  billing_interval: string | null;
  sub_status: string | null;
  monthly_price_cents: number | null;
  trial_ends_at: Date | null;
  users: number;
  domains: number;
  failed_payments: number;
  payment_method: string;
}

export async function listOrganizations(
  q: Queryable,
  opts: { zoek?: string; filter?: SubFilter; soort?: string; limit?: number; offset?: number } = {},
): Promise<{ rows: OrgListRow[]; total: number }> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  const zoek = opts.zoek?.trim().slice(0, 100) || null;
  const filter = opts.filter ?? 'alle';
  const soort = opts.soort && ['klant', 'it-partner', 'adviseur'].includes(opts.soort) ? opts.soort : null;
  const where = `
      WHERE ($1::text IS NULL
             OR o.name ILIKE '%' || $1 || '%'
             OR o.billing_email::text ILIKE '%' || $1 || '%'
             OR o.kvk_number = $1
             OR EXISTS (SELECT 1 FROM domain d WHERE d.organization_id = o.id AND d.name ILIKE '%' || $1 || '%')
             OR EXISTS (SELECT 1 FROM membership m JOIN app_user u ON u.id = m.user_id
                         WHERE m.organization_id = o.id AND u.email::text ILIKE '%' || $1 || '%'))
        AND ($2::text = 'alle'
             OR ($2 = 'geen' AND s.id IS NULL)
             OR s.status = $2)
        AND ($3::text IS NULL OR o.kind = $3)`;
  const from = `
      FROM organization o
      LEFT JOIN subscription s ON s.organization_id = o.id AND s.status IN ('proef', 'actief', 'achterstallig', 'opgezegd')`;
  const rows = await many<OrgListRow>(
    q,
    `SELECT o.id, o.name, o.kind, o.created_at, o.payment_method, s.plan, s.billing_interval, s.status AS sub_status,
            s.monthly_price_cents, s.trial_ends_at,
            (SELECT count(*) FROM membership m WHERE m.organization_id = o.id)::int AS users,
            (SELECT count(*) FROM domain d WHERE d.organization_id = o.id)::int AS domains,
            (SELECT count(*) FROM payment p WHERE p.organization_id = o.id AND p.status = 'mislukt'
                AND p.created_at > now() - interval '90 days')::int AS failed_payments
       ${from} ${where}
      ORDER BY o.created_at DESC, o.id
      LIMIT $4 OFFSET $5`,
    [zoek, filter, soort, limit, offset],
  );
  const t = await one<{ n: number }>(q, `SELECT count(*)::int AS n ${from} ${where}`, [zoek, filter, soort]);
  return { rows, total: t?.n ?? 0 };
}

export interface OrgDetail {
  org: {
    id: string;
    name: string;
    kind: string;
    plan: string;
    created_at: Date;
    billing_name: string | null;
    billing_email: string | null;
    billing_address: string | null;
    billing_postcode: string | null;
    billing_city: string | null;
    billing_country: string;
    kvk_number: string | null;
    vat_number: string | null;
  };
  subscription: {
    id: string;
    plan: string;
    billing_interval: string;
    monthly_price_cents: number;
    status: string;
    trial_ends_at: Date | null;
    current_period_start: Date | null;
    current_period_end: Date | null;
    cancel_at_period_end: boolean;
    created_at: Date;
  } | null;
  members: Array<{ user_id: string; email: string; display_name: string | null; role: string; last_login_at: Date | null; disabled_at: Date | null }>;
  partners: Array<{ id: string; name: string; access: string }>;
  domains: Array<{ id: string; name: string; verified_at: Date | null; verification_method: string | null; created_at: Date }>;
  payments: Array<{ id: string; description: string; amount_incl_cents: number; status: string; provider: string; created_at: Date; paid_at: Date | null; refunded_at: Date | null }>;
  invoices: Array<{ id: string; number: string; issued_at: Date; amount_incl_cents: number; payment_status: string }>;
}

export async function getOrganizationDetail(q: Queryable, id: string): Promise<OrgDetail> {
  const org = await one<OrgDetail['org']>(
    q,
    `SELECT id, name, kind, plan, created_at, billing_name, billing_email::text, billing_address, billing_postcode,
            billing_city, billing_country, kvk_number, vat_number
       FROM organization WHERE id = $1`,
    [id],
  );
  if (!org) throw new PlatformError('niet_gevonden', 'Dit bedrijf bestaat niet.');
  const [subscription, members, partners, domains, payments, invoices] = await Promise.all([
    one<NonNullable<OrgDetail['subscription']>>(
      q,
      `SELECT id, plan, billing_interval, monthly_price_cents, status, trial_ends_at, current_period_start,
              current_period_end, cancel_at_period_end, created_at
         FROM subscription WHERE organization_id = $1 ORDER BY (status IN ('proef','actief','achterstallig','opgezegd')) DESC, created_at DESC LIMIT 1`,
      [id],
    ),
    many<OrgDetail['members'][number]>(
      q,
      `SELECT u.id AS user_id, u.email::text, u.display_name, m.role, u.last_login_at, u.disabled_at
         FROM membership m JOIN app_user u ON u.id = m.user_id
        WHERE m.organization_id = $1
        ORDER BY CASE m.role WHEN 'eigenaar' THEN 0 WHEN 'beheerder' THEN 1 ELSE 2 END, u.email`,
      [id],
    ),
    many<OrgDetail['partners'][number]>(
      q,
      `SELECT o.id, o.name, pa.access FROM partner_access pa JOIN organization o ON o.id = pa.partner_org_id
        WHERE pa.client_org_id = $1 AND pa.revoked_at IS NULL ORDER BY o.name`,
      [id],
    ),
    many<OrgDetail['domains'][number]>(
      q,
      'SELECT id, name, verified_at, verification_method, created_at FROM domain WHERE organization_id = $1 ORDER BY name',
      [id],
    ),
    many<OrgDetail['payments'][number]>(
      q,
      `SELECT id, description, amount_incl_cents, status, provider, created_at, paid_at, refunded_at
         FROM payment WHERE organization_id = $1 ORDER BY created_at DESC LIMIT 25`,
      [id],
    ),
    many<OrgDetail['invoices'][number]>(
      q,
      `SELECT i.id, i.number, i.issued_at, i.amount_incl_cents, p.status AS payment_status
         FROM invoice i JOIN payment p ON p.id = i.payment_id
        WHERE i.organization_id = $1 ORDER BY i.issued_at DESC LIMIT 25`,
      [id],
    ),
  ]);
  return { org, subscription: subscription ?? null, members, partners, domains, payments, invoices };
}

// Notities ------------------------------------------------------------------------------

export interface OrgNote {
  id: string;
  body: string;
  source: string;
  created_at: Date;
  author_email: string | null;
}

export async function listNotes(q: Queryable, organizationId: string): Promise<OrgNote[]> {
  return many<OrgNote>(
    q,
    `SELECT n.id, n.body, n.source, n.created_at, u.email::text AS author_email
       FROM org_note n LEFT JOIN app_user u ON u.id = n.author_id
      WHERE n.organization_id = $1 ORDER BY n.created_at DESC LIMIT 100`,
    [organizationId],
  );
}

export async function addNote(q: Queryable, organizationId: string, body: string, actor: Actor): Promise<string> {
  const text = body.trim();
  if (!text || text.length > 4000) throw new PlatformError('ongeldige_invoer', 'Een notitie is 1 tot 4000 tekens.');
  const r = await one<{ id: string }>(
    q,
    `INSERT INTO org_note (organization_id, author_id, body)
     SELECT id, $2, $3 FROM organization WHERE id = $1 RETURNING id`,
    [organizationId, actor.userId, text],
  );
  if (!r) throw new PlatformError('niet_gevonden', 'Dit bedrijf bestaat niet.');
  await audit(q, actor, { organizationId, action: 'cockpit.notitie_toegevoegd', subject: r.id });
  return r.id;
}

/** Tijdlijn van een klant: alles uit het audit-log over deze organisatie. */
export async function orgTimeline(q: Queryable, organizationId: string, limit = 50) {
  return many<{ id: string; at: Date; action: string; actor: string; actor_email: string | null; detail: Record<string, unknown> | null }>(
    q,
    `SELECT a.id::text, a.at, a.action, a.actor, u.email::text AS actor_email, a.detail
       FROM audit_log a LEFT JOIN app_user u ON u.id = a.actor_user_id
      WHERE a.organization_id = $1 ORDER BY a.id DESC LIMIT $2`,
    [organizationId, limit],
  );
}

// Gebruikers --------------------------------------------------------------------------------

export interface UserListRow {
  id: string;
  email: string;
  display_name: string | null;
  created_at: Date;
  last_login_at: Date | null;
  disabled_at: Date | null;
  orgs: number;
  org_names: string | null;
  staff_role: string | null;
}

export async function listUsers(
  q: Queryable,
  opts: { zoek?: string; status?: 'alle' | 'geblokkeerd' | 'nooit'; limit?: number; offset?: number } = {},
): Promise<{ rows: UserListRow[]; total: number }> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  const zoek = opts.zoek?.trim().slice(0, 100) || null;
  const status = opts.status ?? 'alle';
  const where = `
      WHERE ($1::text IS NULL OR u.email::text ILIKE '%' || $1 || '%' OR u.display_name ILIKE '%' || $1 || '%'
             OR EXISTS (SELECT 1 FROM membership m JOIN organization o ON o.id = m.organization_id
                         WHERE m.user_id = u.id AND o.name ILIKE '%' || $1 || '%'))
        AND ($2::text = 'alle' OR ($2 = 'geblokkeerd' AND u.disabled_at IS NOT NULL) OR ($2 = 'nooit' AND u.last_login_at IS NULL))`;
  const rows = await many<UserListRow>(
    q,
    `SELECT u.id, u.email::text, u.display_name, u.created_at, u.last_login_at, u.disabled_at,
            (SELECT count(*) FROM membership m WHERE m.user_id = u.id)::int AS orgs,
            (SELECT string_agg(o.name, ', ' ORDER BY o.name) FROM membership m JOIN organization o ON o.id = m.organization_id
              WHERE m.user_id = u.id) AS org_names,
            (SELECT s.role FROM staff_member s WHERE s.user_id = u.id AND s.revoked_at IS NULL) AS staff_role
       FROM app_user u ${where}
      ORDER BY u.created_at DESC, u.id LIMIT $3 OFFSET $4`,
    [zoek, status, limit, offset],
  );
  const t = await one<{ n: number }>(q, `SELECT count(*)::int AS n FROM app_user u ${where}`, [zoek, status]);
  return { rows, total: t?.n ?? 0 };
}

export async function getUserDetail(q: Queryable, id: string) {
  const user = await one<{
    id: string;
    email: string;
    display_name: string | null;
    created_at: Date;
    last_login_at: Date | null;
    disabled_at: Date | null;
    disabled_reason: string | null;
    staff_role: string | null;
  }>(
    q,
    `SELECT u.id, u.email::text, u.display_name, u.created_at, u.last_login_at, u.disabled_at, u.disabled_reason,
            (SELECT s.role FROM staff_member s WHERE s.user_id = u.id AND s.revoked_at IS NULL) AS staff_role
       FROM app_user u WHERE u.id = $1`,
    [id],
  );
  if (!user) throw new PlatformError('niet_gevonden', 'Deze gebruiker bestaat niet.');
  const [orgs, sessions, events] = await Promise.all([
    many<{ id: string; name: string; role: string; kind: string }>(
      q,
      `SELECT o.id, o.name, m.role, o.kind FROM membership m JOIN organization o ON o.id = m.organization_id
        WHERE m.user_id = $1 ORDER BY o.name`,
      [id],
    ),
    one<{ n: number; last: Date | null }>(
      q,
      `SELECT count(*)::int AS n, max(last_seen_at) AS last FROM user_session
        WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()`,
      [id],
    ),
    many<{ id: string; at: Date; action: string; organization_name: string | null; actor: string }>(
      q,
      `SELECT a.id::text, a.at, a.action, o.name AS organization_name, a.actor
         FROM audit_log a LEFT JOIN organization o ON o.id = a.organization_id
        WHERE a.actor_user_id = $1::uuid OR a.subject = $1::text ORDER BY a.id DESC LIMIT 30`,
      [id],
    ),
  ]);
  return { user, orgs, activeSessions: sessions?.n ?? 0, lastSeen: sessions?.last ?? null, events };
}

/** Account blokkeren: niet meer inloggen, alle sessies direct beëindigd. */
export async function blockUser(pool: Platform['pool'], userId: string, reason: string, actor: Actor): Promise<void> {
  const why = reason.trim();
  if (!why || why.length > 400) throw new PlatformError('ongeldige_invoer', 'Geef een reden (max. 400 tekens).');
  if (userId === actor.userId) throw new PlatformError('conflict', 'Je kunt je eigen account niet blokkeren.');
  await withTransaction(pool, async (q) => {
    const staff = await one(q, 'SELECT 1 FROM staff_member WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
    if (staff) throw new PlatformError('conflict', 'Dit is een medewerker. Trek eerst de toegang in onder Medewerkers.');
    const r = await q.query('UPDATE app_user SET disabled_at = now(), disabled_reason = $2 WHERE id = $1 AND disabled_at IS NULL', [userId, why]);
    if (!r.rowCount) throw new PlatformError('conflict', 'Deze gebruiker bestaat niet of is al geblokkeerd.');
    const s = await q.query('UPDATE user_session SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
    await audit(q, actor, { organizationId: null, action: 'cockpit.gebruiker_geblokkeerd', subject: userId, detail: { reden: why, sessies: s.rowCount ?? 0 } });
  });
}

export async function unblockUser(q: Queryable, userId: string, actor: Actor): Promise<void> {
  const r = await q.query('UPDATE app_user SET disabled_at = NULL, disabled_reason = NULL WHERE id = $1 AND disabled_at IS NOT NULL', [userId]);
  if (!r.rowCount) throw new PlatformError('conflict', 'Deze gebruiker bestaat niet of is niet geblokkeerd.');
  await audit(q, actor, { organizationId: null, action: 'cockpit.gebruiker_gedeblokkeerd', subject: userId });
}

export async function logoutUserEverywhere(q: Queryable, userId: string, actor: Actor): Promise<number> {
  const exists = await one(q, 'SELECT 1 FROM app_user WHERE id = $1', [userId]);
  if (!exists) throw new PlatformError('niet_gevonden', 'Deze gebruiker bestaat niet.');
  const r = await q.query('UPDATE user_session SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
  await audit(q, actor, { organizationId: null, action: 'cockpit.gebruiker_uitgelogd', subject: userId, detail: { sessies: r.rowCount ?? 0 } });
  return r.rowCount ?? 0;
}
