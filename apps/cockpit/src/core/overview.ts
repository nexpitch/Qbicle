import { many, one, type Queryable } from '@qbicle/platform';

/** Cijfers voor de startpagina van de cockpit. Alles live uit de database. */
export interface Kpis {
  klanten: number;
  nieuwDezeMaand: number;
  actief: number;
  proef: number;
  achterstallig: number;
  /** Maandelijks terugkerende omzet excl. btw (actief + opgezegd tot einde periode + achterstallig). */
  mrrCents: number;
  mislukt30d: number;
  openstaandCents: number;
}

export async function getKpis(q: Queryable): Promise<Kpis> {
  const r = await one<Record<string, number | string>>(
    q,
    `SELECT
       (SELECT count(*) FROM organization WHERE kind = 'klant')::int AS klanten,
       (SELECT count(*) FROM organization WHERE kind = 'klant' AND created_at >= date_trunc('month', now()))::int AS nieuw,
       (SELECT count(*) FROM subscription WHERE status = 'actief')::int AS actief,
       (SELECT count(*) FROM subscription WHERE status = 'proef')::int AS proef,
       (SELECT count(*) FROM subscription WHERE status = 'achterstallig')::int AS achterstallig,
       (SELECT coalesce(sum(monthly_price_cents), 0) FROM subscription WHERE status IN ('actief', 'opgezegd', 'achterstallig'))::bigint AS mrr,
       (SELECT count(*) FROM payment WHERE status = 'mislukt' AND created_at > now() - interval '30 days')::int AS mislukt,
       (SELECT coalesce(sum(amount_incl_cents), 0) FROM payment WHERE status = 'open')::bigint AS open`,
  );
  return {
    klanten: Number(r?.klanten ?? 0),
    nieuwDezeMaand: Number(r?.nieuw ?? 0),
    actief: Number(r?.actief ?? 0),
    proef: Number(r?.proef ?? 0),
    achterstallig: Number(r?.achterstallig ?? 0),
    mrrCents: Number(r?.mrr ?? 0),
    mislukt30d: Number(r?.mislukt ?? 0),
    openstaandCents: Number(r?.open ?? 0),
  };
}

/** Wat vandaag aandacht vraagt. Later vullen agents deze lijst ook met voorstellen. */
export interface AttentionItem {
  kind: 'betaling_mislukt' | 'proef_loopt_af' | 'achterstallig';
  organizationId: string;
  organizationName: string;
  at: Date;
  detail: string;
}

export async function getAttention(q: Queryable, limit = 12): Promise<AttentionItem[]> {
  return many<AttentionItem>(
    q,
    `(SELECT 'betaling_mislukt' AS kind, o.id AS "organizationId", o.name AS "organizationName", p.created_at AS at, p.description AS detail
        FROM payment p JOIN organization o ON o.id = p.organization_id
       WHERE p.status = 'mislukt' AND p.created_at > now() - interval '30 days')
     UNION ALL
     (SELECT 'achterstallig', o.id, o.name, coalesce(s.current_period_end, s.created_at), s.plan
        FROM subscription s JOIN organization o ON o.id = s.organization_id
       WHERE s.status = 'achterstallig')
     UNION ALL
     (SELECT 'proef_loopt_af', o.id, o.name, s.trial_ends_at, s.plan
        FROM subscription s JOIN organization o ON o.id = s.organization_id
       WHERE s.status = 'proef' AND s.trial_ends_at BETWEEN now() AND now() + interval '3 days')
     ORDER BY at DESC LIMIT $1`,
    [limit],
  );
}

export interface CockpitAuditRow {
  id: string;
  at: Date;
  action: string;
  actor: string;
  actor_email: string | null;
  subject: string | null;
  organization_id: string | null;
  organization_name: string | null;
  detail: Record<string, unknown> | null;
}

/**
 * Audit-log voor de cockpit. Standaard alleen beheeracties (cockpit.* en ops.*);
 * met alles=true ook wat klanten zelf deden.
 */
export async function listCockpitAudit(
  q: Queryable,
  opts: { alles?: boolean; before?: string; limit?: number; zoek?: string } = {},
): Promise<CockpitAuditRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const before = opts.before && /^\d{1,18}$/.test(opts.before) ? opts.before : null;
  const zoek = opts.zoek?.trim().slice(0, 100) || null;
  return many<CockpitAuditRow>(
    q,
    `SELECT a.id::text, a.at, a.action, a.actor, u.email::text AS actor_email, a.subject,
            a.organization_id, o.name AS organization_name, a.detail
       FROM audit_log a
       LEFT JOIN app_user u ON u.id = a.actor_user_id
       LEFT JOIN organization o ON o.id = a.organization_id
      WHERE ($1::boolean OR a.action LIKE 'cockpit.%' OR a.action LIKE 'ops.%')
        AND ($2::bigint IS NULL OR a.id < $2::bigint)
        AND ($4::text IS NULL OR a.action ILIKE '%' || $4 || '%' OR u.email::text ILIKE '%' || $4 || '%' OR o.name ILIKE '%' || $4 || '%')
      ORDER BY a.id DESC LIMIT $3`,
    [Boolean(opts.alles), before, limit, zoek],
  );
}
