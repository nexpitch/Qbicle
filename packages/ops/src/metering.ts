import { PlatformError, withTransaction, type Queryable } from '@qbicle/platform';
import type { ModelPrice, UsageConfig } from './config.ts';
import type { OpsContext } from './context.ts';
import { limitStatus } from './usage.ts';

/**
 * Tokengebruik zoals de Anthropic API het teruggeeft in `response.usage`.
 * Structureel getypt, zodat dit pakket de SDK niet nodig heeft.
 */
export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

export interface AiCallInput {
  organizationId: string | null;
  /** Welke functie, bijv. 'samenvatting', 'actielijst', 'support-agent'. */
  feature: string;
  model: string;
  usage: TokenUsage;
  agentKey?: string | null;
  durationMs?: number | null;
  outcome?: 'ok' | 'fout' | 'geweigerd' | 'begrensd';
  /** Waar het over ging, bijv. een scan-id. Nooit de prompt of het antwoord. */
  ref?: string | null;
}

function priceFor(config: UsageConfig, model: string): { price: ModelPrice; known: boolean } {
  const exact = config.kosten.aiModellen[model];
  if (exact) return { price: exact, known: true };
  // Onbekend model: reken met het duurste, zodat kosten nooit te laag uitvallen.
  const all = Object.values(config.kosten.aiModellen);
  const dearest = all.reduce<ModelPrice | undefined>((a, b) => (!a || b.uitvoer > a.uitvoer ? b : a), undefined);
  return { price: dearest ?? { invoer: 0, uitvoer: 0, cacheLezen: 0, cacheSchrijven: 0 }, known: false };
}

/** Kosten van één aanroep in micro-euro's (afgerond naar boven). */
export function aiCostMicros(config: UsageConfig, model: string, u: TokenUsage): number {
  const { price } = priceFor(config, model);
  // Prijs is in dollars per miljoen tokens: dollars per token x 1e6 = micro-dollars per token.
  const microDollars =
    u.input_tokens * price.invoer +
    u.output_tokens * price.uitvoer +
    (u.cache_read_input_tokens ?? 0) * price.cacheLezen +
    (u.cache_creation_input_tokens ?? 0) * price.cacheSchrijven;
  return Math.ceil(microDollars * config.kosten.dollarNaarEuro);
}

function checkFeature(feature: string): string {
  const f = feature.trim();
  if (!f || f.length > 80) throw new PlatformError('ongeldige_invoer', 'Functienaam moet 1 tot 80 tekens zijn.');
  return f;
}

async function addDaily(
  q: Queryable,
  row: {
    organizationId: string | null;
    metric: 'api' | 'ai' | 'mail';
    feature: string;
    quantity: number;
    inputTokens?: number;
    outputTokens?: number;
    cacheRead?: number;
    cacheWrite?: number;
    costMicros?: number;
  },
): Promise<void> {
  await q.query(
    `INSERT INTO usage_daily AS u (organization_id, day, metric, feature, quantity, input_tokens, output_tokens,
                                   cache_read_tokens, cache_write_tokens, cost_micros)
     VALUES ($1, (now() AT TIME ZONE 'Europe/Amsterdam')::date, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT ON CONSTRAINT usage_daily_key DO UPDATE SET
       quantity = u.quantity + EXCLUDED.quantity,
       input_tokens = u.input_tokens + EXCLUDED.input_tokens,
       output_tokens = u.output_tokens + EXCLUDED.output_tokens,
       cache_read_tokens = u.cache_read_tokens + EXCLUDED.cache_read_tokens,
       cache_write_tokens = u.cache_write_tokens + EXCLUDED.cache_write_tokens,
       cost_micros = u.cost_micros + EXCLUDED.cost_micros`,
    [
      row.organizationId,
      row.metric,
      row.feature,
      row.quantity,
      row.inputTokens ?? 0,
      row.outputTokens ?? 0,
      row.cacheRead ?? 0,
      row.cacheWrite ?? 0,
      row.costMicros ?? 0,
    ],
  );
}

/**
 * Legt één AI-aanroep vast: per aanroep (ai_call) en opgeteld per dag (usage_daily).
 * Roep dit aan na elke aanroep van een model, ook als die mislukte.
 */
export async function recordAiCall(ctx: Pick<OpsContext, 'pool' | 'config'>, input: AiCallInput): Promise<{ costMicros: number }> {
  const feature = checkFeature(input.feature);
  const u = input.usage;
  for (const n of [u.input_tokens, u.output_tokens, u.cache_read_input_tokens ?? 0, u.cache_creation_input_tokens ?? 0]) {
    if (!Number.isInteger(n) || n < 0) throw new PlatformError('ongeldige_invoer', 'Tokenaantallen moeten gehele getallen >= 0 zijn.');
  }
  const costMicros = aiCostMicros(ctx.config, input.model, u);
  await withTransaction(ctx.pool, async (q) => {
    await q.query(
      `INSERT INTO ai_call (organization_id, feature, model, agent_key, input_tokens, output_tokens,
                            cache_read_tokens, cache_write_tokens, cost_micros, duration_ms, outcome, ref)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        input.organizationId,
        feature,
        input.model,
        input.agentKey ?? null,
        u.input_tokens,
        u.output_tokens,
        u.cache_read_input_tokens ?? 0,
        u.cache_creation_input_tokens ?? 0,
        costMicros,
        input.durationMs ?? null,
        input.outcome ?? 'ok',
        input.ref ?? null,
      ],
    );
    await addDaily(q, {
      organizationId: input.organizationId,
      metric: 'ai',
      feature,
      quantity: 1,
      inputTokens: u.input_tokens,
      outputTokens: u.output_tokens,
      cacheRead: u.cache_read_input_tokens ?? 0,
      cacheWrite: u.cache_creation_input_tokens ?? 0,
      costMicros,
    });
  });
  return { costMicros };
}

/** Telt API-aanroepen of verstuurde mails (per klant, per dag, per functie). */
export async function recordUsage(
  q: Queryable,
  input: { organizationId: string | null; metric: 'api' | 'mail'; feature?: string; quantity?: number },
): Promise<void> {
  const quantity = input.quantity ?? 1;
  if (!Number.isInteger(quantity) || quantity < 0) throw new PlatformError('ongeldige_invoer', 'Aantal moet een geheel getal >= 0 zijn.');
  await addDaily(q, { organizationId: input.organizationId, metric: input.metric, feature: (input.feature ?? '').slice(0, 80), quantity });
}

/**
 * Vóór een AI-aanroep voor een klant: weigert als de klant over zijn
 * maandlimiet voor tokens of AI-kosten zit. Interne aanroepen (zonder klant) gaan altijd door.
 */
export async function assertAiBudget(ctx: Pick<OpsContext, 'pool' | 'config'>, organizationId: string | null): Promise<void> {
  if (!organizationId) return;
  const status = await limitStatus(ctx, organizationId);
  const over = status.filter((s) => (s.metric === 'ai_tokens_maand' || s.metric === 'ai_kosten_maand') && s.status === 'over');
  if (over.length > 0) {
    throw new PlatformError('te_veel_verzoeken', 'De AI-limiet van dit pakket is voor deze maand bereikt.');
  }
}

/**
 * Hulpje rond een modelaanroep: controleert het budget, voert de aanroep uit en
 * legt het gebruik vast (ook bij een fout). `call` geeft het antwoord met `usage` en `model` terug.
 */
export async function meteredAiCall<T extends { usage: TokenUsage; model?: string }>(
  ctx: Pick<OpsContext, 'pool' | 'config'>,
  meta: { organizationId: string | null; feature: string; model: string; agentKey?: string | null; ref?: string | null },
  call: () => Promise<T>,
): Promise<T> {
  try {
    await assertAiBudget(ctx, meta.organizationId);
  } catch (err) {
    await recordAiCall(ctx, { ...meta, usage: { input_tokens: 0, output_tokens: 0 }, outcome: 'begrensd' });
    throw err;
  }
  const started = Date.now();
  try {
    const res = await call();
    const refused = (res as { stop_reason?: string }).stop_reason === 'refusal';
    await recordAiCall(ctx, {
      ...meta,
      model: res.model ?? meta.model,
      usage: res.usage,
      durationMs: Date.now() - started,
      outcome: refused ? 'geweigerd' : 'ok',
    });
    return res;
  } catch (err) {
    await recordAiCall(ctx, { ...meta, usage: { input_tokens: 0, output_tokens: 0 }, durationMs: Date.now() - started, outcome: 'fout' });
    throw err;
  }
}
