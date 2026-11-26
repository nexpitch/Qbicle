import { audit, type Actor } from './audit.ts';
import type { Platform } from './context.ts';
import { many, one, withTransaction, type Queryable } from './db.ts';
import { notFound, PlatformError } from './errors.ts';
import { can, isRole, partnerRole, rank, type Access, type OrgKind, type PartnerAccessLevel, type Permission, type Role } from './roles.ts';

export interface Organization {
  id: string;
  name: string;
  kind: OrgKind;
  plan: string;
  createdAt: Date;
}

interface OrgRow {
  id: string;
  name: string;
  kind: OrgKind;
  plan: string;
  created_at: Date;
}

const toOrg = (r: OrgRow): Organization => ({ id: r.id, name: r.name, kind: r.kind, plan: r.plan, createdAt: r.created_at });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(x: unknown): x is string {
  return typeof x === 'string' && UUID_RE.test(x);
}

export function cleanName(input: string): string {
  const name = input.replace(/\s+/g, ' ').trim();
  if (name.length < 1 || name.length > 120) {
    throw new PlatformError('ongeldige_invoer', 'Geef een naam van 1 tot 120 tekens.');
  }
  return name;
}

/**
 * Welke toegang heeft deze gebruiker tot deze organisatie? Directe leden krijgen
 * hun eigen rol; medewerkers van een IT-partner met actieve toegang krijgen
 * min(rol bij de partner, toegangsniveau). Bij beide telt de hoogste.
 */
export async function resolveAccess(q: Queryable, userId: string, organizationId: string): Promise<Access | undefined> {
  if (!isUuid(organizationId)) return undefined;
  const direct = await one<{ role: Role }>(
    q,
    'SELECT role FROM membership WHERE organization_id = $1 AND user_id = $2',
    [organizationId, userId],
  );
  const viaPartner = await many<{ partner_org_id: string; access: PartnerAccessLevel; role: Role }>(
    q,
    `SELECT pa.partner_org_id, pa.access, m.role
       FROM partner_access pa
       JOIN membership m ON m.organization_id = pa.partner_org_id AND m.user_id = $2
      WHERE pa.client_org_id = $1 AND pa.revoked_at IS NULL`,
    [organizationId, userId],
  );

  let best: Access | undefined = direct && isRole(direct.role)
    ? { organizationId, role: direct.role, via: 'lid' }
    : undefined;
  for (const v of viaPartner) {
    const role = partnerRole(v.role, v.access);
    if (!best || rank(role) > rank(best.role)) {
      best = { organizationId, role, via: 'partner', partnerOrgId: v.partner_org_id };
    }
  }
  return best;
}

/**
 * De enige toegangspoort voor acties op een organisatie. Zonder toegang krijg je
 * "niet gevonden" (zodat je niet kunt raden welke organisaties bestaan); met
 * toegang maar zonder het recht krijg je "geen toegang".
 */
export async function authorize(q: Queryable, userId: string, organizationId: string, permission: Permission): Promise<Access> {
  const access = await resolveAccess(q, userId, organizationId);
  if (!access) throw notFound('Deze organisatie');
  if (!can(access, permission)) {
    throw new PlatformError('geen_toegang', 'Je rol in deze organisatie geeft geen toestemming voor deze actie.');
  }
  return access;
}

export async function createOrganization(
  p: Platform,
  actor: Actor & { userId: string },
  input: { name: string; kind: OrgKind },
): Promise<Organization> {
  const name = cleanName(input.name);
  return withTransaction(p.pool, async (q) => {
    const org = await one<OrgRow>(
      q,
      'INSERT INTO organization (name, kind, created_by) VALUES ($1, $2, $3) RETURNING id, name, kind, plan, created_at',
      [name, input.kind, actor.userId],
    );
    await q.query("INSERT INTO membership (organization_id, user_id, role) VALUES ($1, $2, 'eigenaar')", [org!.id, actor.userId]);
    await audit(q, actor, { organizationId: org!.id, action: 'org.aangemaakt', subject: org!.id, detail: { naam: name, soort: input.kind } });
    return toOrg(org!);
  });
}

export async function getOrganization(p: Platform, userId: string, organizationId: string): Promise<Organization & { access: Access }> {
  const access = await authorize(p.pool, userId, organizationId, 'org:lezen');
  const org = await one<OrgRow>(p.pool, 'SELECT id, name, kind, plan, created_at FROM organization WHERE id = $1', [organizationId]);
  if (!org) throw notFound('Deze organisatie');
  return { ...toOrg(org), access };
}

export async function renameOrganization(
  p: Platform,
  actor: Actor & { userId: string },
  organizationId: string,
  rawName: string,
): Promise<Organization> {
  await authorize(p.pool, actor.userId, organizationId, 'org:wijzigen');
  const name = cleanName(rawName);
  const org = await one<OrgRow>(
    p.pool,
    'UPDATE organization SET name = $2 WHERE id = $1 RETURNING id, name, kind, plan, created_at',
    [organizationId, name],
  );
  await audit(p.pool, actor, { organizationId, action: 'org.gewijzigd', subject: organizationId, detail: { naam: name } });
  return toOrg(org!);
}

export interface OrgListItem extends Organization {
  role: Role;
  via: 'lid' | 'partner';
  partnerOrgId?: string;
}

/** Alle organisaties waar de gebruiker bij kan: eigen lidmaatschappen en klanten via IT-partners. */
export async function listOrganizationsForUser(p: Platform, userId: string): Promise<OrgListItem[]> {
  const rows = await many<OrgRow & { via: 'lid' | 'partner'; role: Role; access: PartnerAccessLevel | null; partner_org_id: string | null }>(
    p.pool,
    `SELECT o.id, o.name, o.kind, o.plan, o.created_at, 'lid' AS via, m.role, NULL AS access, NULL::uuid AS partner_org_id
       FROM membership m JOIN organization o ON o.id = m.organization_id
      WHERE m.user_id = $1
     UNION ALL
     SELECT o.id, o.name, o.kind, o.plan, o.created_at, 'partner', m.role, pa.access, pa.partner_org_id
       FROM membership m
       JOIN partner_access pa ON pa.partner_org_id = m.organization_id AND pa.revoked_at IS NULL
       JOIN organization o ON o.id = pa.client_org_id
      WHERE m.user_id = $1`,
    [userId],
  );
  const byId = new Map<string, OrgListItem>();
  for (const r of rows) {
    const role = r.via === 'partner' ? partnerRole(r.role, r.access!) : r.role;
    const prev = byId.get(r.id);
    if (prev && rank(prev.role) >= rank(role)) continue;
    const item: OrgListItem = { ...toOrg(r), role, via: r.via };
    if (r.partner_org_id) item.partnerOrgId = r.partner_org_id;
    byId.set(r.id, item);
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name, 'nl'));
}
