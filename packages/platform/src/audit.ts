import type { Queryable } from './db.ts';
import { many } from './db.ts';

/** Wie doet iets: een ingelogde gebruiker of het systeem zelf (bijv. de worker). */
export interface Actor {
  userId: string | null;
  email?: string;
  ip?: string | null;
  userAgent?: string | null;
  /** 'medewerker' voor acties vanuit de interne cockpit (standaard: gebruiker). */
  kind?: 'gebruiker' | 'medewerker';
}

export const SYSTEM_ACTOR: Actor = { userId: null };

export type AuditAction =
  | 'auth.inloglink_aangevraagd'
  | 'auth.ingelogd'
  | 'auth.uitgelogd'
  | 'auth.account_aangemaakt'
  | 'org.aangemaakt'
  | 'org.gewijzigd'
  | 'lid.rol_gewijzigd'
  | 'lid.verwijderd'
  | 'uitnodiging.verstuurd'
  | 'uitnodiging.geaccepteerd'
  | 'uitnodiging.ingetrokken'
  | 'partner.klant_aangemaakt'
  | 'partner.toegang_verleend'
  | 'partner.toegang_ingetrokken'
  | 'domein.toegevoegd'
  | 'domein.geverifieerd'
  | 'domein.verificatie_mislukt'
  | 'domein.verificatiemail_verstuurd'
  | 'domein.verificatie_vervallen'
  | 'domein.verwijderd'
  | 'domein.gewijzigd'
  | 'scan.aangevraagd'
  | 'scan.hercontrole'
  | 'registratie.aangevraagd'
  | 'registratie.afgerond'
  | 'abonnement.gestart'
  | 'abonnement.gewijzigd'
  | 'abonnement.opgezegd'
  | 'abonnement.geactiveerd'
  | 'betaling.aangemaakt'
  | 'betaling.status'
  | 'factuur.uitgegeven'
  | 'factuurgegevens.gewijzigd'
  | 'btw.gecontroleerd'
  | 'contactpersoon.gewijzigd'
  | 'contactpersoon.verwijderd'
  | 'mandaat.afgegeven'
  | 'mandaat.ingetrokken'
  | 'betaalwijze.factuur_aangevraagd'
  | 'audit_opdracht.aangemaakt'
  | 'systeem.toegevoegd'
  | 'systeem.gewijzigd'
  | 'systeem.verwijderd'
  // Interne cockpit (apps/cockpit) en operationele onderdelen (packages/ops).
  | `cockpit.${string}`
  | `ops.${string}`;

export interface AuditEntry {
  organizationId: string | null;
  action: AuditAction;
  subject?: string | null;
  detail?: Record<string, unknown>;
}

export async function audit(q: Queryable, actor: Actor, entry: AuditEntry): Promise<void> {
  await q.query(
    `INSERT INTO audit_log (organization_id, actor, actor_user_id, action, subject, detail, ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      entry.organizationId,
      actor.kind === 'medewerker' && actor.userId
        ? `medewerker:${actor.userId}`
        : actor.userId
          ? `gebruiker:${actor.userId}`
          : 'systeem',
      actor.userId,
      entry.action,
      entry.subject ?? null,
      entry.detail ? JSON.stringify(entry.detail) : null,
      actor.ip ?? null,
    ],
  );
}

export interface AuditRow {
  id: string;
  at: Date;
  action: string;
  actor_user_id: string | null;
  actor_email: string | null;
  subject: string | null;
  detail: Record<string, unknown> | null;
}

export async function listAudit(
  q: Queryable,
  organizationId: string,
  opts: { before?: string; limit?: number } = {},
): Promise<AuditRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  return many<AuditRow>(
    q,
    `SELECT a.id::text, a.at, a.action, a.actor_user_id, u.email::text AS actor_email, a.subject, a.detail
       FROM audit_log a LEFT JOIN app_user u ON u.id = a.actor_user_id
      WHERE a.organization_id = $1 AND ($2::bigint IS NULL OR a.id < $2::bigint)
      ORDER BY a.id DESC LIMIT $3`,
    [organizationId, opts.before ?? null, limit],
  );
}
