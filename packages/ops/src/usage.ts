import { many, one, type Queryable } from '@qbicle/platform';
import { LIMIT_METRICS, type LimitMetric, type Limits } from './config.ts';
import type { OpsContext } from './context.ts';

type Ctx = Pick<OpsContext, 'pool' | 'config'>;

/** Pakket waarop limieten gelden: proef, het betaalde pakket, of gratis. */
export async function currentPlan(q: Queryable, organizationId: string): Promise<string> {
  const s = await one<{ plan: string; status: string }>(
    q,
    `SELECT plan, status FROM subscription
      WHERE organization_id = $1 AND status IN ('proef', 'actief', 'achterstallig', 'opgezegd')`,
    [organizationId],
  );
  if (!s) return 'gratis';
  return s.status === 'proef' ? 'proef' : s.plan;
}

export async function effectiveLimits(ctx: Ctx, organizationId: string): Promise<{ plan: string; limits: Limits; overrides: LimitMetric[] }> {
  const plan = await currentPlan(ctx.pool, organizationId);
  const limits = { ...(ctx.config.limieten[plan] ?? ctx.config.limieten.gratis!) };
  const rows = await many<{ metric: LimitMetric; limit_value: string | null }>(
    ctx.pool,
    'SELECT metric, limit_value FROM usage_limit_override WHERE organization_id = $1',
    [organizationId],
  );
  for (const r of rows) {
    // Kosten staan in de override in micro-euro's; in de config in euro's.
    const v = r.limit_value === null ? null : Number(r.limit_value);
    limits[r.metric] = v !== null && r.metric === 'ai_kosten_maand' ? v / 1_000_000 : v;
  }
  return { plan, limits, overrides: rows.map((r) => r.metric) };
}

export interface UsageTotals {
  scans: number;
  scansMislukt: number;
  apiCalls: number;
  aiCalls: number;
  aiInputTokens: number;
  aiOutputTokens: number;
  aiCacheTokens: number;
  aiCostMicros: number;
  mails: number;
}

/** Gebruik van één klant in een periode [from, to). Datums als 'YYYY-MM-DD'. */
export async function usageTotals(q: Queryable, organizationId: string, from: string, to: string): Promise<UsageTotals> {
  const u = await one<Record<string, string>>(
    q,
    `SELECT
       coalesce(sum(quantity) FILTER (WHERE metric = 'api'), 0) AS api,
       coalesce(sum(quantity) FILTER (WHERE metric = 'ai'), 0) AS ai,
       coalesce(sum(input_tokens) FILTER (WHERE metric = 'ai'), 0) AS ai_in,
       coalesce(sum(output_tokens) FILTER (WHERE metric = 'ai'), 0) AS ai_out,
       coalesce(sum(cache_read_tokens + cache_write_tokens) FILTER (WHERE metric = 'ai'), 0) AS ai_cache,
       coalesce(sum(cost_micros) FILTER (WHERE metric = 'ai'), 0) AS ai_cost,
       coalesce(sum(quantity) FILTER (WHERE metric = 'mail'), 0) AS mail
     FROM usage_daily WHERE organization_id = $1 AND day >= $2::date AND day < $3::date`,
    [organizationId, from, to],
  );
  const s = await one<{ n: string; mislukt: string }>(
    q,
    `SELECT count(*) AS n, count(*) FILTER (WHERE s.status = 'mislukt') AS mislukt
       FROM scan s JOIN domain d ON d.id = s.domain_id
      WHERE d.organization_id = $1
        AND (s.created_at AT TIME ZONE 'Europe/Amsterdam')::date >= $2::date
        AND (s.created_at AT TIME ZONE 'Europe/Amsterdam')::date < $3::date`,
    [organizationId, from, to],
  );
  return {
    scans: Number(s?.n ?? 0),
    scansMislukt: Number(s?.mislukt ?? 0),
    apiCalls: Number(u?.api ?? 0),
    aiCalls: Number(u?.ai ?? 0),
    aiInputTokens: Number(u?.ai_in ?? 0),
    aiOutputTokens: Number(u?.ai_out ?? 0),
    aiCacheTokens: Number(u?.ai_cache ?? 0),
    aiCostMicros: Number(u?.ai_cost ?? 0),
    mails: Number(u?.mail ?? 0),
  };
}

/** Begin van de huidige maand en vandaag (Nederlandse tijd), als 'YYYY-MM-DD'. */
async function periodBounds(q: Queryable): Promise<{ monthStart: string; today: string; tomorrow: string }> {
  const r = await one<{ m: string; t: string; n: string }>(
    q,
    `SELECT to_char(date_trunc('month', now() AT TIME ZONE 'Europe/Amsterdam'), 'YYYY-MM-DD') AS m,
            to_char(now() AT TIME ZONE 'Europe/Amsterdam', 'YYYY-MM-DD') AS t,
            to_char((now() AT TIME ZONE 'Europe/Amsterdam') + interval '1 day', 'YYYY-MM-DD') AS n`,
  );
  return { monthStart: r!.m, today: r!.t, tomorrow: r!.n };
}

export interface LimitState {
  metric: LimitMetric;
  used: number;
  limit: number | null;
  /** Procent van de limiet (afgerond), null bij onbeperkt. */
  pct: number | null;
  status: 'ok' | 'waarschuwing' | 'over';
}

/** Hoe ver een klant deze maand (en vandaag, voor API) van zijn limieten zit. */
export async function limitStatus(ctx: Ctx, organizationId: string): Promise<LimitState[]> {
  const { limits } = await effectiveLimits(ctx, organizationId);
  const b = await periodBounds(ctx.pool);
  const month = await usageTotals(ctx.pool, organizationId, b.monthStart, b.tomorrow);
  const today = await usageTotals(ctx.pool, organizationId, b.today, b.tomorrow);
  const used: Record<LimitMetric, number> = {
    scans_maand: month.scans,
    api_dag: today.apiCalls,
    ai_tokens_maand: month.aiInputTokens + month.aiOutputTokens,
    ai_kosten_maand: month.aiCostMicros / 1_000_000,
  };
  const warn = ctx.config.signalen.limietWaarschuwingProcent;
  return LIMIT_METRICS.map((metric) => {
    const limit = limits[metric];
    const u = used[metric];
    if (limit === null) return { metric, used: u, limit, pct: null, status: 'ok' as const };
    const pct = limit === 0 ? (u > 0 ? 100 : 0) : Math.round((u / limit) * 100);
    const over = limit === 0 ? u > 0 : u >= limit;
    const status = over ? 'over' : pct >= warn ? 'waarschuwing' : 'ok';
    return { metric, used: u, limit, pct, status };
  });
}

export interface UsageOverviewRow {
  organization_id: string;
  name: string;
  plan: string;
  subscription_status: string | null;
  assets: number;
  domains: number;
  scans: number;
  scans_mislukt: number;
  api_calls: number;
  ai_tokens: number;
  ai_cost_micros: number;
  mails: number;
  /** Maandbedrag excl. btw (centen) van het lopende abonnement; 0 bij proef of gratis. */
  mrr_cents: number;
  /** Geschatte kosten voor Qbicle in de periode (micro-euro's): AI + scans + mail. */
  cost_micros: number;
  /** mrr - kosten, in centen. Alleen zinvol voor een periode van ongeveer een maand. */
  margin_cents: number;
}

/**
 * Gebruik, kosten en marge per klant over [from, to). Voor de lijst in de cockpit.
 * Alleen klanten (geen IT-partners zonder eigen abonnement zonder gebruik).
 */
export async function usageOverview(ctx: Ctx, from: string, to: string, opts: { limit?: number } = {}): Promise<UsageOverviewRow[]> {
  const k = ctx.config.kosten;
  const rows = await many<Record<string, string | null>>(
    ctx.pool,
    `WITH u AS (
       SELECT organization_id,
              sum(quantity) FILTER (WHERE metric = 'api') AS api,
              sum(input_tokens + output_tokens) FILTER (WHERE metric = 'ai') AS ai_tokens,
              sum(cost_micros) FILTER (WHERE metric = 'ai') AS ai_cost,
              sum(quantity) FILTER (WHERE metric = 'mail') AS mails
         FROM usage_daily WHERE day >= $1::date AND day < $2::date AND organization_id IS NOT NULL
        GROUP BY organization_id),
     s AS (
       SELECT d.organization_id, count(*) AS scans, count(*) FILTER (WHERE s.status = 'mislukt') AS mislukt
         FROM scan s JOIN domain d ON d.id = s.domain_id
        WHERE (s.created_at AT TIME ZONE 'Europe/Amsterdam')::date >= $1::date
          AND (s.created_at AT TIME ZONE 'Europe/Amsterdam')::date < $2::date
        GROUP BY d.organization_id),
     a AS (SELECT organization_id, count(*) AS n FROM asset GROUP BY organization_id),
     dm AS (SELECT organization_id, count(*) AS n FROM domain GROUP BY organization_id),
     sub AS (SELECT organization_id, plan, status, monthly_price_cents FROM subscription
              WHERE status IN ('proef', 'actief', 'achterstallig', 'opgezegd'))
     SELECT o.id AS organization_id, o.name,
            CASE WHEN sub.status = 'proef' THEN 'proef' ELSE coalesce(sub.plan, 'gratis') END AS plan,
            sub.status AS subscription_status,
            coalesce(a.n, 0) AS assets, coalesce(dm.n, 0) AS domains,
            coalesce(s.scans, 0) AS scans, coalesce(s.mislukt, 0) AS scans_mislukt,
            coalesce(u.api, 0) AS api_calls, coalesce(u.ai_tokens, 0) AS ai_tokens,
            coalesce(u.ai_cost, 0) AS ai_cost_micros, coalesce(u.mails, 0) AS mails,
            CASE WHEN sub.status IN ('actief', 'achterstallig', 'opgezegd') THEN sub.monthly_price_cents ELSE 0 END AS mrr_cents
       FROM organization o
       LEFT JOIN u ON u.organization_id = o.id
       LEFT JOIN s ON s.organization_id = o.id
       LEFT JOIN a ON a.organization_id = o.id
       LEFT JOIN dm ON dm.organization_id = o.id
       LEFT JOIN sub ON sub.organization_id = o.id
      WHERE o.kind = 'klant' OR sub.organization_id IS NOT NULL OR u.organization_id IS NOT NULL
      ORDER BY coalesce(u.ai_cost, 0) DESC, o.name
      LIMIT $3`,
    [from, to, Math.min(Math.max(opts.limit ?? 500, 1), 5000)],
  );
  return rows.map((r) => {
    const scans = Number(r.scans);
    const mails = Number(r.mails);
    const aiCost = Number(r.ai_cost_micros);
    const cost = aiCost + Math.round(scans * k.perScanEuro * 1e6) + Math.round(mails * k.perMailEuro * 1e6);
    const mrr = Number(r.mrr_cents);
    return {
      organization_id: r.organization_id!,
      name: r.name!,
      plan: r.plan!,
      subscription_status: r.subscription_status ?? null,
      assets: Number(r.assets),
      domains: Number(r.domains),
      scans,
      scans_mislukt: Number(r.scans_mislukt),
      api_calls: Number(r.api_calls),
      ai_tokens: Number(r.ai_tokens),
      ai_cost_micros: aiCost,
      mails,
      mrr_cents: mrr,
      cost_micros: cost,
      margin_cents: mrr - Math.round(cost / 10_000),
    };
  });
}

export interface TrendPoint {
  day: string;
  scans: number;
  api_calls: number;
  ai_tokens: number;
  ai_cost_micros: number;
}

/** Gebruik per dag over de laatste `days` dagen; zonder klant = hele platform. */
export async function usageTrend(q: Queryable, organizationId: string | null, days = 30): Promise<TrendPoint[]> {
  const n = Math.min(Math.max(Math.trunc(days), 1), 366);
  const rows = await many<Record<string, string>>(
    q,
    `WITH days AS (
       SELECT generate_series((now() AT TIME ZONE 'Europe/Amsterdam')::date - ($2::int - 1),
                              (now() AT TIME ZONE 'Europe/Amsterdam')::date, interval '1 day')::date AS day),
     u AS (
       SELECT day, sum(quantity) FILTER (WHERE metric = 'api') AS api,
              sum(input_tokens + output_tokens) FILTER (WHERE metric = 'ai') AS tok,
              sum(cost_micros) FILTER (WHERE metric = 'ai') AS cost
         FROM usage_daily WHERE ($1::uuid IS NULL OR organization_id = $1) GROUP BY day),
     s AS (
       SELECT (s.created_at AT TIME ZONE 'Europe/Amsterdam')::date AS day, count(*) AS n
         FROM scan s JOIN domain d ON d.id = s.domain_id
        WHERE ($1::uuid IS NULL OR d.organization_id = $1) GROUP BY 1)
     SELECT to_char(days.day, 'YYYY-MM-DD') AS day, coalesce(s.n, 0) AS scans, coalesce(u.api, 0) AS api,
            coalesce(u.tok, 0) AS tok, coalesce(u.cost, 0) AS cost
       FROM days LEFT JOIN u ON u.day = days.day LEFT JOIN s ON s.day = days.day
      ORDER BY days.day`,
    [organizationId, n],
  );
  return rows.map((r) => ({
    day: r.day!,
    scans: Number(r.scans),
    api_calls: Number(r.api),
    ai_tokens: Number(r.tok),
    ai_cost_micros: Number(r.cost),
  }));
}

export interface FeatureUsage {
  feature: string;
  model: string;
  calls: number;
  failed: number;
  input_tokens: number;
  output_tokens: number;
  cost_micros: number;
  avg_duration_ms: number | null;
}

/** AI-gebruik per functie en model over de laatste `days` dagen. */
export async function aiUsageByFeature(q: Queryable, organizationId: string | null, days = 30): Promise<FeatureUsage[]> {
  const rows = await many<Record<string, string | null>>(
    q,
    `SELECT feature, model, count(*) AS calls, count(*) FILTER (WHERE outcome <> 'ok') AS failed,
            sum(input_tokens) AS i, sum(output_tokens) AS o, sum(cost_micros) AS c, round(avg(duration_ms)) AS d
       FROM ai_call
      WHERE at > now() - make_interval(days => $2) AND ($1::uuid IS NULL OR organization_id = $1)
      GROUP BY feature, model ORDER BY sum(cost_micros) DESC`,
    [organizationId, Math.min(Math.max(Math.trunc(days), 1), 366)],
  );
  return rows.map((r) => ({
    feature: r.feature!,
    model: r.model!,
    calls: Number(r.calls),
    failed: Number(r.failed),
    input_tokens: Number(r.i),
    output_tokens: Number(r.o),
    cost_micros: Number(r.c),
    avg_duration_ms: r.d === null ? null : Number(r.d),
  }));
}

export interface UsageSignal {
  organizationId: string;
  organizationName: string;
  kind: 'afwijkend' | 'limiet_bijna' | 'limiet_over';
  metric: string;
  value: number;
  /** Bij 'afwijkend': daggemiddelde van de 28 dagen ervoor; bij limiet: de limiet. */
  reference: number | null;
  message: string;
}

const METRIC_NL: Record<string, string> = {
  api: 'API-aanroepen',
  ai_tokens: 'AI-tokens',
  scans: 'scans',
  scans_maand: 'scans deze maand',
  api_dag: 'API-aanroepen vandaag',
  ai_tokens_maand: 'AI-tokens deze maand',
  ai_kosten_maand: 'AI-kosten deze maand (euro)',
};

/**
 * Signalen voor de cockpit en de bewakingsagent: afwijkend gebruik vandaag
 * ten opzichte van de 28 dagen ervoor, en klanten die hun limiet naderen of overschrijden.
 */
export async function detectUsageSignals(ctx: Ctx): Promise<UsageSignal[]> {
  const sig = ctx.config.signalen;
  const rows = await many<{ organization_id: string; name: string; metric: string; today: string; baseline: string }>(
    ctx.pool,
    `WITH bounds AS (SELECT (now() AT TIME ZONE 'Europe/Amsterdam')::date AS today),
     daily AS (
       SELECT organization_id, day, 'api' AS metric, sum(quantity) AS v FROM usage_daily
        WHERE metric = 'api' AND organization_id IS NOT NULL GROUP BY 1, 2
       UNION ALL
       SELECT organization_id, day, 'ai_tokens', sum(input_tokens + output_tokens) FROM usage_daily
        WHERE metric = 'ai' AND organization_id IS NOT NULL GROUP BY 1, 2
       UNION ALL
       SELECT d.organization_id, (s.created_at AT TIME ZONE 'Europe/Amsterdam')::date, 'scans', count(*)
         FROM scan s JOIN domain d ON d.id = s.domain_id GROUP BY 1, 2)
     SELECT x.organization_id, o.name, x.metric,
            coalesce(sum(x.v) FILTER (WHERE x.day = b.today), 0) AS today,
            coalesce(sum(x.v) FILTER (WHERE x.day >= b.today - 28 AND x.day < b.today), 0) / 28.0 AS baseline
       FROM daily x CROSS JOIN bounds b JOIN organization o ON o.id = x.organization_id
      WHERE x.day >= b.today - 28
      GROUP BY x.organization_id, o.name, x.metric`,
  );
  const out: UsageSignal[] = [];
  for (const r of rows) {
    const today = Number(r.today);
    const base = Number(r.baseline);
    const min = sig.minimum[r.metric as keyof typeof sig.minimum] ?? Infinity;
    if (today >= min && today > base * sig.factor) {
      out.push({
        organizationId: r.organization_id,
        organizationName: r.name,
        kind: 'afwijkend',
        metric: r.metric,
        value: today,
        reference: Math.round(base * 10) / 10,
        message: `${r.name}: ${today} ${METRIC_NL[r.metric]} vandaag, normaal ongeveer ${Math.round(base)} per dag.`,
      });
    }
  }
  // Limieten: alleen klanten met gebruik deze maand.
  const active = await many<{ id: string; name: string }>(
    ctx.pool,
    `SELECT DISTINCT o.id, o.name FROM organization o
      WHERE EXISTS (SELECT 1 FROM usage_daily u WHERE u.organization_id = o.id
                     AND u.day >= date_trunc('month', now() AT TIME ZONE 'Europe/Amsterdam')::date)
         OR EXISTS (SELECT 1 FROM scan s JOIN domain d ON d.id = s.domain_id WHERE d.organization_id = o.id
                     AND s.created_at >= date_trunc('month', now() AT TIME ZONE 'Europe/Amsterdam') AT TIME ZONE 'Europe/Amsterdam')`,
  );
  for (const o of active) {
    for (const l of await limitStatus(ctx, o.id)) {
      if (l.status === 'ok') continue;
      out.push({
        organizationId: o.id,
        organizationName: o.name,
        kind: l.status === 'over' ? 'limiet_over' : 'limiet_bijna',
        metric: l.metric,
        value: l.used,
        reference: l.limit,
        message: `${o.name}: ${METRIC_NL[l.metric]} ${formatNum(l.used)} van ${formatNum(l.limit!)} (${l.pct}%).`,
      });
    }
  }
  return out;
}

function formatNum(n: number): string {
  return Number.isInteger(n) ? n.toLocaleString('nl-NL') : n.toLocaleString('nl-NL', { maximumFractionDigits: 2 });
}

/** Afwijkende limiet voor één klant instellen (alleen via een goedgekeurd voorstel of een medewerker). */
export async function setLimitOverride(
  q: Queryable,
  input: { organizationId: string; metric: LimitMetric; limit: number | null; reason: string; setBy: string | null },
): Promise<void> {
  const stored = input.limit === null ? null : input.metric === 'ai_kosten_maand' ? Math.round(input.limit * 1_000_000) : Math.round(input.limit);
  await q.query(
    `INSERT INTO usage_limit_override (organization_id, metric, limit_value, reason, set_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (organization_id, metric) DO UPDATE
       SET limit_value = EXCLUDED.limit_value, reason = EXCLUDED.reason, set_by = EXCLUDED.set_by, set_at = now()`,
    [input.organizationId, input.metric, stored, input.reason, input.setBy],
  );
}
