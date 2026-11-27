import {
  audit,
  findPlan,
  isNepProvider,
  many,
  one,
  periodLines,
  PlatformError,
  syncPayment,
  withTransaction,
  type Actor,
  type InvoiceLine,
  type Platform,
  type Queryable,
} from '@qbicle/platform';
import { createFollowupSuggestion } from './followups.ts';

/**
 * Incassobatches. Een agent (of geplande taak) zet de verlengingen klaar, een
 * medewerker controleert en valideert, en dient daarna met één knop in.
 *
 * Veiligheid:
 * - Alleen klanten met betaalwijze 'incasso' en een actief of achterstallig abonnement.
 * - Dezelfde periode van een abonnement kan nooit twee keer in een batch (unieke index).
 * - Na valideren is niets meer te wijzigen; indienen kan alleen vanuit 'gevalideerd'
 *   en maar één keer (rij-lock op de batch).
 * - Elke stap komt in het audit-log.
 */

export type RunStatus = 'concept' | 'gevalideerd' | 'ingediend' | 'afgerond' | 'geannuleerd';
export type ItemStatus = 'klaar' | 'uitgesloten' | 'ingediend' | 'betaald' | 'mislukt';
export const FAILURE_REASONS = ['storno', 'geen_dekking', 'mandaat_ingetrokken', 'rekening_opgeheven', 'onbekend'] as const;
export type FailureReason = (typeof FAILURE_REASONS)[number];

export const FAILURE_LABEL: Record<FailureReason, string> = {
  storno: 'Storno door klant',
  geen_dekking: 'Geen dekking',
  mandaat_ingetrokken: 'Mandaat ingetrokken',
  rekening_opgeheven: 'Rekening opgeheven',
  onbekend: 'Onbekende reden',
};

export interface RunRow {
  id: string;
  collection_date: Date;
  status: RunStatus;
  source: string;
  provider: string;
  created_at: Date;
  created_by_email: string | null;
  validated_at: Date | null;
  validated_by_email: string | null;
  submitted_at: Date | null;
  submitted_by_email: string | null;
  items: number;
  included: number;
  total_incl_cents: number;
  paid: number;
  failed: number;
}

const RUN_SELECT = `
  SELECT r.id, r.collection_date, r.status, r.source, r.provider, r.created_at,
         cu.email::text AS created_by_email, r.validated_at, vu.email::text AS validated_by_email,
         r.submitted_at, su.email::text AS submitted_by_email,
         (SELECT count(*) FROM collection_item i WHERE i.run_id = r.id)::int AS items,
         (SELECT count(*) FROM collection_item i WHERE i.run_id = r.id AND i.status <> 'uitgesloten')::int AS included,
         (SELECT coalesce(sum(i.amount_incl_cents), 0) FROM collection_item i WHERE i.run_id = r.id AND i.status <> 'uitgesloten')::bigint AS total_incl_cents,
         (SELECT count(*) FROM collection_item i WHERE i.run_id = r.id AND i.status = 'betaald')::int AS paid,
         (SELECT count(*) FROM collection_item i WHERE i.run_id = r.id AND i.status = 'mislukt')::int AS failed
    FROM collection_run r
    LEFT JOIN app_user cu ON cu.id = r.created_by
    LEFT JOIN app_user vu ON vu.id = r.validated_by
    LEFT JOIN app_user su ON su.id = r.submitted_by`;

function toRun(r: RunRow): RunRow {
  return { ...r, total_incl_cents: Number(r.total_incl_cents) };
}

export async function listRuns(q: Queryable, limit = 30): Promise<RunRow[]> {
  return (await many<RunRow>(q, `${RUN_SELECT} ORDER BY r.created_at DESC LIMIT $1`, [limit])).map(toRun);
}

export async function getRun(q: Queryable, id: string): Promise<RunRow> {
  const r = await one<RunRow>(q, `${RUN_SELECT} WHERE r.id = $1`, [id]);
  if (!r) throw new PlatformError('niet_gevonden', 'Deze incassobatch bestaat niet.');
  return toRun(r);
}

export interface ItemRow {
  id: string;
  organization_id: string;
  organization_name: string;
  subscription_id: string;
  description: string;
  period_start: Date;
  period_end: Date;
  amount_excl_cents: number;
  vat_cents: number;
  amount_incl_cents: number;
  original_excl_cents: number | null;
  adjust_reason: string | null;
  status: ItemStatus;
  exclude_reason: string | null;
  auto_excluded: boolean;
  payment_id: string | null;
  failure_reason: FailureReason | null;
  result_at: Date | null;
  lines: InvoiceLine[] | null;
  /** Mislukte incasso's van deze klant in de laatste 180 dagen (signaal bij controleren). */
  recent_failures: number;
}

export async function listItems(q: Queryable, runId: string): Promise<ItemRow[]> {
  return many<ItemRow>(
    q,
    `SELECT i.*, o.name AS organization_name,
            (SELECT count(*) FROM collection_item f WHERE f.organization_id = i.organization_id AND f.status = 'mislukt'
                AND f.result_at > now() - interval '180 days')::int AS recent_failures
       FROM collection_item i JOIN organization o ON o.id = i.organization_id
      WHERE i.run_id = $1
      ORDER BY i.status = 'uitgesloten', o.name`,
    [runId],
  );
}

/** Verder vooruit klaarzetten of indienen kan niet (tikfout in de datum, of een periode die nog lang loopt). */
export const MAX_DAYS_AHEAD = 14;

/** Datum (JJJJ-MM-DD) zoals in Nederland. */
export function amsterdamDate(d: Date): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Amsterdam' }).format(d);
}

function isRealDate(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/**
 * Zet een nieuwe batch klaar met alle verlengingen die op of vóór de incassodatum
 * vervallen. Geeft undefined als er niets te incasseren is.
 */
export async function prepareRun(
  p: Platform,
  input: { collectionDate: string; source?: 'medewerker' | 'agent' | 'systeem' },
  actor: Actor,
): Promise<{ runId: string; items: number; skippedFactuur: number; skippedMandate: number } | undefined> {
  if (!isRealDate(input.collectionDate)) throw new PlatformError('ongeldige_invoer', 'Kies een geldige incassodatum.');
  const today = amsterdamDate(new Date());
  const latest = amsterdamDate(new Date(Date.now() + MAX_DAYS_AHEAD * 86_400_000));
  if (input.collectionDate < today || input.collectionDate > latest) {
    throw new PlatformError('ongeldige_invoer', `Kies een incassodatum van vandaag tot en met ${MAX_DAYS_AHEAD} dagen vooruit.`);
  }
  const date = new Date(`${input.collectionDate}T23:59:59Z`);
  const btw = p.catalog.btwPercentage;
  return withTransaction(p.pool, async (q) => {
    // Eén batch tegelijk klaarzetten (voorkomt dubbele regels bij gelijktijdige agents).
    await q.query(`SELECT pg_advisory_xact_lock(hashtext('qbicle-incasso-klaarzetten'))`);
    const due = await many<{
      id: string;
      organization_id: string;
      plan: string;
      billing_interval: string;
      monthly_price_cents: number;
      current_period_end: Date;
      pending_plan: string | null;
      pending_interval: 'maand' | 'jaar' | null;
    }>(
      q,
      `SELECT s.id, s.organization_id, s.plan, s.billing_interval, s.monthly_price_cents, s.current_period_end, s.pending_plan, s.pending_interval
         FROM subscription s JOIN organization o ON o.id = s.organization_id
        -- Zelfde regel als needsRenewal() in billing.ts: ook een opgezegd abonnement binnen
        -- de opzegtermijn krijgt nog één verlenging.
        WHERE ((s.status IN ('actief', 'achterstallig') AND NOT s.cancel_at_period_end)
               OR (s.status = 'opgezegd' AND NOT s.cancel_at_period_end AND s.ends_at > s.current_period_end))
          AND o.payment_method = 'incasso'
          AND s.current_period_end IS NOT NULL
          AND s.current_period_end <= $1
          AND NOT EXISTS (SELECT 1 FROM collection_item i
                           WHERE i.subscription_id = s.id AND i.period_start = s.current_period_end
                             AND (i.status <> 'uitgesloten' OR i.failure_reason IS NOT NULL))
          -- Bijbetalingen voor een upgrade (plan_change) zijn geen verlenging.
          AND NOT EXISTS (SELECT 1 FROM payment pm
                           WHERE pm.subscription_id = s.id AND pm.period_start = s.current_period_end
                             AND pm.status IN ('open', 'betaald') AND pm.plan_change IS NULL)
        ORDER BY o.name`,
      [date],
    );
    const skipped = await one<{ n: number }>(
      q,
      `SELECT count(*)::int AS n FROM subscription s JOIN organization o ON o.id = s.organization_id
        WHERE ((s.status IN ('actief', 'achterstallig') AND NOT s.cancel_at_period_end)
               OR (s.status = 'opgezegd' AND NOT s.cancel_at_period_end AND s.ends_at > s.current_period_end))
          AND o.payment_method = 'factuur' AND s.current_period_end <= $1`,
      [date],
    );
    if (due.length === 0) return undefined;

    const run = await one<{ id: string }>(
      q,
      `INSERT INTO collection_run (collection_date, source, provider, created_by) VALUES ($1, $2, $3, $4) RETURNING id`,
      [input.collectionDate, input.source ?? 'medewerker', p.payments.name, actor.userId],
    );
    let noMandate = 0;
    for (const due1 of due) {
      // Geplande downgrade of andere betaaltermijn: reken met het nieuwe pakket, maar wijzig nog niets.
      // De wissel gaat pas in als de betaling binnen is (syncPayment) of de klant zelf betaalt.
      const pendingPlan = due1.pending_plan && due1.pending_interval ? findPlan(p.catalog, due1.pending_plan) : undefined;
      const s = pendingPlan
        ? { plan: pendingPlan.id, interval: due1.pending_interval!, monthlyPriceCents: pendingPlan.maandprijsCenten[due1.pending_interval!] }
        : { plan: due1.plan, interval: due1.billing_interval as 'maand' | 'jaar', monthlyPriceCents: due1.monthly_price_cents };
      const plan = findPlan(p.catalog, s.plan);
      const label = new Date(due1.current_period_end).toLocaleDateString('nl-NL', { month: 'long', year: 'numeric', timeZone: 'Europe/Amsterdam' });
      const description = `${plan?.naam ?? s.plan}, ${s.interval === 'jaar' ? 'jaar vanaf ' : ''}${label}`;
      // Pakket plus add-ons (extra domeinen boven de limiet).
      const lines: InvoiceLine[] = plan
        ? await periodLines(p, q, due1.organization_id, plan, s.interval, s.monthlyPriceCents, description)
        : [{ omschrijving: description, aantal: 1, prijsExclCenten: s.monthlyPriceCents * (s.interval === 'jaar' ? 12 : 1), totaalExclCenten: s.monthlyPriceCents * (s.interval === 'jaar' ? 12 : 1) }];
      const excl = lines.reduce((t, l) => t + l.totaalExclCenten, 0);
      const vat = Math.round((excl * btw) / 100);
      // Klant heeft de machtiging ingetrokken: niet incasseren, wel meteen een vervolgvoorstel (betaallink).
      const revoked = await one<{ revoked: boolean }>(
        q,
        `SELECT bool_or(status = 'ingetrokken') AND NOT bool_or(status = 'geldig') AS revoked FROM payment_mandate WHERE organization_id = $1`,
        [due1.organization_id],
      );
      const mandateGone = revoked?.revoked === true;
      if (mandateGone) noMandate++;
      // Periode uit de database zelf (microseconden), zodat de unieke index dubbel incasseren echt tegenhoudt.
      const item = await one<{ id: string }>(
        q,
        `INSERT INTO collection_item (run_id, organization_id, subscription_id, description, period_start, period_end,
                                      amount_excl_cents, vat_cents, amount_incl_cents, lines, status, exclude_reason, failure_reason,
                                      plan, billing_interval)
         SELECT $1, s.organization_id, s.id, $3, s.current_period_end,
                -- Periode met dezelfde termijn als het bedrag (ook bij een geplande termijnwissel).
                s.current_period_end + CASE WHEN $12 = 'jaar' THEN interval '1 year' ELSE interval '1 month' END,
                $4, $5, $6, $7, $8, $9, $10, $11, $12
           FROM subscription s WHERE s.id = $2
         RETURNING id`,
        [
          run!.id,
          due1.id,
          description,
          excl,
          vat,
          excl + vat,
          lines.length > 1 ? JSON.stringify(lines) : null,
          mandateGone ? 'uitgesloten' : 'klaar',
          mandateGone ? 'Machtiging ingetrokken door de klant; zie Mislukt voor het betaalverzoek.' : null,
          mandateGone ? 'mandaat_ingetrokken' : null,
          s.plan,
          s.interval,
        ],
      );
      if (mandateGone) await createFollowupSuggestion(q, p.config.appOrigin, item!.id);
    }
    await audit(q, actor, {
      organizationId: null,
      action: 'cockpit.incasso_klaargezet',
      subject: run!.id,
      detail: { regels: due.length, incassodatum: input.collectionDate, bron: input.source ?? 'medewerker', ...(noMandate ? { zonderMachtiging: noMandate } : {}) },
    });
    return { runId: run!.id, items: due.length - noMandate, skippedFactuur: skipped?.n ?? 0, skippedMandate: noMandate };
  });
}

async function lockRun(q: Queryable, runId: string): Promise<{ status: RunStatus; provider: string }> {
  const r = await one<{ status: RunStatus; provider: string }>(q, 'SELECT status, provider FROM collection_run WHERE id = $1 FOR UPDATE', [runId]);
  if (!r) throw new PlatformError('niet_gevonden', 'Deze incassobatch bestaat niet.');
  return r;
}

async function lockConceptItem(q: Queryable, runId: string, itemId: string) {
  const run = await lockRun(q, runId);
  if (run.status !== 'concept') throw new PlatformError('conflict', 'Deze batch is al gevalideerd. Zet hem eerst terug naar concept.');
  const item = await one<{ status: ItemStatus; organization_id: string; amount_excl_cents: number; original_excl_cents: number | null; subscription_id: string; period_start: Date; failure_reason: FailureReason | null }>(
    q,
    'SELECT status, organization_id, amount_excl_cents, original_excl_cents, subscription_id, period_start, failure_reason FROM collection_item WHERE id = $1 AND run_id = $2 FOR UPDATE',
    [itemId, runId],
  );
  if (!item) throw new PlatformError('niet_gevonden', 'Deze regel bestaat niet.');
  return item;
}

export async function excludeItem(p: Platform, runId: string, itemId: string, reason: string, actor: Actor): Promise<void> {
  const why = reason.trim();
  if (!why || why.length > 400) throw new PlatformError('ongeldige_invoer', 'Geef een reden om uit te sluiten.');
  await withTransaction(p.pool, async (q) => {
    const item = await lockConceptItem(q, runId, itemId);
    if (item.status !== 'klaar') throw new PlatformError('conflict', 'Deze regel is al uitgesloten.');
    await q.query(`UPDATE collection_item SET status = 'uitgesloten', exclude_reason = $2 WHERE id = $1`, [itemId, why]);
    await audit(q, actor, { organizationId: item.organization_id, action: 'cockpit.incasso_regel_uitgesloten', subject: itemId, detail: { batch: runId, reden: why } });
  });
}

export async function includeItem(p: Platform, runId: string, itemId: string, actor: Actor): Promise<void> {
  await withTransaction(p.pool, async (q) => {
    const item = await lockConceptItem(q, runId, itemId);
    if (item.status !== 'uitgesloten') throw new PlatformError('conflict', 'Deze regel doet al mee.');
    if (item.failure_reason === 'mandaat_ingetrokken') {
      throw new PlatformError('conflict', 'De klant heeft de machtiging ingetrokken; incasseren mag niet. Gebruik het betaalverzoek onder Mislukt.');
    }
    const clash = await one(
      q,
      `SELECT 1 FROM collection_item WHERE subscription_id = $1 AND period_start = $2 AND status <> 'uitgesloten' AND id <> $3`,
      [item.subscription_id, item.period_start, itemId],
    );
    if (clash) throw new PlatformError('conflict', 'Deze periode staat al in een andere batch.');
    await q.query(`UPDATE collection_item SET status = 'klaar', exclude_reason = NULL WHERE id = $1`, [itemId]);
    await audit(q, actor, { organizationId: item.organization_id, action: 'cockpit.incasso_regel_teruggezet', subject: itemId, detail: { batch: runId } });
  });
}

/** Bedrag aanpassen (bijv. korting of pro rata), excl. btw, met verplichte reden. */
export async function adjustItem(p: Platform, runId: string, itemId: string, exclCents: number, reason: string, actor: Actor): Promise<void> {
  const why = reason.trim();
  if (!Number.isInteger(exclCents) || exclCents < 0 || exclCents > 100_000_00) throw new PlatformError('ongeldige_invoer', 'Ongeldig bedrag.');
  if (!why || why.length > 400) throw new PlatformError('ongeldige_invoer', 'Geef een reden voor de aanpassing.');
  const vat = Math.round((exclCents * p.catalog.btwPercentage) / 100);
  await withTransaction(p.pool, async (q) => {
    const item = await lockConceptItem(q, runId, itemId);
    if (item.status !== 'klaar') throw new PlatformError('conflict', 'Pas alleen regels aan die meedoen.');
    await q.query(
      `UPDATE collection_item SET amount_excl_cents = $2, vat_cents = $3, amount_incl_cents = $4,
              original_excl_cents = coalesce(original_excl_cents, amount_excl_cents), adjust_reason = $5,
              -- Eigen bedrag: de omschrijving wordt de enige factuurregel.
              lines = NULL
        WHERE id = $1`,
      [itemId, exclCents, vat, exclCents + vat, why],
    );
    await audit(q, actor, {
      organizationId: item.organization_id,
      action: 'cockpit.incasso_regel_aangepast',
      subject: itemId,
      detail: { batch: runId, van: item.amount_excl_cents, naar: exclCents, reden: why },
    });
  });
}

export async function validateRun(p: Platform, runId: string, actor: Actor): Promise<void> {
  await withTransaction(p.pool, async (q) => {
    const run = await lockRun(q, runId);
    if (run.status !== 'concept') throw new PlatformError('conflict', 'Alleen een concept kan gevalideerd worden.');
    const n = await one<{ n: number; total: string }>(
      q,
      `SELECT count(*)::int AS n, coalesce(sum(amount_incl_cents), 0)::bigint AS total FROM collection_item WHERE run_id = $1 AND status = 'klaar'`,
      [runId],
    );
    if (!n?.n) throw new PlatformError('conflict', 'Er zit geen enkele regel in deze batch.');
    await q.query(`UPDATE collection_run SET status = 'gevalideerd', validated_at = now(), validated_by = $2 WHERE id = $1`, [runId, actor.userId]);
    await audit(q, actor, { organizationId: null, action: 'cockpit.incasso_gevalideerd', subject: runId, detail: { regels: n.n, totaal_incl: Number(n.total) } });
  });
}

export async function reopenRun(p: Platform, runId: string, actor: Actor): Promise<void> {
  await withTransaction(p.pool, async (q) => {
    const run = await lockRun(q, runId);
    if (run.status !== 'gevalideerd') throw new PlatformError('conflict', 'Alleen een gevalideerde, nog niet ingediende batch kan terug naar concept.');
    await q.query(`UPDATE collection_run SET status = 'concept', validated_at = NULL, validated_by = NULL WHERE id = $1`, [runId]);
    await audit(q, actor, { organizationId: null, action: 'cockpit.incasso_terug_naar_concept', subject: runId });
  });
}

export async function cancelRun(p: Platform, runId: string, actor: Actor): Promise<void> {
  await withTransaction(p.pool, async (q) => {
    const run = await lockRun(q, runId);
    if (run.status !== 'concept' && run.status !== 'gevalideerd') throw new PlatformError('conflict', 'Een ingediende batch kan niet meer geannuleerd worden.');
    await q.query(`UPDATE collection_item SET status = 'uitgesloten', exclude_reason = coalesce(exclude_reason, 'Batch geannuleerd') WHERE run_id = $1 AND status = 'klaar'`, [runId]);
    await q.query(`UPDATE collection_run SET status = 'geannuleerd', canceled_at = now(), canceled_by = $2 WHERE id = $1`, [runId, actor.userId]);
    await audit(q, actor, { organizationId: null, action: 'cockpit.incasso_geannuleerd', subject: runId });
  });
}

/**
 * Indienen: per regel een betaling aanmaken bij de provider. Kan maar één keer
 * (de batch gaat in dezelfde transactie naar 'ingediend'). In testmodus gaat er
 * geen geld over; de uitkomst zet je daarna per regel met de testknoppen.
 *
 * Bij de Mollie-koppeling (na de BV): betalingen per regel buiten de transactie
 * aanmaken met een idempotentiesleutel per regel, zodat een afgebroken indiening
 * veilig opnieuw kan zonder dubbele incasso's.
 */
export async function submitRun(p: Platform, runId: string, actor: Actor): Promise<{ submitted: number; excluded: number }> {
  return withTransaction(p.pool, async (q) => {
    const run = await lockRun(q, runId);
    if (run.status !== 'gevalideerd') throw new PlatformError('conflict', 'Valideer de batch eerst. Een batch wordt maar één keer ingediend.');
    if (run.provider !== p.payments.name) throw new PlatformError('conflict', `Deze batch is gemaakt voor ${run.provider}, maar de cockpit draait met ${p.payments.name}.`);
    const excluded = await recheckItems(p, q, runId, actor);
    const items = await many<{ id: string; organization_id: string; description: string; amount_incl_cents: number }>(
      q,
      `SELECT id, organization_id, description, amount_incl_cents
         FROM collection_item WHERE run_id = $1 AND status = 'klaar' ORDER BY id FOR UPDATE`,
      [runId],
    );
    for (const it of items) {
      const pay = await one<{ id: string }>(
        q,
        `INSERT INTO payment (organization_id, subscription_id, description, period_start, period_end,
                              amount_excl_cents, vat_cents, amount_incl_cents, status, provider, created_by, lines)
         SELECT organization_id, subscription_id, 'Incasso: ' || description, period_start, period_end,
                amount_excl_cents, vat_cents, amount_incl_cents, 'open', $2, $3, lines
           FROM collection_item WHERE id = $1
         RETURNING id`,
        [it.id, p.payments.name, actor.userId],
      );
      const created = await p.payments.createPayment({
        paymentId: pay!.id,
        amountInclCents: it.amount_incl_cents,
        description: `Qbicle ${it.description}`,
        redirectUrl: `${p.config.appOrigin}/betaling/${pay!.id}`,
        webhookUrl: `${p.config.appOrigin}/api/v1/betalingen/webhook`,
      });
      await q.query('UPDATE payment SET provider_payment_id = $2 WHERE id = $1', [pay!.id, created.providerPaymentId]);
      await q.query(`UPDATE collection_item SET status = 'ingediend', payment_id = $2 WHERE id = $1`, [it.id, pay!.id]);
      await audit(q, actor, { organizationId: it.organization_id, action: 'betaling.aangemaakt', subject: pay!.id, detail: { incassobatch: runId } });
    }
    // Een betaalpagina die de klant ooit opende maar niet afrondde, vervalt: de incasso neemt het over.
    await q.query(
      `UPDATE payment pm SET status = 'geannuleerd'
         FROM collection_item i
        WHERE i.run_id = $1 AND i.status = 'ingediend' AND pm.subscription_id = i.subscription_id
          AND pm.status = 'open' AND pm.plan_change IS NULL AND pm.id <> i.payment_id
          AND NOT EXISTS (SELECT 1 FROM collection_item ci WHERE ci.payment_id = pm.id)`,
      [runId],
    );
    // Niets meer over om in te dienen: de batch is meteen klaar.
    await q.query(
      `UPDATE collection_run SET status = $3, submitted_at = now(), submitted_by = $2 WHERE id = $1`,
      [runId, actor.userId, items.length === 0 ? 'afgerond' : 'ingediend'],
    );
    await audit(q, actor, { organizationId: null, action: 'cockpit.incasso_ingediend', subject: runId, detail: { regels: items.length } });
    return { submitted: items.length, excluded };
  });
}

/**
 * Tussen klaarzetten en indienen kan de klant zelf betalen, opzeggen, naar factuur
 * gaan of de machtiging intrekken. Vlak voor indienen controleren we elke regel
 * opnieuw; wat niet meer klopt, gaat automatisch uit de batch met de reden erbij.
 */
async function recheckItems(p: Platform, q: Queryable, runId: string, actor: Actor): Promise<number> {
  const rows = await many<{
    id: string;
    organization_id: string;
    same_period: boolean;
    renews: boolean;
    payment_method: string;
    mandate_revoked: boolean;
    already_paid: boolean;
    open_payment: boolean;
    too_early: boolean;
    plan_changed: boolean;
  }>(
    q,
    `SELECT i.id, i.organization_id,
            s.current_period_end = i.period_start AS same_period,
            ((s.status IN ('actief', 'achterstallig') AND NOT s.cancel_at_period_end)
                OR (s.status = 'opgezegd' AND NOT s.cancel_at_period_end AND s.ends_at > s.current_period_end)) AS renews,
            o.payment_method,
            coalesce((SELECT bool_or(m.status = 'ingetrokken') AND NOT bool_or(m.status = 'geldig')
                        FROM payment_mandate m WHERE m.organization_id = i.organization_id), false) AS mandate_revoked,
            EXISTS (SELECT 1 FROM payment pm WHERE pm.subscription_id = i.subscription_id AND pm.status = 'betaald'
                       AND pm.plan_change IS NULL AND pm.period_end > i.period_start) AS already_paid,
            EXISTS (SELECT 1 FROM payment pm WHERE pm.subscription_id = i.subscription_id AND pm.status = 'open'
                       AND pm.plan_change IS NULL AND pm.period_end > i.period_start
                       AND pm.created_at > now() - interval '1 hour') AS open_payment,
            i.period_start > now() + make_interval(days => $2) AS too_early,
            -- Pakket of termijn sinds klaarzetten gewijzigd (downgrade ingetrokken, upgrade, nieuwe wissel)?
            (i.plan IS NOT NULL AND (i.plan, i.billing_interval) IS DISTINCT FROM
              (coalesce(s.pending_plan, s.plan), coalesce(s.pending_interval, s.billing_interval))) AS plan_changed
       FROM collection_item i
       JOIN subscription s ON s.id = i.subscription_id
       JOIN organization o ON o.id = i.organization_id
      WHERE i.run_id = $1 AND i.status = 'klaar'
      FOR UPDATE OF i`,
    [runId, MAX_DAYS_AHEAD],
  );
  let n = 0;
  for (const r of rows) {
    const reason = r.already_paid
      ? 'De klant heeft deze periode zelf al betaald.'
      : r.open_payment
        ? 'De klant is zelf aan het betalen (open betaling).'
        : r.mandate_revoked
          ? 'Machtiging ingetrokken door de klant; zie Mislukt voor het betaalverzoek.'
          : !r.renews
            ? 'Het abonnement is opgezegd of gestopt.'
            : r.payment_method !== 'incasso'
              ? 'Deze klant betaalt nu op factuur.'
              : !r.same_period
                ? 'De periode komt niet meer overeen met het abonnement.'
                : r.too_early
                  ? `De periode begint pas over meer dan ${MAX_DAYS_AHEAD} dagen.`
                  : r.plan_changed
                    ? 'Pakket of betaaltermijn is gewijzigd na klaarzetten; zet een nieuwe batch klaar.'
                    : null;
    if (!reason) continue;
    n++;
    await q.query(
      `UPDATE collection_item SET status = 'uitgesloten', exclude_reason = $2, failure_reason = $3, auto_excluded = true WHERE id = $1`,
      [r.id, reason, r.mandate_revoked && !r.already_paid && !r.open_payment ? 'mandaat_ingetrokken' : null],
    );
    if (r.mandate_revoked && !r.already_paid && !r.open_payment) await createFollowupSuggestion(q, p.config.appOrigin, r.id);
    await audit(q, actor, {
      organizationId: r.organization_id,
      action: 'cockpit.incasso_regel_uitgesloten',
      subject: r.id,
      detail: { batch: runId, reden: reason, automatisch: true },
    });
  }
  return n;
}

/**
 * Verwerkt de uitkomst van één regel: haalt de status op bij de provider (via
 * syncPayment, dat bij 'betaald' het abonnement verlengt en een factuur maakt).
 * Bij mislukken wordt het abonnement achterstallig.
 */
export async function syncItem(p: Platform, itemId: string, actor: Actor, failureReason?: FailureReason): Promise<ItemStatus> {
  const it = await one<{ payment_id: string | null; run_id: string; organization_id: string; subscription_id: string; status: ItemStatus }>(
    p.pool,
    'SELECT payment_id, run_id, organization_id, subscription_id, status FROM collection_item WHERE id = $1',
    [itemId],
  );
  if (!it?.payment_id) throw new PlatformError('niet_gevonden', 'Deze regel is (nog) niet ingediend.');
  if (it.status !== 'ingediend') return it.status;
  const pay = await syncPayment(p, it.payment_id, actor);
  if (pay.status === 'open') return 'ingediend';
  const status: ItemStatus = pay.status === 'betaald' ? 'betaald' : 'mislukt';
  await withTransaction(p.pool, async (q) => {
    await q.query(
      `UPDATE collection_item SET status = $2, failure_reason = $3, result_at = now() WHERE id = $1 AND status = 'ingediend'`,
      [itemId, status, status === 'mislukt' ? (failureReason ?? 'onbekend') : null],
    );
    if (status === 'mislukt') {
      await q.query(`UPDATE subscription SET status = 'achterstallig' WHERE id = $1 AND status = 'actief'`, [it.subscription_id]);
      await audit(q, actor, {
        organizationId: it.organization_id,
        action: 'cockpit.incasso_mislukt',
        subject: itemId,
        detail: { batch: it.run_id, reden: failureReason ?? 'onbekend' },
      });
      // Voorstel voor de vervolgactie staat meteen klaar.
      await createFollowupSuggestion(q, p.config.appOrigin, itemId);
    }
    // Batch afgerond als alles een uitkomst heeft.
    await q.query(
      `UPDATE collection_run SET status = 'afgerond'
        WHERE id = $1 AND status = 'ingediend'
          AND NOT EXISTS (SELECT 1 FROM collection_item WHERE run_id = $1 AND status = 'ingediend')`,
      [it.run_id],
    );
  });
  return status;
}

/** Alleen in testmodus: de uitkomst van de bank nabootsen. */
export async function settleTestItem(p: Platform, itemId: string, outcome: 'betaald' | 'mislukt', reason: FailureReason | undefined, actor: Actor): Promise<ItemStatus> {
  const provider = p.payments;
  if (!isNepProvider(provider)) throw new PlatformError('geen_toegang', 'Testuitkomsten kunnen alleen in testmodus.');
  const r = await one<{ provider_payment_id: string | null }>(
    p.pool,
    'SELECT pm.provider_payment_id FROM collection_item i JOIN payment pm ON pm.id = i.payment_id WHERE i.id = $1',
    [itemId],
  );
  if (!r?.provider_payment_id) throw new PlatformError('niet_gevonden', 'Deze regel is (nog) niet ingediend.');
  await provider.settle(r.provider_payment_id, outcome);
  return syncItem(p, itemId, actor, outcome === 'mislukt' ? (reason ?? 'onbekend') : undefined);
}
