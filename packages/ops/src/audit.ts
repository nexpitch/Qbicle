import type { Queryable } from '@qbicle/platform';
import { actorLabel, type OpsActor } from './context.ts';

/**
 * Schrijft naar hetzelfde alleen-toevoegen audit_log als het platform, met
 * acties onder 'ops.' en als actor 'agent:<sleutel>', 'gebruiker:<id>' of 'systeem'.
 */
export async function opsAudit(
  q: Queryable,
  actor: OpsActor,
  entry: { action: `ops.${string}`; organizationId?: string | null; subject?: string | null; detail?: Record<string, unknown> },
): Promise<void> {
  await q.query(
    `INSERT INTO audit_log (organization_id, actor, actor_user_id, action, subject, detail, ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      entry.organizationId ?? null,
      actorLabel(actor),
      actor.kind === 'medewerker' ? actor.userId : null,
      entry.action,
      entry.subject ?? null,
      entry.detail ? JSON.stringify(entry.detail) : null,
      actor.kind === 'medewerker' ? (actor.ip ?? null) : null,
    ],
  );
}

export interface OpsAuditRow {
  id: string;
  at: Date;
  actor: string;
  action: string;
  organization_id: string | null;
  subject: string | null;
  detail: Record<string, unknown> | null;
}

/** Activiteit van agents en medewerkers in de cockpit (nieuwste eerst). */
export async function listOpsActivity(
  q: Queryable,
  opts: { actor?: string; agentsOnly?: boolean; before?: string; limit?: number } = {},
): Promise<OpsAuditRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const r = await q.query(
    `SELECT id::text, at, actor, action, organization_id, subject, detail FROM audit_log
      WHERE action LIKE 'ops.%'
        AND ($1::text IS NULL OR actor = $1)
        AND (NOT $2::boolean OR actor LIKE 'agent:%')
        AND ($3::bigint IS NULL OR id < $3::bigint)
      ORDER BY id DESC LIMIT $4`,
    [opts.actor ?? null, opts.agentsOnly ?? false, opts.before ?? null, limit],
  );
  return r.rows as OpsAuditRow[];
}
