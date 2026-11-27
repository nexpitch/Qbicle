import { audit, many, one, PlatformError, type Actor, type Queryable } from '@qbicle/platform';

/**
 * Abonnementen, betalingen en betaalwijze voor de cockpit (alle klanten).
 * Prijzen komen uit config/abonnementen.json; een abonnement onthoudt de prijs
 * van het moment van afsluiten.
 */

export const PAYMENT_METHODS = ['incasso', 'factuur'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const SUB_STATUSES = ['lopend', 'proef', 'actief', 'achterstallig', 'opgezegd', 'beeindigd'] as const;
export type SubStatusFilter = (typeof SUB_STATUSES)[number];

export interface SubscriptionRow {
  id: string;
  organization_id: string;
  organization_name: string;
  plan: string;
  billing_interval: string;
  monthly_price_cents: number;
  status: string;
  trial_ends_at: Date | null;
  current_period_end: Date | null;
  cancel_at_period_end: boolean;
  payment_method: PaymentMethod;
  last_payment_status: string | null;
}

export async function listSubscriptions(
  q: Queryable,
  opts: {
    status?: SubStatusFilter;
    /** 'uitzondering': op factuur buiten de standaardregel (alleen Corporate met jaarcontract). */
    methode?: PaymentMethod | 'uitzondering' | null;
    /** Pakketten waarbij factuur standaard mag (Corporate); nodig voor 'uitzondering'. */
    factuurPakketten?: string[];
    zoek?: string;
    limit?: number;
    offset?: number;
  } = {},
): Promise<{ rows: SubscriptionRow[]; total: number; mrrCents: number }> {
  const status = opts.status ?? 'lopend';
  const methode = opts.methode ?? null;
  const pakketten = opts.factuurPakketten ?? [];
  const zoek = opts.zoek?.trim().slice(0, 100) || null;
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  const where = `
      WHERE (($1::text = 'lopend' AND s.status IN ('proef', 'actief', 'achterstallig', 'opgezegd')) OR s.status = $1)
        AND ($2::text IS NULL OR o.payment_method = $2
             OR ($2 = 'uitzondering' AND o.payment_method = 'factuur'
                 AND NOT (s.plan = ANY($4::text[]) AND s.billing_interval = 'jaar')))
        AND ($3::text IS NULL OR o.name ILIKE '%' || $3 || '%')`;
  const rows = await many<SubscriptionRow>(
    q,
    `SELECT s.id, s.organization_id, o.name AS organization_name, s.plan, s.billing_interval, s.monthly_price_cents, s.status,
            s.trial_ends_at, s.current_period_end, s.cancel_at_period_end, o.payment_method,
            (SELECT p.status FROM payment p WHERE p.subscription_id = s.id ORDER BY p.created_at DESC LIMIT 1) AS last_payment_status
       FROM subscription s JOIN organization o ON o.id = s.organization_id ${where}
      ORDER BY CASE s.status WHEN 'achterstallig' THEN 0 WHEN 'proef' THEN 1 ELSE 2 END, o.name
      LIMIT $5 OFFSET $6`,
    [status, methode, zoek, pakketten, limit, offset],
  );
  const t = await one<{ n: number; mrr: string }>(
    q,
    `SELECT count(*)::int AS n,
            coalesce(sum(s.monthly_price_cents) FILTER (WHERE s.status IN ('actief', 'opgezegd', 'achterstallig')), 0)::bigint AS mrr
       FROM subscription s JOIN organization o ON o.id = s.organization_id ${where}`,
    [status, methode, zoek, pakketten],
  );
  return { rows, total: t?.n ?? 0, mrrCents: Number(t?.mrr ?? 0) };
}

export const PAY_FILTERS = ['alle', 'open', 'betaald', 'mislukt', 'terugbetaald'] as const;
export type PayFilter = (typeof PAY_FILTERS)[number];

export interface PaymentRow {
  id: string;
  organization_id: string;
  organization_name: string;
  description: string;
  amount_incl_cents: number;
  status: string;
  provider: string;
  created_at: Date;
  paid_at: Date | null;
  refunded_cents: number;
  refunded_at: Date | null;
  invoice_id: string | null;
  invoice_number: string | null;
  payment_method: PaymentMethod;
}

/** Betalingen met hun factuur (als die er is): de basis voor het factuuroverzicht. */
export async function listPayments(
  q: Queryable,
  opts: { status?: PayFilter; zoek?: string; limit?: number; offset?: number } = {},
): Promise<{ rows: PaymentRow[]; total: number; totals: Record<'open' | 'betaald' | 'mislukt' | 'terugbetaald', number> }> {
  const status = opts.status ?? 'alle';
  const zoek = opts.zoek?.trim().slice(0, 100) || null;
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  const where = `
      WHERE ($1::text = 'alle'
             OR ($1 = 'terugbetaald' AND p.refunded_at IS NOT NULL)
             OR ($1 <> 'terugbetaald' AND p.status = $1 AND p.refunded_at IS NULL))
        AND ($2::text IS NULL OR o.name ILIKE '%' || $2 || '%' OR i.number ILIKE '%' || $2 || '%' OR p.description ILIKE '%' || $2 || '%')`;
  const from = `FROM payment p JOIN organization o ON o.id = p.organization_id LEFT JOIN invoice i ON i.payment_id = p.id`;
  const rows = await many<PaymentRow>(
    q,
    `SELECT p.id, p.organization_id, o.name AS organization_name, p.description, p.amount_incl_cents, p.status, p.provider,
            p.created_at, p.paid_at, p.refunded_cents, p.refunded_at, i.id AS invoice_id, i.number AS invoice_number, o.payment_method
       ${from} ${where}
      ORDER BY p.created_at DESC, p.id LIMIT $3 OFFSET $4`,
    [status, zoek, limit, offset],
  );
  const t = await one<Record<string, string>>(
    q,
    `SELECT count(*)::int AS n,
            coalesce(sum(p.amount_incl_cents) FILTER (WHERE p.status = 'open'), 0)::bigint AS open,
            coalesce(sum(p.amount_incl_cents) FILTER (WHERE p.status = 'betaald' AND p.refunded_at IS NULL), 0)::bigint AS betaald,
            coalesce(sum(p.amount_incl_cents) FILTER (WHERE p.status = 'mislukt'), 0)::bigint AS mislukt,
            coalesce(sum(p.refunded_cents), 0)::bigint AS terugbetaald
       ${from} ${where}`,
    [status, zoek],
  );
  return {
    rows,
    total: Number(t?.n ?? 0),
    totals: { open: Number(t?.open ?? 0), betaald: Number(t?.betaald ?? 0), mislukt: Number(t?.mislukt ?? 0), terugbetaald: Number(t?.terugbetaald ?? 0) },
  };
}

export interface PaymentSettings {
  payment_method: PaymentMethod;
  payment_terms_days: number;
  payment_method_note: string | null;
}

export async function getPaymentSettings(q: Queryable, organizationId: string): Promise<PaymentSettings> {
  const r = await one<PaymentSettings>(
    q,
    'SELECT payment_method, payment_terms_days, payment_method_note FROM organization WHERE id = $1',
    [organizationId],
  );
  if (!r) throw new PlatformError('niet_gevonden', 'Dit bedrijf bestaat niet.');
  return r;
}

/**
 * Betaalwijze per klant: automatische incasso (standaard) of factuur met
 * betaaltermijn. De reden komt in het audit-log, zodat later te zien is
 * waarom een klant geen incasso heeft.
 */
export async function setPaymentSettings(
  q: Queryable,
  organizationId: string,
  input: { methode: PaymentMethod; termijnDagen: number; notitie?: string | null },
  actor: Actor,
): Promise<void> {
  if (!PAYMENT_METHODS.includes(input.methode)) throw new PlatformError('ongeldige_invoer', 'Kies incasso of factuur.');
  if (!Number.isInteger(input.termijnDagen) || input.termijnDagen < 0 || input.termijnDagen > 90) {
    throw new PlatformError('ongeldige_invoer', 'Betaaltermijn is 0 tot 90 dagen.');
  }
  const note = input.notitie?.trim() || null;
  if (input.methode === 'factuur' && !note) {
    throw new PlatformError('ongeldige_invoer', 'Leg vast waarom deze klant op factuur betaalt (bijv. afspraak of contract).');
  }
  const before = await getPaymentSettings(q, organizationId);
  await q.query(
    'UPDATE organization SET payment_method = $2, payment_terms_days = $3, payment_method_note = $4 WHERE id = $1',
    [organizationId, input.methode, input.termijnDagen, note],
  );
  await audit(q, actor, {
    organizationId,
    action: 'cockpit.betaalwijze_gewijzigd',
    subject: organizationId,
    detail: { van: before.payment_method, naar: input.methode, termijn: input.termijnDagen, ...(note ? { reden: note } : {}) },
  });
}
