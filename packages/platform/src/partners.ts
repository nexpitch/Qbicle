import { audit, type Actor } from './audit.ts';
import type { Platform } from './context.ts';
import { many, one, withTransaction } from './db.ts';
import { notFound, PlatformError } from './errors.ts';
import { authorize, cleanName, isUuid, type Organization } from './organizations.ts';
import type { PartnerAccessLevel } from './roles.ts';

/**
 * IT-partners (MSP's) en adviseurs met meerdere klanten.
 *
 * Twee manieren om een klant te koppelen:
 * 1. De partner maakt de klant zelf aan (klant heeft nog geen account). De partner
 *    krijgt beheerderstoegang en kan de eerste eigenaar uitnodigen.
 * 2. Een bestaande klant geeft een partner toegang, op basis van de partner-ID die de
 *    partner aan de klant doorgeeft.
 * De eigenaar van de klant kan de toegang altijd intrekken; de partner kan zelf stoppen.
 */

type UserActor = Actor & { userId: string };

export interface PartnerLink {
  id: string;
  partnerOrgId: string;
  partnerName: string;
  clientOrgId: string;
  clientName: string;
  access: PartnerAccessLevel;
  since: Date;
}

async function assertPartnerOrg(p: Platform, partnerOrgId: string): Promise<void> {
  const org = await one<{ kind: string }>(p.pool, 'SELECT kind FROM organization WHERE id = $1', [partnerOrgId]);
  if (!org || (org.kind !== 'it-partner' && org.kind !== 'adviseur')) {
    throw new PlatformError('ongeldige_invoer', 'Alleen een IT-partner of adviseur kan klanten beheren.');
  }
}

export async function createClientForPartner(
  p: Platform,
  actor: UserActor,
  partnerOrgId: string,
  input: { name: string },
): Promise<Organization> {
  await authorize(p.pool, actor.userId, partnerOrgId, 'klanten:beheren');
  await assertPartnerOrg(p, partnerOrgId);
  const name = cleanName(input.name);
  return withTransaction(p.pool, async (q) => {
    const org = await one<{ id: string; name: string; kind: 'klant'; plan: string; created_at: Date }>(
      q,
      "INSERT INTO organization (name, kind, created_by) VALUES ($1, 'klant', $2) RETURNING id, name, kind, plan, created_at",
      [name, actor.userId],
    );
    await q.query(
      "INSERT INTO partner_access (partner_org_id, client_org_id, access, granted_by) VALUES ($1, $2, 'beheerder', $3)",
      [partnerOrgId, org!.id, actor.userId],
    );
    const detail = { partner: partnerOrgId, klant: org!.id, naam: name };
    await audit(q, actor, { organizationId: partnerOrgId, action: 'partner.klant_aangemaakt', subject: org!.id, detail });
    await audit(q, actor, { organizationId: org!.id, action: 'partner.klant_aangemaakt', subject: org!.id, detail });
    return { id: org!.id, name: org!.name, kind: org!.kind, plan: org!.plan, createdAt: org!.created_at };
  });
}

/** Klant geeft een partner toegang. Alleen de eigenaar van de klant. */
export async function grantPartnerAccess(
  p: Platform,
  actor: UserActor,
  clientOrgId: string,
  input: { partnerOrgId: string; access: PartnerAccessLevel },
): Promise<PartnerLink> {
  await authorize(p.pool, actor.userId, clientOrgId, 'partners:beheren');
  if (!isUuid(input.partnerOrgId) || input.partnerOrgId === clientOrgId) {
    throw new PlatformError('ongeldige_invoer', 'Deze partner-ID klopt niet.');
  }
  const partner = await one<{ kind: string }>(p.pool, 'SELECT kind FROM organization WHERE id = $1', [input.partnerOrgId]);
  if (!partner || (partner.kind !== 'it-partner' && partner.kind !== 'adviseur')) {
    // Zelfde melding voor "bestaat niet" en "geen partner": geen organisaties raden.
    throw new PlatformError('ongeldige_invoer', 'Deze partner-ID klopt niet.');
  }
  await withTransaction(p.pool, async (q) => {
    // Bestaande toegang wordt vervangen (bijv. van lezer naar beheerder).
    await q.query(
      `UPDATE partner_access SET revoked_at = now(), revoked_by = $3
        WHERE partner_org_id = $1 AND client_org_id = $2 AND revoked_at IS NULL`,
      [input.partnerOrgId, clientOrgId, actor.userId],
    );
    await q.query(
      'INSERT INTO partner_access (partner_org_id, client_org_id, access, granted_by) VALUES ($1, $2, $3, $4)',
      [input.partnerOrgId, clientOrgId, input.access, actor.userId],
    );
    const detail = { partner: input.partnerOrgId, klant: clientOrgId, toegang: input.access };
    await audit(q, actor, { organizationId: clientOrgId, action: 'partner.toegang_verleend', subject: input.partnerOrgId, detail });
    await audit(q, actor, { organizationId: input.partnerOrgId, action: 'partner.toegang_verleend', subject: clientOrgId, detail });
  });
  const links = await linksWhere(p, 'pa.client_org_id = $1 AND pa.partner_org_id = $2', [clientOrgId, input.partnerOrgId]);
  return links[0]!;
}

/**
 * Toegang beëindigen. Mag de eigenaar van de klant, of een beheerder/eigenaar
 * van de partner zelf.
 */
export async function revokePartnerAccess(p: Platform, actor: UserActor, clientOrgId: string, partnerOrgId: string): Promise<void> {
  if (!isUuid(clientOrgId) || !isUuid(partnerOrgId)) throw notFound('Deze koppeling');
  let allowed = false;
  try {
    await authorize(p.pool, actor.userId, clientOrgId, 'partners:beheren');
    allowed = true;
  } catch {
    try {
      await authorize(p.pool, actor.userId, partnerOrgId, 'klanten:beheren');
      allowed = true;
    } catch {
      /* geen van beide */
    }
  }
  if (!allowed) throw notFound('Deze koppeling');
  await withTransaction(p.pool, async (q) => {
    const r = await q.query(
      `UPDATE partner_access SET revoked_at = now(), revoked_by = $3
        WHERE partner_org_id = $1 AND client_org_id = $2 AND revoked_at IS NULL`,
      [partnerOrgId, clientOrgId, actor.userId],
    );
    if (!r.rowCount) throw notFound('Deze koppeling');
    const detail = { partner: partnerOrgId, klant: clientOrgId };
    await audit(q, actor, { organizationId: clientOrgId, action: 'partner.toegang_ingetrokken', subject: partnerOrgId, detail });
    await audit(q, actor, { organizationId: partnerOrgId, action: 'partner.toegang_ingetrokken', subject: clientOrgId, detail });
  });
}

async function linksWhere(p: Platform, where: string, params: unknown[]): Promise<PartnerLink[]> {
  const rows = await many<{
    id: string;
    partner_org_id: string;
    partner_name: string;
    client_org_id: string;
    client_name: string;
    access: PartnerAccessLevel;
    created_at: Date;
  }>(
    p.pool,
    `SELECT pa.id, pa.partner_org_id, po.name AS partner_name, pa.client_org_id, co.name AS client_name, pa.access, pa.created_at
       FROM partner_access pa
       JOIN organization po ON po.id = pa.partner_org_id
       JOIN organization co ON co.id = pa.client_org_id
      WHERE pa.revoked_at IS NULL AND ${where}
      ORDER BY co.name, po.name`,
    params,
  );
  return rows.map((r) => ({
    id: r.id,
    partnerOrgId: r.partner_org_id,
    partnerName: r.partner_name,
    clientOrgId: r.client_org_id,
    clientName: r.client_name,
    access: r.access,
    since: r.created_at,
  }));
}

/** Klantenlijst van een partner. */
export async function listClients(p: Platform, userId: string, partnerOrgId: string): Promise<PartnerLink[]> {
  await authorize(p.pool, userId, partnerOrgId, 'org:lezen');
  return linksWhere(p, 'pa.partner_org_id = $1', [partnerOrgId]);
}

/** Welke partners kunnen bij deze klant? Zichtbaar voor iedereen in de klantorganisatie. */
export async function listPartners(p: Platform, userId: string, clientOrgId: string): Promise<PartnerLink[]> {
  await authorize(p.pool, userId, clientOrgId, 'org:lezen');
  return linksWhere(p, 'pa.client_org_id = $1', [clientOrgId]);
}
