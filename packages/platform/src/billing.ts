import { audit, type Actor } from './audit.ts';
import { normalizeEmail, requestLoginLink } from './auth.ts';
import {
  BILLING_INTERVALS,
  findAuditPackage,
  findPlan,
  periodAmountCents,
  vatCents,
  type BillingInterval,
  type Limits,
  type Plan,
} from './catalog.ts';
import type { Platform } from './context.ts';
import { many, one, withTransaction, type Queryable } from './db.ts';
import { notFound, PlatformError } from './errors.ts';
import { authorize, cleanName, createOrganization, isUuid } from './organizations.ts';
import { isNepProvider, type ProviderStatus } from './payments.ts';
import { can } from './roles.ts';
import { normalizeDomain } from '@qbicle/scanner';

/**
 * Abonnementen, betalingen en facturen.
 *
 * Levensloop van een abonnement:
 *   registreren → proef (14 dagen, zonder betaalgegevens) → betalen → actief
 *   → verlengen (volgende betaling) of opzeggen (loopt door tot het einde van de periode).
 *
 * Wie een betaling start terwijl de proef nog loopt, verliest geen proefdagen:
 * de betaalde periode begint pas als de proef afloopt.
 *
 * Alleen de eigenaar betaalt, wijzigt of zegt op. Beheerders zien het abonnement en de facturen.
 */

type UserActor = Actor & { userId: string };

export type SubscriptionStatus = 'proef' | 'actief' | 'achterstallig' | 'opgezegd' | 'beeindigd';

/** Wat de klant nu mag: dit bepaalt wat het platform toont. */
export type AccessState = 'proef' | 'actief' | 'betaling_nodig' | 'geen_abonnement';

export interface Subscription {
  id: string;
  organizationId: string;
  plan: string;
  interval: BillingInterval;
  monthlyPriceCents: number;
  status: SubscriptionStatus;
  trialEndsAt: Date | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  createdAt: Date;
  /** Wijziging die bij de volgende periode ingaat (downgrade of andere betaaltermijn). */
  pendingPlan: string | null;
  pendingInterval: BillingInterval | null;
  cancelReason: CancelReason | null;
}

export const CANCEL_REASONS = ['te_duur', 'niet_gebruikt', 'mist_functie', 'ander_product', 'tijdelijk', 'anders'] as const;
export type CancelReason = (typeof CANCEL_REASONS)[number];

export interface Payment {
  id: string;
  description: string;
  periodStart: Date | null;
  periodEnd: Date | null;
  amountExclCents: number;
  vatCents: number;
  amountInclCents: number;
  status: ProviderStatus;
  provider: string;
  checkoutUrl: string | null;
  createdAt: Date;
  paidAt: Date | null;
  subscriptionId: string | null;
  auditOrderId: string | null;
  /** Bij een bijbetaling voor een upgrade: naar welk pakket. */
  planChange: PlanChangeTarget | null;
}

export interface PlanChangeTarget {
  plan: string;
  interval: BillingInterval;
  /** Andere betaaltermijn die pas bij de volgende periode ingaat. */
  pendingInterval?: BillingInterval;
}

interface SubRow {
  id: string;
  organization_id: string;
  plan: string;
  billing_interval: BillingInterval;
  monthly_price_cents: number;
  status: SubscriptionStatus;
  trial_ends_at: Date | null;
  current_period_start: Date | null;
  current_period_end: Date | null;
  cancel_at_period_end: boolean;
  created_at: Date;
  pending_plan: string | null;
  pending_interval: BillingInterval | null;
  cancel_reason: CancelReason | null;
}
const SUB_COLS = `id, organization_id, plan, billing_interval, monthly_price_cents, status, trial_ends_at,
  current_period_start, current_period_end, cancel_at_period_end, created_at, pending_plan, pending_interval, cancel_reason`;
const toSub = (r: SubRow): Subscription => ({
  id: r.id,
  organizationId: r.organization_id,
  plan: r.plan,
  interval: r.billing_interval,
  monthlyPriceCents: r.monthly_price_cents,
  status: r.status,
  trialEndsAt: r.trial_ends_at,
  currentPeriodStart: r.current_period_start,
  currentPeriodEnd: r.current_period_end,
  cancelAtPeriodEnd: r.cancel_at_period_end,
  createdAt: r.created_at,
  pendingPlan: r.pending_plan,
  pendingInterval: r.pending_interval,
  cancelReason: r.cancel_reason,
});

interface PayRow {
  id: string;
  organization_id: string;
  subscription_id: string | null;
  audit_order_id: string | null;
  description: string;
  period_start: Date | null;
  period_end: Date | null;
  amount_excl_cents: number;
  vat_cents: number;
  amount_incl_cents: number;
  status: ProviderStatus;
  provider: string;
  provider_payment_id: string | null;
  checkout_url: string | null;
  created_at: Date;
  paid_at: Date | null;
  plan_change: PlanChangeTarget | null;
  lines: InvoiceLine[] | null;
}
const PAY_COLS = `id, organization_id, subscription_id, audit_order_id, description, period_start, period_end,
  amount_excl_cents, vat_cents, amount_incl_cents, status, provider, provider_payment_id, checkout_url, created_at, paid_at, plan_change, lines`;
const toPay = (r: PayRow): Payment => ({
  id: r.id,
  description: r.description,
  periodStart: r.period_start,
  periodEnd: r.period_end,
  amountExclCents: r.amount_excl_cents,
  vatCents: r.vat_cents,
  amountInclCents: r.amount_incl_cents,
  status: r.status,
  provider: r.provider,
  checkoutUrl: r.status === 'open' ? r.checkout_url : null,
  createdAt: r.created_at,
  paidAt: r.paid_at,
  subscriptionId: r.subscription_id,
  auditOrderId: r.audit_order_id,
  planChange: r.plan_change,
});

export function parseInterval(x: unknown): BillingInterval {
  if (typeof x === 'string' && (BILLING_INTERVALS as readonly string[]).includes(x)) return x as BillingInterval;
  throw new PlatformError('ongeldige_invoer', 'Kies maandelijks of jaarlijks betalen.');
}

function planOrFail(p: Platform, id: string): Plan {
  const plan = findPlan(p.catalog, id);
  if (!plan) throw new PlatformError('ongeldige_invoer', 'Dit pakket bestaat niet.');
  return plan;
}

/** Dagen respijt na het einde van de betaalde periode als een verlenging mislukt. */
export const GRACE_DAYS = 3;

export function accessState(sub: Subscription | undefined, now = new Date()): AccessState {
  if (!sub || sub.status === 'beeindigd') return 'geen_abonnement';
  if ((sub.status === 'actief' || sub.status === 'opgezegd') && sub.currentPeriodEnd && sub.currentPeriodEnd > now) return 'actief';
  // Mislukte verlenging: de betaalde periode loopt gewoon door, plus een paar dagen respijt.
  if (sub.status === 'achterstallig' && sub.currentPeriodEnd && sub.currentPeriodEnd.getTime() + GRACE_DAYS * 86_400_000 > now.getTime()) return 'actief';
  if (sub.status === 'proef' && sub.trialEndsAt && sub.trialEndsAt > now) return 'proef';
  return 'betaling_nodig';
}

async function currentSubscription(q: Queryable, organizationId: string, lock = false): Promise<Subscription | undefined> {
  const r = await one<SubRow>(
    q,
    `SELECT ${SUB_COLS} FROM subscription
      WHERE organization_id = $1 AND status IN ('proef', 'actief', 'achterstallig', 'opgezegd')
      ${lock ? 'FOR UPDATE' : ''}`,
    [organizationId],
  );
  return r ? toSub(r) : undefined;
}

/** Limieten van het huidige pakket (voor domeinen, gebruikers, partners). Zonder abonnement: de gratis check. */
export async function planLimits(p: Platform, organizationId: string): Promise<Limits & { plan: string | null }> {
  const sub = await currentSubscription(p.pool, organizationId);
  const plan = sub && accessState(sub) !== 'geen_abonnement' ? findPlan(p.catalog, sub.plan) : undefined;
  if (!plan) return { plan: null, domeinen: 1, gebruikers: 1, itPartners: 1 };
  return { plan: plan.id, ...plan.limieten };
}

// Registreren ----------------------------------------------------------------------

/**
 * Stap 1 van registreren, zonder account: we bewaren de keuze en sturen een
 * inloglink. Zelfde antwoord voor bekende en nieuwe adressen.
 */
export async function registerSignup(
  p: Platform,
  input: { email: string; organizationName: string; plan: string; interval?: string },
  actor: Actor,
): Promise<void> {
  const email = normalizeEmail(input.email);
  const orgName = cleanName(input.organizationName);
  const isAudit = Boolean(findAuditPackage(p.catalog, input.plan));
  if (!isAudit) planOrFail(p, input.plan);
  const interval = isAudit ? 'maand' : parseInterval(input.interval ?? 'jaar');
  // Eerst de inloglink (met de limieten per adres en IP), daarna pas opslaan.
  await requestLoginLink(p, email, actor);
  await p.pool.query(
    `INSERT INTO signup (email, org_name, plan, billing_interval, expires_at)
     VALUES ($1, $2, $3, $4, now() + make_interval(hours => $5))`,
    [email, orgName, input.plan, interval, p.config.signupHours],
  );
  await audit(p.pool, actor, { organizationId: null, action: 'registratie.aangevraagd', subject: email, detail: { pakket: input.plan, interval } });
}

/**
 * Stap 2, direct na het inloggen: een openstaande registratie voor dit adres
 * wordt een organisatie (met de gebruiker als eigenaar) en een proefabonnement.
 * Geeft de nieuwe organisatie terug, of undefined als er niets openstond.
 */
export async function completeSignup(
  p: Platform,
  actor: UserActor & { email: string },
): Promise<{ organizationId: string; plan: string; product: 'mkb' | 'corporate' | 'audit' } | undefined> {
  const s = await one<{ id: string; org_name: string; plan: string; billing_interval: BillingInterval }>(
    p.pool,
    `UPDATE signup SET completed_at = now()
      WHERE id = (SELECT id FROM signup WHERE email = $1 AND completed_at IS NULL AND expires_at > now()
                   ORDER BY created_at DESC LIMIT 1)
      RETURNING id, org_name, plan, billing_interval`,
    [actor.email],
  );
  if (!s) return undefined;
  const org = await createOrganization(p, actor, { name: s.org_name, kind: 'klant' });
  await p.pool.query('UPDATE signup SET organization_id = $2 WHERE id = $1', [s.id, org.id]);
  const plan = findPlan(p.catalog, s.plan);
  if (plan) await startSubscription(p, actor, org.id, { plan: plan.id, interval: s.billing_interval });
  await audit(p.pool, actor, { organizationId: org.id, action: 'registratie.afgerond', subject: org.id, detail: { pakket: s.plan } });
  return { organizationId: org.id, plan: s.plan, product: plan ? plan.product : 'audit' };
}

// Abonnement ------------------------------------------------------------------------

/**
 * Start een abonnement of wijzigt het pakket. De eerste keer krijgt een
 * organisatie een proefperiode; daarna niet opnieuw.
 */
export async function startSubscription(
  p: Platform,
  actor: UserActor,
  organizationId: string,
  input: { plan: string; interval: string },
): Promise<Subscription> {
  await authorize(p.pool, actor.userId, organizationId, 'abonnement:beheren');
  const plan = planOrFail(p, input.plan);
  const interval = parseInterval(input.interval);
  const price = plan.maandprijsCenten[interval];

  return withTransaction(p.pool, async (q) => {
    await q.query('SELECT 1 FROM organization WHERE id = $1 FOR UPDATE', [organizationId]);
    const cur = await currentSubscription(q, organizationId, true);
    if (cur) {
      // Pakket of interval wijzigen. De nieuwe prijs geldt vanaf de volgende betaling.
      const r = await one<SubRow>(
        q,
        `UPDATE subscription SET plan = $2, billing_interval = $3, monthly_price_cents = $4,
                cancel_at_period_end = false,
                status = CASE WHEN status = 'opgezegd' THEN 'actief' ELSE status END
          WHERE id = $1 RETURNING ${SUB_COLS}`,
        [cur.id, plan.id, interval, price],
      );
      await q.query('UPDATE organization SET plan = $2 WHERE id = $1', [organizationId, plan.id]);
      await audit(q, actor, { organizationId, action: 'abonnement.gewijzigd', subject: cur.id, detail: { van: cur.plan, naar: plan.id, interval } });
      return toSub(r!);
    }
    const hadBefore = await one(q, 'SELECT 1 FROM subscription WHERE organization_id = $1 LIMIT 1', [organizationId]);
    const trialDays = hadBefore ? 0 : p.catalog.proefDagen;
    const r = await one<SubRow>(
      q,
      `INSERT INTO subscription (organization_id, plan, billing_interval, monthly_price_cents, status, trial_ends_at, created_by)
       VALUES ($1, $2, $3, $4, 'proef', now() + make_interval(days => $5), $6)
       RETURNING ${SUB_COLS}`,
      [organizationId, plan.id, interval, price, trialDays, actor.userId],
    );
    await q.query('UPDATE organization SET plan = $2 WHERE id = $1', [organizationId, plan.id]);
    await audit(q, actor, { organizationId, action: 'abonnement.gestart', subject: r!.id, detail: { pakket: plan.id, interval, proefdagen: trialDays } });
    return toSub(r!);
  });
}

/** Opzeggen: een proef stopt direct, een betaald abonnement loopt door tot het einde van de periode. */
export async function cancelSubscription(
  p: Platform,
  actor: UserActor,
  organizationId: string,
  input: { reden?: string | null; toelichting?: string | null } = {},
): Promise<Subscription> {
  await authorize(p.pool, actor.userId, organizationId, 'abonnement:beheren');
  const reason = input.reden && (CANCEL_REASONS as readonly string[]).includes(input.reden) ? input.reden : null;
  const feedback = input.toelichting?.replace(/\s+/g, ' ').trim().slice(0, 1000) || null;
  return withTransaction(p.pool, async (q) => {
    const cur = await currentSubscription(q, organizationId, true);
    if (!cur) throw new PlatformError('conflict', 'Er is geen lopend abonnement om op te zeggen.');
    const paidAndRunning = accessState(cur) === 'actief';
    const r = await one<SubRow>(
      q,
      paidAndRunning
        ? `UPDATE subscription SET status = 'opgezegd', cancel_at_period_end = true, canceled_at = now(),
                  pending_plan = NULL, pending_interval = NULL, cancel_reason = $2, cancel_feedback = $3 WHERE id = $1 RETURNING ${SUB_COLS}`
        : `UPDATE subscription SET status = 'beeindigd', canceled_at = now(),
                  pending_plan = NULL, pending_interval = NULL, cancel_reason = $2, cancel_feedback = $3 WHERE id = $1 RETURNING ${SUB_COLS}`,
      [cur.id, reason, feedback],
    );
    await q.query(
      // Een incasso die al bij de bank ligt, annuleert de klant hier niet; de uitkomst komt van de bank.
      `UPDATE payment SET status = 'geannuleerd' WHERE subscription_id = $1 AND status = 'open' AND NOT EXISTS (SELECT 1 FROM collection_item ci WHERE ci.payment_id = payment.id)`,
      [cur.id],
    );
    if (!paidAndRunning) await q.query(`UPDATE organization SET plan = 'gratis' WHERE id = $1`, [organizationId]);
    await audit(q, actor, { organizationId, action: 'abonnement.opgezegd', subject: cur.id, detail: { directStoppen: !paidAndRunning, reden: reason } });
    return toSub(r!);
  });
}

export interface BillingOverview {
  abonnement: (Subscription & { pakket: Plan | null }) | null;
  toegang: AccessState;
  /** Proefdagen of betaalde dagen die nog over zijn. */
  dagenOver: number | null;
  openBetaling: Payment | null;
  betalingen: Payment[];
  magBeheren: boolean;
  /** Geplande wijziging bij de volgende periode. */
  gepland: { pakket: Plan | null; interval: BillingInterval; per: Date | null } | null;
  /** Eerstvolgende gewone betaling (verlenging), als die er komt. */
  volgendeBetaling: {
    datum: Date;
    exclCents: number;
    inclCents: number;
    pakket: Plan | null;
    interval: BillingInterval;
    /** Add-on: domeinen boven de limiet van het pakket, en wat die deze periode kosten. */
    extraDomeinen: number;
    extraDomeinenExclCents: number;
  } | null;
  betaalwijze: PaymentMethodInfo;
  gebruik: { gebruikers: number; domeinen: number };
}

export async function getBilling(p: Platform, userId: string, organizationId: string): Promise<BillingOverview> {
  const access = await authorize(p.pool, userId, organizationId, 'abonnement:lezen');
  const sub = await currentSubscription(p.pool, organizationId);
  const pays = await many<PayRow>(
    p.pool,
    `SELECT ${PAY_COLS} FROM payment WHERE organization_id = $1 ORDER BY created_at DESC LIMIT 50`,
    [organizationId],
  );
  const state = accessState(sub);
  const until = state === 'proef' ? sub!.trialEndsAt : state === 'actief' ? sub!.currentPeriodEnd : null;
  const open = pays.find((x) => x.status === 'open' && x.subscription_id && x.subscription_id === sub?.id);
  const pendingPlan = sub?.pendingPlan ? findPlan(p.catalog, sub.pendingPlan) ?? null : null;
  let volgende: BillingOverview['volgendeBetaling'] = null;
  if (sub && !sub.cancelAtPeriodEnd && (state === 'actief' || state === 'proef')) {
    const datum = state === 'proef' ? sub.trialEndsAt! : sub.currentPeriodEnd!;
    const pk = sub.pendingPlan ? pendingPlan : findPlan(p.catalog, sub.plan) ?? null;
    const iv = sub.pendingInterval ?? sub.interval;
    const monthly = pk ? pk.maandprijsCenten[iv] : sub.monthlyPriceCents;
    const extra = pk ? extraDomainsFor(pk, (await usageCounts(p.pool, organizationId)).domeinen) : 0;
    const extraExcl = extra * p.catalog.extraDomeinCenten * (iv === 'jaar' ? 12 : 1);
    const excl = periodAmountCents(monthly, iv) + extraExcl;
    volgende = { datum, exclCents: excl, inclCents: excl + vatCents(p.catalog, excl), pakket: pk, interval: iv, extraDomeinen: extra, extraDomeinenExclCents: extraExcl };
  }
  return {
    gepland: sub?.pendingPlan && sub.pendingInterval ? { pakket: pendingPlan, interval: sub.pendingInterval, per: sub.currentPeriodEnd } : null,
    volgendeBetaling: volgende,
    betaalwijze: await paymentMethodInfo(p.pool, organizationId),
    gebruik: await usageCounts(p.pool, organizationId),
    abonnement: sub ? { ...sub, pakket: findPlan(p.catalog, sub.plan) ?? null } : null,
    toegang: state,
    dagenOver: until ? Math.max(0, Math.ceil((until.getTime() - Date.now()) / 86_400_000)) : null,
    openBetaling: open ? toPay(open) : null,
    betalingen: pays.map(toPay),
    magBeheren: can(access, 'abonnement:beheren'),
  };
}

// Betalen ------------------------------------------------------------------------

async function createProviderPayment(p: Platform, q: Queryable, paymentId: string, amountInclCents: number, description: string) {
  const r = await p.payments.createPayment({
    paymentId,
    amountInclCents,
    description,
    redirectUrl: `${p.config.appOrigin}/betaling/${paymentId}`,
    webhookUrl: `${p.config.appOrigin}/api/v1/betalingen/webhook`,
  });
  await q.query('UPDATE payment SET provider_payment_id = $2, checkout_url = $3 WHERE id = $1', [paymentId, r.providerPaymentId, r.checkoutUrl]);
  return r.checkoutUrl;
}

function nlDate(d: Date): string {
  return d.toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Amsterdam' });
}

/**
 * Maakt een betaling voor de volgende periode van het abonnement en geeft de
 * betaalpagina terug. Een eerdere open betaling vervalt.
 */
export async function checkoutSubscription(
  p: Platform,
  actor: UserActor,
  organizationId: string,
): Promise<{ payment: Payment; checkoutUrl: string }> {
  await authorize(p.pool, actor.userId, organizationId, 'abonnement:beheren');
  return withTransaction(p.pool, async (q) => {
    let sub = await currentSubscription(q, organizationId, true);
    if (!sub) throw new PlatformError('conflict', 'Kies eerst een pakket.');
    // Loopt er al een automatische incasso voor dit abonnement, dan niet nog een keer laten betalen.
    const running = await one(
      q,
      `SELECT 1 FROM payment pm JOIN collection_item ci ON ci.payment_id = pm.id WHERE pm.subscription_id = $1 AND pm.status = 'open'`,
      [sub.id],
    );
    if (running) throw new PlatformError('conflict', 'De automatische incasso voor je abonnement loopt nog. Wacht de uitkomst van de bank af; je krijgt bericht als het niet lukt.');
    {
      // Een geplande downgrade of termijnwissel gaat in bij de periode die nu betaald wordt.
      const now0 = new Date();
      const nextStart = [now0, sub.trialEndsAt, sub.status !== 'proef' ? sub.currentPeriodEnd : null].filter((d): d is Date => !!d && d >= now0);
      const at = new Date(Math.max(...nextStart.map((d) => d.getTime())));
      sub = (await applyScheduledChange(p, q, sub.id, at)) ?? sub;
    }
    const plan = findPlan(p.catalog, sub.plan);
    if (!plan) throw new PlatformError('conflict', 'Dit pakket wordt niet meer aangeboden. Kies een ander pakket.');
    // Nieuwe prijs uit de catalogus bij elke nieuwe betaling (prijswijzigingen gaan zo in bij verlenging).
    const monthly = plan.maandprijsCenten[sub.interval];
    await q.query('UPDATE subscription SET monthly_price_cents = $2 WHERE id = $1', [sub.id, monthly]);

    const now = new Date();
    const starts = [now, sub.trialEndsAt, sub.status !== 'proef' ? sub.currentPeriodEnd : null].filter((d): d is Date => !!d && d >= now);
    const start = new Date(Math.max(...starts.map((d) => d.getTime())));
    const end = new Date(start);
    if (sub.interval === 'jaar') end.setFullYear(end.getFullYear() + 1);
    else end.setMonth(end.getMonth() + 1);

    const description = `${plan.naam}, ${sub.interval === 'jaar' ? 'jaar' : 'maand'} ${nlDate(start)} t/m ${nlDate(new Date(end.getTime() - 86_400_000))}`;
    const lines = await periodLines(p, q, organizationId, plan, sub.interval, monthly, description);
    const excl = lines.reduce((t, l) => t + l.totaalExclCenten, 0);
    const vat = vatCents(p.catalog, excl);

    await q.query(`UPDATE payment SET status = 'geannuleerd' WHERE subscription_id = $1 AND status = 'open' AND plan_change IS NULL AND NOT EXISTS (SELECT 1 FROM collection_item ci WHERE ci.payment_id = payment.id)`, [sub.id]);
    const row = await one<{ id: string }>(
      q,
      `INSERT INTO payment (organization_id, subscription_id, description, period_start, period_end,
                            amount_excl_cents, vat_cents, amount_incl_cents, status, provider, created_by, lines)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'open', $9, $10, $11) RETURNING id`,
      [organizationId, sub.id, description.slice(0, 200), start, end, excl, vat, excl + vat, p.payments.name, actor.userId, lines.length > 1 ? JSON.stringify(lines) : null],
    );
    const checkoutUrl = await createProviderPayment(p, q, row!.id, excl + vat, description);
    await audit(q, actor, { organizationId, action: 'betaling.aangemaakt', subject: row!.id, detail: { bedrag: excl + vat, abonnement: sub.id } });
    const pay = await one<PayRow>(q, `SELECT ${PAY_COLS} FROM payment WHERE id = $1`, [row!.id]);
    return { payment: toPay(pay!), checkoutUrl };
  });
}

/** Qbicle Audit: een eenmalige opdracht voor een doelonderneming, direct betalen. */
export async function createAuditOrder(
  p: Platform,
  actor: UserActor,
  organizationId: string,
  input: { package: string; targetName: string; domains: string[] },
): Promise<{ orderId: string; payment: Payment; checkoutUrl: string }> {
  await authorize(p.pool, actor.userId, organizationId, 'abonnement:beheren');
  const pkg = findAuditPackage(p.catalog, input.package);
  if (!pkg) throw new PlatformError('ongeldige_invoer', 'Dit Audit-pakket bestaat niet.');
  if (!pkg.bestelbaar) throw new PlatformError('conflict', 'Dit pakket kun je nog niet online bestellen. Neem contact met ons op.');
  const target = cleanName(input.targetName);
  const domains = [...new Set(input.domains.map((d) => {
    try {
      return normalizeDomain(d);
    } catch {
      throw new PlatformError('ongeldige_invoer', `"${String(d).slice(0, 80)}" is geen geldige domeinnaam.`);
    }
  }))];
  if (domains.length === 0) throw new PlatformError('ongeldige_invoer', 'Geef minstens één domein van de doelonderneming.');
  if (domains.length > pkg.maxDomeinen) throw new PlatformError('ongeldige_invoer', `${pkg.naam} gaat over maximaal ${pkg.maxDomeinen} domeinen.`);

  return withTransaction(p.pool, async (q) => {
    const order = await one<{ id: string }>(
      q,
      `INSERT INTO audit_order (organization_id, package, price_cents, target_name, target_domains, status, created_by)
       VALUES ($1, $2, $3, $4, $5, 'wacht_op_betaling', $6) RETURNING id`,
      [organizationId, pkg.id, pkg.prijsCenten, target, domains, actor.userId],
    );
    const excl = pkg.prijsCenten;
    const vat = vatCents(p.catalog, excl);
    const description = `${pkg.naam}: ${target}`.slice(0, 200);
    const row = await one<{ id: string }>(
      q,
      `INSERT INTO payment (organization_id, audit_order_id, description, amount_excl_cents, vat_cents, amount_incl_cents, status, provider, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, 'open', $7, $8) RETURNING id`,
      [organizationId, order!.id, description, excl, vat, excl + vat, p.payments.name, actor.userId],
    );
    const checkoutUrl = await createProviderPayment(p, q, row!.id, excl + vat, description);
    await audit(q, actor, { organizationId, action: 'audit_opdracht.aangemaakt', subject: order!.id, detail: { pakket: pkg.id, domeinen: domains.length } });
    const pay = await one<PayRow>(q, `SELECT ${PAY_COLS} FROM payment WHERE id = $1`, [row!.id]);
    return { orderId: order!.id, payment: toPay(pay!), checkoutUrl };
  });
}

/** Eén betaling bekijken (voor de pagina na het betalen). */
export async function getPayment(p: Platform, userId: string, paymentId: string): Promise<Payment & { organizationId: string }> {
  if (!isUuid(paymentId)) throw notFound('Deze betaling');
  const r = await one<PayRow>(p.pool, `SELECT ${PAY_COLS} FROM payment WHERE id = $1`, [paymentId]);
  if (!r) throw notFound('Deze betaling');
  await authorize(p.pool, userId, r.organization_id, 'abonnement:lezen').catch(() => {
    throw notFound('Deze betaling');
  });
  return { ...toPay(r), organizationId: r.organization_id };
}

/**
 * Haalt de status op bij de provider en verwerkt die: bij "betaald" wordt het
 * abonnement actief (of de Audit-opdracht betaald) en komt er een factuur.
 * Idempotent: twee keer aanroepen (webhook én redirect) geeft één factuur.
 */
export async function syncPayment(p: Platform, paymentId: string, actor: Actor = { userId: null }): Promise<Payment> {
  return withTransaction(p.pool, async (q) => {
    const r = await one<PayRow>(q, `SELECT ${PAY_COLS} FROM payment WHERE id = $1 FOR UPDATE`, [paymentId]);
    if (!r) throw notFound('Deze betaling');
    if (r.status !== 'open' || !r.provider_payment_id || r.provider !== p.payments.name) return toPay(r);
    const status = await p.payments.getStatus(r.provider_payment_id);
    if (status === 'open') return toPay(r);

    await q.query(`UPDATE payment SET status = $2, paid_at = CASE WHEN $2 = 'betaald' THEN now() END WHERE id = $1`, [paymentId, status]);
    await audit(q, actor, { organizationId: r.organization_id, action: 'betaling.status', subject: paymentId, detail: { status } });

    if (status === 'betaald') {
      if (r.subscription_id && r.plan_change) {
        // Bijbetaling voor een upgrade: het nieuwe pakket geldt nu, de periode blijft.
        const t = r.plan_change;
        const plan = findPlan(p.catalog, t.plan);
        if (plan) {
          await q.query(
            `UPDATE subscription SET plan = $2, billing_interval = $3, monthly_price_cents = $4,
                    pending_plan = $5, pending_interval = $6,
                    cancel_at_period_end = false, canceled_at = NULL,
                    status = CASE WHEN status = 'opgezegd' THEN 'actief' ELSE status END
              WHERE id = $1`,
            [r.subscription_id, plan.id, t.interval, plan.maandprijsCenten[t.interval], t.pendingInterval ? plan.id : null, t.pendingInterval ?? null],
          );
          await q.query('UPDATE organization SET plan = $2 WHERE id = $1', [r.organization_id, plan.id]);
          await audit(q, actor, { organizationId: r.organization_id, action: 'abonnement.gewijzigd', subject: r.subscription_id, detail: { naar: plan.id, upgradeBetaald: true } });
        }
      } else if (r.subscription_id) {
        // Geplande downgrade of termijnwissel gaat pas in nu de nieuwe periode betaald is.
        if (r.period_start) await applyScheduledChange(p, q, r.subscription_id, r.period_start);
        // Een incasso die al bij de bank lag toen de klant opzegde, maakt de opzegging niet ongedaan:
        // de betaalde periode loopt, daarna stopt het abonnement.
        const viaIncasso = !!(await one(q, 'SELECT 1 FROM collection_item WHERE payment_id = $1', [paymentId]));
        // Beëindigd en intussen een nieuw abonnement afgesloten: het oude niet terugzetten (dat botst),
        // maar de betaling laten beoordelen door een medewerker.
        const replaced = await one(
          q,
          `SELECT 1 FROM subscription s JOIN subscription old ON old.id = $1
            WHERE s.organization_id = old.organization_id AND s.id <> old.id AND old.status = 'beeindigd'
              AND s.status IN ('proef', 'actief', 'achterstallig', 'opgezegd')`,
          [r.subscription_id],
        );
        if (replaced) {
          await q.query(
            `INSERT INTO org_note (organization_id, body, source) VALUES ($1, $2, 'systeem')`,
            [r.organization_id, `Betaling ${paymentId} (${r.description}) is binnengekomen voor een beëindigd abonnement, terwijl er al een nieuw abonnement loopt. Beoordeel of terugbetalen of verrekenen nodig is.`],
          );
        } else await q.query(
          `UPDATE subscription
              SET status = CASE WHEN $4 AND status IN ('opgezegd', 'beeindigd') THEN 'opgezegd' ELSE 'actief' END,
                  cancel_at_period_end = CASE WHEN $4 AND status IN ('opgezegd', 'beeindigd') THEN true ELSE false END,
                  -- Verlenging: de lopende periode schuift door. Anders begint hij bij de betaalde periode
                  -- (bij betalen tijdens de proef is dat het einde van de proef).
                  current_period_start = CASE WHEN current_period_start IS NOT NULL AND current_period_end >= $2
                                              THEN current_period_start ELSE $2 END,
                  current_period_end = $3
            WHERE id = $1`,
          [r.subscription_id, r.period_start, r.period_end, viaIncasso],
        );
        if (!replaced) {
          const sub = await one<{ plan: string }>(q, 'SELECT plan FROM subscription WHERE id = $1', [r.subscription_id]);
          await q.query('UPDATE organization SET plan = $2 WHERE id = $1', [r.organization_id, sub!.plan]);
          await audit(q, actor, { organizationId: r.organization_id, action: 'abonnement.geactiveerd', subject: r.subscription_id });
        }
      }
      if (r.audit_order_id) {
        await q.query(`UPDATE audit_order SET status = 'betaald' WHERE id = $1 AND status = 'wacht_op_betaling'`, [r.audit_order_id]);
      }
      await issueInvoice(p, q, r, actor);
      await recordMandate(p, q, r, actor);
    }
    const after = await one<PayRow>(q, `SELECT ${PAY_COLS} FROM payment WHERE id = $1`, [paymentId]);
    return toPay(after!);
  });
}

/** Alleen bij testbetalingen: de knop op de testbetaalpagina. */
export async function settleTestPayment(
  p: Platform,
  actor: UserActor,
  paymentId: string,
  outcome: 'betaald' | 'mislukt' | 'geannuleerd',
): Promise<Payment> {
  const provider = p.payments;
  if (!isNepProvider(provider)) throw notFound('Deze betaling');
  const pay = await getPayment(p, actor.userId, paymentId);
  await authorize(p.pool, actor.userId, pay.organizationId, 'abonnement:beheren');
  const r = await one<{ provider_payment_id: string | null }>(p.pool, 'SELECT provider_payment_id FROM payment WHERE id = $1', [paymentId]);
  if (r?.provider_payment_id) provider.settle(r.provider_payment_id, outcome);
  return syncPayment(p, paymentId, actor);
}

// Facturen ------------------------------------------------------------------------

export interface InvoiceLine {
  omschrijving: string;
  aantal: number;
  prijsExclCenten: number;
  totaalExclCenten: number;
}

export interface Invoice {
  id: string;
  number: string;
  issuedAt: Date;
  customer: BillingDetails & { organisatie: string };
  lines: InvoiceLine[];
  amountExclCents: number;
  vatRate: number;
  vatCents: number;
  amountInclCents: number;
  paymentId: string;
}

async function issueInvoice(p: Platform, q: Queryable, pay: PayRow, actor: Actor): Promise<void> {
  const exists = await one(q, 'SELECT 1 FROM invoice WHERE payment_id = $1', [pay.id]);
  if (exists) return;
  const details = await billingDetailsRow(q, pay.organization_id);
  const year = new Date().getFullYear();
  const seq = await one<{ n: string }>(q, `SELECT nextval('invoice_number_seq')::text AS n`);
  const number = `QB-${year}-${seq!.n.padStart(6, '0')}`;
  const lines: InvoiceLine[] = pay.lines?.length
    ? pay.lines
    : [{ omschrijving: pay.description, aantal: 1, prijsExclCenten: pay.amount_excl_cents, totaalExclCenten: pay.amount_excl_cents }];
  await q.query(
    `INSERT INTO invoice (organization_id, payment_id, number, customer, lines, amount_excl_cents, vat_rate, vat_cents, amount_incl_cents)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [pay.organization_id, pay.id, number, JSON.stringify(details), JSON.stringify(lines), pay.amount_excl_cents, p.catalog.btwPercentage, pay.vat_cents, pay.amount_incl_cents],
  );
  await audit(q, actor, { organizationId: pay.organization_id, action: 'factuur.uitgegeven', subject: number });
}

interface InvRow {
  id: string;
  number: string;
  issued_at: Date;
  customer: Invoice['customer'];
  lines: InvoiceLine[];
  amount_excl_cents: number;
  vat_rate: string;
  vat_cents: number;
  amount_incl_cents: number;
  payment_id: string;
}
const toInv = (r: InvRow): Invoice => ({
  id: r.id,
  number: r.number,
  issuedAt: r.issued_at,
  customer: r.customer,
  lines: r.lines,
  amountExclCents: r.amount_excl_cents,
  vatRate: Number(r.vat_rate),
  vatCents: r.vat_cents,
  amountInclCents: r.amount_incl_cents,
  paymentId: r.payment_id,
});
const INV_COLS = 'id, number, issued_at, customer, lines, amount_excl_cents, vat_rate, vat_cents, amount_incl_cents, payment_id';

export async function listInvoices(p: Platform, userId: string, organizationId: string): Promise<Invoice[]> {
  await authorize(p.pool, userId, organizationId, 'abonnement:lezen');
  const rows = await many<InvRow>(p.pool, `SELECT ${INV_COLS} FROM invoice WHERE organization_id = $1 ORDER BY issued_at DESC`, [organizationId]);
  return rows.map(toInv);
}

export async function getInvoice(p: Platform, userId: string, organizationId: string, invoiceId: string): Promise<Invoice> {
  await authorize(p.pool, userId, organizationId, 'abonnement:lezen');
  if (!isUuid(invoiceId)) throw notFound('Deze factuur');
  const r = await one<InvRow>(p.pool, `SELECT ${INV_COLS} FROM invoice WHERE id = $1 AND organization_id = $2`, [invoiceId, organizationId]);
  if (!r) throw notFound('Deze factuur');
  return toInv(r);
}

// Factuurgegevens --------------------------------------------------------------------

export interface BillingDetails {
  naam: string | null;
  email: string | null;
  adres: string | null;
  postcode: string | null;
  plaats: string | null;
  land: string;
  kvk: string | null;
  btwNummer: string | null;
  /** Kenmerk of inkoopordernummer dat op elke factuur komt. */
  referentie: string | null;
}

async function billingDetailsRow(q: Queryable, organizationId: string): Promise<BillingDetails & { organisatie: string }> {
  const r = await one<{
    name: string;
    billing_name: string | null;
    billing_email: string | null;
    billing_address: string | null;
    billing_postcode: string | null;
    billing_city: string | null;
    billing_country: string;
    kvk_number: string | null;
    vat_number: string | null;
    billing_reference: string | null;
  }>(
    q,
    `SELECT name, billing_name, billing_email::text, billing_address, billing_postcode, billing_city, billing_country, kvk_number, vat_number,
            billing_reference
       FROM organization WHERE id = $1`,
    [organizationId],
  );
  if (!r) throw notFound('Deze organisatie');
  return {
    organisatie: r.name,
    naam: r.billing_name,
    email: r.billing_email,
    adres: r.billing_address,
    postcode: r.billing_postcode,
    plaats: r.billing_city,
    land: r.billing_country,
    kvk: r.kvk_number,
    btwNummer: r.vat_number,
    referentie: r.billing_reference,
  };
}

export async function getBillingDetails(p: Platform, userId: string, organizationId: string): Promise<BillingDetails & { organisatie: string }> {
  await authorize(p.pool, userId, organizationId, 'abonnement:lezen');
  return billingDetailsRow(p.pool, organizationId);
}

const opt = (v: string | null | undefined, max: number, label: string): string | null => {
  if (v === undefined || v === null) return null;
  const t = v.replace(/\s+/g, ' ').trim();
  if (!t) return null;
  if (t.length > max) throw new PlatformError('ongeldige_invoer', `${label} is te lang.`);
  return t;
};

export async function updateBillingDetails(
  p: Platform,
  actor: UserActor,
  organizationId: string,
  input: Partial<BillingDetails>,
): Promise<BillingDetails & { organisatie: string }> {
  await authorize(p.pool, actor.userId, organizationId, 'abonnement:beheren');
  const email = input.email ? normalizeEmail(input.email) : null;
  const kvk = opt(input.kvk, 20, 'KvK-nummer')?.replace(/\D/g, '') ?? null;
  if (kvk && !/^\d{8}$/.test(kvk)) throw new PlatformError('ongeldige_invoer', 'Een KvK-nummer heeft 8 cijfers.');
  const land = (opt(input.land, 2, 'Land') ?? 'NL').toUpperCase();
  if (!/^[A-Z]{2}$/.test(land)) throw new PlatformError('ongeldige_invoer', 'Geef het land als landcode, bijvoorbeeld NL of BE.');
  const btw = opt(input.btwNummer, 30, 'Btw-nummer')?.replace(/[\s.]/g, '').toUpperCase() ?? null;
  if (btw && !/^[A-Z]{2}[0-9A-Z]{2,13}$/.test(btw)) throw new PlatformError('ongeldige_invoer', 'Dit btw-nummer klopt niet. Voorbeeld: NL123456789B01.');
  await p.pool.query(
    `UPDATE organization SET billing_name = $2, billing_email = $3, billing_address = $4, billing_postcode = $5,
            billing_city = $6, billing_country = $7, kvk_number = $8, vat_number = $9, billing_reference = $10
      WHERE id = $1`,
    [
      organizationId,
      opt(input.naam, 200, 'Naam'),
      email,
      opt(input.adres, 400, 'Adres'),
      opt(input.postcode, 16, 'Postcode'),
      opt(input.plaats, 100, 'Plaats'),
      land,
      kvk,
      btw,
      opt(input.referentie, 100, 'Referentie'),
    ],
  );
  await audit(p.pool, actor, { organizationId, action: 'factuurgegevens.gewijzigd', subject: organizationId });
  return billingDetailsRow(p.pool, organizationId);
}

// Pakket wijzigen -----------------------------------------------------------------------
//
// Afspraak (Erik, 27-11-2026):
// * Tijdens de proef of zonder betaalde periode: het nieuwe pakket geldt meteen.
// * Upgrade tijdens een betaalde periode: meteen, na een bijbetaling naar rato voor
//   de resterende dagen. Pas als die betaald is, verandert het abonnement.
// * Downgrade of andere betaaltermijn tijdens een betaalde periode: gaat in bij de
//   volgende periode. Tot die tijd houdt de klant wat hij betaald heeft.

export type ChangeKind = 'nieuw' | 'gelijk' | 'direct' | 'upgrade' | 'downgrade' | 'termijn';

export interface PlanChangePreview {
  soort: ChangeKind;
  van: { plan: Plan | null; interval: BillingInterval; maandprijsCenten: number } | null;
  naar: { plan: Plan; interval: BillingInterval; maandprijsCenten: number };
  /** Wanneer het nieuwe pakket ingaat. */
  ingang: 'direct' | 'na_bijbetaling' | 'volgende_periode';
  ingangsdatum: Date | null;
  /** Bijbetaling naar rato bij een upgrade (anders 0). */
  bijbetalingExclCents: number;
  bijbetalingInclCents: number;
  restDagen: number;
  /** Eerstvolgende gewone betaling met het nieuwe pakket. */
  volgendeBetaling: { datum: Date | null; interval: BillingInterval; exclCents: number; inclCents: number };
  /** Bijvoorbeeld: meer gebruikers dan het nieuwe pakket toestaat. */
  waarschuwingen: string[];
}

const DAY = 86_400_000;

function planRank(p: Plan): number {
  return p.maandprijsCenten.jaar;
}

async function usageCounts(q: Queryable, organizationId: string): Promise<{ gebruikers: number; domeinen: number }> {
  const r = await one<{ g: number; d: number }>(
    q,
    `SELECT (SELECT count(*)::int FROM membership WHERE organization_id = $1) AS g,
            (SELECT count(*)::int FROM domain WHERE organization_id = $1) AS d`,
    [organizationId],
  );
  return { gebruikers: r?.g ?? 0, domeinen: r?.d ?? 0 };
}

function computeChange(
  p: Platform,
  sub: Subscription | undefined,
  plan: Plan,
  interval: BillingInterval,
  usage: { gebruikers: number; domeinen: number },
  now = new Date(),
): PlanChangePreview {
  const naar = { plan, interval, maandprijsCenten: plan.maandprijsCenten[interval] };
  const waarschuwingen: string[] = [];
  if (usage.gebruikers > plan.limieten.gebruikers) {
    waarschuwingen.push(`Je hebt nu ${usage.gebruikers} gebruikers. ${plan.naam} heeft ruimte voor ${plan.limieten.gebruikers}. Bestaande gebruikers blijven, maar je kunt niemand meer uitnodigen.`);
  }
  const extra = extraDomainsFor(plan, usage.domeinen);
  if (extra > 0) {
    waarschuwingen.push(
      `Je hebt nu ${usage.domeinen} domeinen; in ${plan.naam} zitten er ${plan.limieten.domeinen}. De ${extra} extra ${extra === 1 ? 'domein kost' : 'domeinen kosten'} elk ${euroText(p.catalog.extraDomeinCenten)} per maand, en dat staat in de bedragen hieronder.`,
    );
  }
  const amount = (monthly: number, iv: BillingInterval) => {
    const excl = periodAmountCents(monthly, iv) + extra * p.catalog.extraDomeinCenten * (iv === 'jaar' ? 12 : 1);
    return { exclCents: excl, inclCents: excl + vatCents(p.catalog, excl) };
  };
  const state = accessState(sub, now);
  const base = { naar, waarschuwingen, bijbetalingExclCents: 0, bijbetalingInclCents: 0, restDagen: 0 };

  if (!sub || state === 'geen_abonnement') {
    return { ...base, soort: 'nieuw', van: null, ingang: 'direct', ingangsdatum: now, volgendeBetaling: { datum: now, interval, ...amount(naar.maandprijsCenten, interval) } };
  }
  const van = { plan: findPlan(p.catalog, sub.plan) ?? null, interval: sub.interval, maandprijsCenten: sub.monthlyPriceCents };
  const paidRunning = state === 'actief' && sub.currentPeriodEnd !== null;
  const nextDate = paidRunning ? sub.currentPeriodEnd : state === 'proef' ? sub.trialEndsAt : now;

  if (sub.plan === plan.id && sub.interval === interval) {
    return { ...base, soort: 'gelijk', van, ingang: 'direct', ingangsdatum: now, volgendeBetaling: { datum: nextDate, interval, ...amount(naar.maandprijsCenten, interval) } };
  }
  if (!paidRunning) {
    return { ...base, soort: 'direct', van, ingang: 'direct', ingangsdatum: now, volgendeBetaling: { datum: nextDate, interval, ...amount(naar.maandprijsCenten, interval) } };
  }
  const end = sub.currentPeriodEnd!;
  const oldPlan = van.plan;
  const isUpgrade = sub.plan !== plan.id && (!oldPlan || planRank(plan) > planRank(oldPlan));
  if (isUpgrade) {
    // Naar rato over de resterende betaalde tijd, in de huidige betaaltermijn.
    const start = sub.currentPeriodStart ?? now;
    const total = Math.max(DAY, end.getTime() - start.getTime());
    const rest = Math.max(0, end.getTime() - Math.max(now.getTime(), start.getTime()));
    const diff = periodAmountCents(plan.maandprijsCenten[sub.interval], sub.interval) - periodAmountCents(sub.monthlyPriceCents, sub.interval);
    const excl = Math.max(0, Math.round((diff * Math.min(rest, total)) / total));
    return {
      ...base,
      soort: 'upgrade',
      van,
      ingang: excl > 0 ? 'na_bijbetaling' : 'direct',
      ingangsdatum: now,
      bijbetalingExclCents: excl,
      bijbetalingInclCents: excl + vatCents(p.catalog, excl),
      restDagen: Math.ceil(rest / DAY),
      volgendeBetaling: { datum: end, interval, ...amount(naar.maandprijsCenten, interval) },
    };
  }
  return {
    ...base,
    soort: sub.plan === plan.id ? 'termijn' : 'downgrade',
    van,
    ingang: 'volgende_periode',
    ingangsdatum: end,
    volgendeBetaling: { datum: end, interval, ...amount(naar.maandprijsCenten, interval) },
  };
}

/** Wat kost een wissel en wanneer gaat hij in? Voor de bevestigingspagina, verandert niets. */
export async function previewPlanChange(
  p: Platform,
  userId: string,
  organizationId: string,
  input: { plan: string; interval: string },
): Promise<PlanChangePreview> {
  await authorize(p.pool, userId, organizationId, 'abonnement:lezen');
  const plan = planOrFail(p, input.plan);
  const interval = parseInterval(input.interval);
  const sub = await currentSubscription(p.pool, organizationId);
  return computeChange(p, sub, plan, interval, await usageCounts(p.pool, organizationId));
}

/**
 * Voert een pakketwissel uit volgens de afspraak hierboven. Bij een upgrade met
 * bijbetaling komt er een betaling en een betaalpagina; het pakket verandert pas
 * als die betaald is.
 */
export async function changePlan(
  p: Platform,
  actor: UserActor,
  organizationId: string,
  input: { plan: string; interval: string },
): Promise<{ preview: PlanChangePreview; subscription: Subscription; payment?: Payment; checkoutUrl?: string }> {
  await authorize(p.pool, actor.userId, organizationId, 'abonnement:beheren');
  const plan = planOrFail(p, input.plan);
  const interval = parseInterval(input.interval);
  const first = await currentSubscription(p.pool, organizationId);
  if (!first || accessState(first) === 'geen_abonnement') {
    const subscription = await startSubscription(p, actor, organizationId, { plan: plan.id, interval });
    return { preview: computeChange(p, undefined, plan, interval, await usageCounts(p.pool, organizationId)), subscription };
  }

  return withTransaction(p.pool, async (q) => {
    await q.query('SELECT 1 FROM organization WHERE id = $1 FOR UPDATE', [organizationId]);
    const sub = (await currentSubscription(q, organizationId, true))!;
    const preview = computeChange(p, sub, plan, interval, await usageCounts(q, organizationId));
    const reactivate = `cancel_at_period_end = false, canceled_at = NULL, cancel_reason = NULL, cancel_feedback = NULL,
                        status = CASE WHEN status = 'opgezegd' THEN 'actief' ELSE status END`;

    if (preview.soort === 'gelijk') {
      // Zelfde pakket kiezen: een geplande wijziging vervalt en een opzegging wordt ingetrokken.
      const r = await one<SubRow>(q, `UPDATE subscription SET pending_plan = NULL, pending_interval = NULL, ${reactivate} WHERE id = $1 RETURNING ${SUB_COLS}`, [sub.id]);
      if (sub.pendingPlan || sub.cancelAtPeriodEnd) {
        await audit(q, actor, { organizationId, action: 'abonnement.gewijzigd', subject: sub.id, detail: { geplandeWijzigingVervallen: true } });
      }
      return { preview, subscription: toSub(r!) };
    }

    if (preview.soort === 'direct' || (preview.soort === 'upgrade' && preview.bijbetalingExclCents === 0)) {
      const keepInterval = preview.soort === 'upgrade' ? sub.interval : interval;
      const pendingIv = preview.soort === 'upgrade' && interval !== sub.interval ? interval : null;
      const r = await one<SubRow>(
        q,
        `UPDATE subscription SET plan = $2, billing_interval = $3, monthly_price_cents = $4,
                pending_plan = $5, pending_interval = $6, ${reactivate}
          WHERE id = $1 RETURNING ${SUB_COLS}`,
        [sub.id, plan.id, keepInterval, plan.maandprijsCenten[keepInterval], pendingIv ? plan.id : null, pendingIv],
      );
      await q.query('UPDATE organization SET plan = $2 WHERE id = $1', [organizationId, plan.id]);
      await audit(q, actor, { organizationId, action: 'abonnement.gewijzigd', subject: sub.id, detail: { van: sub.plan, naar: plan.id, interval, soort: preview.soort } });
      return { preview, subscription: toSub(r!) };
    }

    if (preview.soort === 'upgrade') {
      const target: PlanChangeTarget = { plan: plan.id, interval: sub.interval, ...(interval !== sub.interval ? { pendingInterval: interval } : {}) };
      const excl = preview.bijbetalingExclCents;
      const vat = vatCents(p.catalog, excl);
      const lastDay = new Date(sub.currentPeriodEnd!.getTime() - DAY);
      const description = `Upgrade naar ${plan.naam}, naar rato t/m ${nlDate(lastDay)}`.slice(0, 200);
      await q.query(`UPDATE payment SET status = 'geannuleerd' WHERE subscription_id = $1 AND status = 'open' AND plan_change IS NOT NULL`, [sub.id]);
      const row = await one<{ id: string }>(
        q,
        `INSERT INTO payment (organization_id, subscription_id, description, period_start, period_end,
                              amount_excl_cents, vat_cents, amount_incl_cents, status, provider, created_by, plan_change)
         VALUES ($1, $2, $3, now(), $4, $5, $6, $7, 'open', $8, $9, $10) RETURNING id`,
        [organizationId, sub.id, description, sub.currentPeriodEnd, excl, vat, excl + vat, p.payments.name, actor.userId, JSON.stringify(target)],
      );
      const checkoutUrl = await createProviderPayment(p, q, row!.id, excl + vat, description);
      await audit(q, actor, { organizationId, action: 'betaling.aangemaakt', subject: row!.id, detail: { bedrag: excl + vat, upgrade: plan.id } });
      const pay = await one<PayRow>(q, `SELECT ${PAY_COLS} FROM payment WHERE id = $1`, [row!.id]);
      return { preview, subscription: sub, payment: toPay(pay!), checkoutUrl };
    }

    // Downgrade of andere termijn: bij de volgende periode.
    const r = await one<SubRow>(
      q,
      `UPDATE subscription SET pending_plan = $2, pending_interval = $3, ${reactivate} WHERE id = $1 RETURNING ${SUB_COLS}`,
      [sub.id, plan.id, interval],
    );
    await audit(q, actor, {
      organizationId,
      action: 'abonnement.gewijzigd',
      subject: sub.id,
      detail: { van: sub.plan, naar: plan.id, interval, soort: preview.soort, ingang: preview.ingangsdatum?.toISOString() ?? null },
    });
    return { preview, subscription: toSub(r!) };
  });
}

/** Een geplande wijziging (downgrade of andere termijn) weer laten vallen. */
export async function cancelScheduledChange(p: Platform, actor: UserActor, organizationId: string): Promise<Subscription> {
  await authorize(p.pool, actor.userId, organizationId, 'abonnement:beheren');
  const r = await one<SubRow>(
    p.pool,
    `UPDATE subscription SET pending_plan = NULL, pending_interval = NULL
      WHERE organization_id = $1 AND status IN ('proef', 'actief', 'achterstallig', 'opgezegd') AND pending_plan IS NOT NULL
      RETURNING ${SUB_COLS}`,
    [organizationId],
  );
  if (!r) throw new PlatformError('conflict', 'Er staat geen wijziging gepland.');
  await audit(p.pool, actor, { organizationId, action: 'abonnement.gewijzigd', subject: r.id, detail: { geplandeWijzigingVervallen: true } });
  return toSub(r);
}

/**
 * Past een geplande wijziging toe als de periode waarvoor betaald gaat worden op of
 * na het einde van de huidige periode begint. Roep dit aan vóór je een verlenging
 * klaarzet (klant die zelf betaalt, of de incassobatch in de cockpit).
 */
export async function applyScheduledChange(p: Platform, q: Queryable, subscriptionId: string, periodStart: Date): Promise<Subscription | undefined> {
  const s = await one<SubRow>(q, `SELECT ${SUB_COLS} FROM subscription WHERE id = $1 FOR UPDATE`, [subscriptionId]);
  if (!s) return undefined;
  const sub = toSub(s);
  if (!sub.pendingPlan || !sub.pendingInterval) return sub;
  if (sub.currentPeriodEnd && periodStart.getTime() < sub.currentPeriodEnd.getTime()) return sub;
  const plan = findPlan(p.catalog, sub.pendingPlan);
  if (!plan) {
    const r = await one<SubRow>(q, `UPDATE subscription SET pending_plan = NULL, pending_interval = NULL WHERE id = $1 RETURNING ${SUB_COLS}`, [sub.id]);
    return toSub(r!);
  }
  const r = await one<SubRow>(
    q,
    `UPDATE subscription SET plan = $2, billing_interval = $3, monthly_price_cents = $4, pending_plan = NULL, pending_interval = NULL
      WHERE id = $1 RETURNING ${SUB_COLS}`,
    [sub.id, plan.id, sub.pendingInterval, plan.maandprijsCenten[sub.pendingInterval]],
  );
  await q.query('UPDATE organization SET plan = $2 WHERE id = $1', [sub.organizationId, plan.id]);
  await audit(q, { userId: null }, { organizationId: sub.organizationId, action: 'abonnement.gewijzigd', subject: sub.id, detail: { van: sub.plan, naar: plan.id, interval: sub.pendingInterval, gepland: true } });
  return toSub(r!);
}

/** Opzegging intrekken zolang de betaalde periode nog loopt. */
export async function resumeSubscription(p: Platform, actor: UserActor, organizationId: string): Promise<Subscription> {
  await authorize(p.pool, actor.userId, organizationId, 'abonnement:beheren');
  const r = await one<SubRow>(
    p.pool,
    `UPDATE subscription SET status = 'actief', cancel_at_period_end = false, canceled_at = NULL, cancel_reason = NULL, cancel_feedback = NULL
      WHERE organization_id = $1 AND status = 'opgezegd' AND current_period_end > now()
      RETURNING ${SUB_COLS}`,
    [organizationId],
  );
  if (!r) throw new PlatformError('conflict', 'Er is geen opzegging om in te trekken.');
  await audit(p.pool, actor, { organizationId, action: 'abonnement.gewijzigd', subject: r.id, detail: { opzeggingIngetrokken: true } });
  return toSub(r);
}

// Betaalwijze en mandaat ------------------------------------------------------------------

export interface Mandate {
  id: string;
  method: 'sepa' | 'creditcard';
  accountHolder: string | null;
  accountLast4: string | null;
  createdAt: Date;
}

export interface PaymentMethodInfo {
  /** Ingesteld door Qbicle (cockpit): standaard incasso, factuur alleen op afspraak. */
  methode: 'incasso' | 'factuur';
  betaaltermijnDagen: number;
  mandaat: Mandate | null;
  /** Wanneer de klant voor het laatst om betalen op factuur vroeg (binnen 30 dagen). */
  factuurAangevraagdOp: Date | null;
}

async function paymentMethodInfo(q: Queryable, organizationId: string): Promise<PaymentMethodInfo> {
  const o = await one<{ payment_method: 'incasso' | 'factuur'; payment_terms_days: number }>(
    q,
    'SELECT payment_method, payment_terms_days FROM organization WHERE id = $1',
    [organizationId],
  );
  const m = await one<{ id: string; method: 'sepa' | 'creditcard'; account_holder: string | null; account_last4: string | null; created_at: Date }>(
    q,
    `SELECT id, method, account_holder, account_last4, created_at FROM payment_mandate WHERE organization_id = $1 AND status = 'geldig'`,
    [organizationId],
  );
  const req = await one<{ at: Date }>(
    q,
    `SELECT max(at) AS at FROM audit_log WHERE organization_id = $1 AND action = 'betaalwijze.factuur_aangevraagd' AND at > now() - interval '30 days'`,
    [organizationId],
  );
  return {
    methode: o?.payment_method ?? 'incasso',
    betaaltermijnDagen: o?.payment_terms_days ?? 14,
    mandaat: m ? { id: m.id, method: m.method, accountHolder: m.account_holder, accountLast4: m.account_last4, createdAt: m.created_at } : null,
    factuurAangevraagdOp: req?.at ?? null,
  };
}

async function recordMandate(p: Platform, q: Queryable, pay: PayRow, actor: Actor): Promise<void> {
  if (!pay.provider_payment_id || !p.payments.mandateFor) return;
  const o = await one<{ payment_method: string }>(q, 'SELECT payment_method FROM organization WHERE id = $1', [pay.organization_id]);
  if (o?.payment_method !== 'incasso') return;
  const has = await one(q, `SELECT 1 FROM payment_mandate WHERE organization_id = $1 AND status = 'geldig'`, [pay.organization_id]);
  if (has) return;
  const m = await p.payments.mandateFor(pay.provider_payment_id);
  if (!m) return;
  const last4 = m.accountLast4 && /^[0-9A-Z]{4}$/.test(m.accountLast4) ? m.accountLast4 : null;
  await q.query(
    `INSERT INTO payment_mandate (organization_id, provider, provider_mandate_id, method, account_holder, account_last4, source_payment_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
    [pay.organization_id, pay.provider, m.providerMandateId, m.method, m.accountHolder?.slice(0, 200) ?? null, last4, pay.id],
  );
  await audit(q, actor, { organizationId: pay.organization_id, action: 'mandaat.afgegeven', subject: pay.id });
}

/** Toestemming voor automatische incasso intrekken. Volgende betalingen doet de klant dan zelf. */
export async function revokeMandate(p: Platform, actor: UserActor, organizationId: string): Promise<void> {
  await authorize(p.pool, actor.userId, organizationId, 'abonnement:beheren');
  const r = await p.pool.query(
    `UPDATE payment_mandate SET status = 'ingetrokken', revoked_at = now(), revoked_by = $2
      WHERE organization_id = $1 AND status = 'geldig'`,
    [organizationId, actor.userId],
  );
  if (!r.rowCount) throw new PlatformError('conflict', 'Er is geen machtiging om in te trekken.');
  await audit(p.pool, actor, { organizationId, action: 'mandaat.ingetrokken', subject: organizationId });
}

/**
 * Betalen op factuur kan alleen op afspraak (Qbicle stelt het in via de cockpit).
 * De klant vraagt het hier aan; het verzoek komt als notitie bij de klant in de cockpit.
 */
export async function requestInvoicePayment(p: Platform, actor: UserActor, organizationId: string, reason: string): Promise<void> {
  await authorize(p.pool, actor.userId, organizationId, 'abonnement:beheren');
  const text = reason.replace(/\s+/g, ' ').trim();
  if (text.length < 5) throw new PlatformError('ongeldige_invoer', 'Vertel kort waarom je op factuur wilt betalen, bijvoorbeeld: inkoopordernummer verplicht.');
  if (text.length > 600) throw new PlatformError('ongeldige_invoer', 'Houd de toelichting korter dan 600 tekens.');
  const info = await paymentMethodInfo(p.pool, organizationId);
  if (info.methode === 'factuur') throw new PlatformError('conflict', 'Je betaalt al op factuur.');
  if (info.factuurAangevraagdOp) throw new PlatformError('conflict', 'Je aanvraag is binnen. We nemen binnen twee werkdagen contact op.');
  await p.pool.query(
    `INSERT INTO org_note (organization_id, author_id, body, source) VALUES ($1, $2, $3, 'systeem')`,
    [organizationId, actor.userId, `Klant vraagt om betalen op factuur (via ${actor.email ?? 'klantomgeving'}). Toelichting: ${text}`.slice(0, 4000)],
  );
  await audit(p.pool, actor, { organizationId, action: 'betaalwijze.factuur_aangevraagd', subject: organizationId });
}

// Facturen en betalingen (klantkant) -----------------------------------------------------

export const HISTORY_FILTERS = ['alle', 'betaald', 'open', 'mislukt', 'terugbetaald'] as const;
export type HistoryFilter = (typeof HISTORY_FILTERS)[number];

export interface HistoryRow {
  payment: Payment;
  invoiceId: string | null;
  invoiceNumber: string | null;
  refundedCents: number;
  /** Klantvriendelijke status. */
  status: 'betaald' | 'deels_terugbetaald' | 'terugbetaald' | 'open' | 'mislukt' | 'niet_betaald' | 'geannuleerd';
  /** Mislukt of verlopen en nog niet opnieuw betaald: de klant kan het opnieuw proberen. */
  opnieuwBetalen: boolean;
}

export interface BillingHistory {
  rows: HistoryRow[];
  jaren: number[];
  /** Totaal van betaalde facturen in het gekozen jaar (of alles). */
  totaal: { exclCents: number; vatCents: number; inclCents: number; aantal: number };
  /** Betalingen die aandacht nodig hebben (mislukt, nog niet opnieuw betaald). */
  actieNodig: HistoryRow[];
}

export async function getBillingHistory(
  p: Platform,
  userId: string,
  organizationId: string,
  opts: { zoek?: string; status?: string; jaar?: string | number } = {},
): Promise<BillingHistory> {
  await authorize(p.pool, userId, organizationId, 'abonnement:lezen');
  const rows = await many<PayRow & { refunded_cents: number; invoice_id: string | null; invoice_number: string | null; superseded: boolean }>(
    p.pool,
    `SELECT ${PAY_COLS.split(',').map((c) => 'p.' + c.trim()).join(', ')}, p.refunded_cents, i.id AS invoice_id, i.number AS invoice_number,
            EXISTS (SELECT 1 FROM payment q
                     WHERE q.organization_id = p.organization_id AND q.id <> p.id AND q.created_at > p.created_at
                       AND q.status IN ('open', 'betaald')
                       AND ((p.audit_order_id IS NOT NULL AND q.audit_order_id = p.audit_order_id)
                         OR (p.subscription_id IS NOT NULL AND q.subscription_id = p.subscription_id
                             AND (q.plan_change IS NULL) = (p.plan_change IS NULL)
                             AND (p.plan_change IS NOT NULL OR q.period_end >= p.period_end)))) AS superseded
       FROM payment p LEFT JOIN invoice i ON i.payment_id = p.id
      WHERE p.organization_id = $1
      ORDER BY p.created_at DESC
      LIMIT 500`,
    [organizationId],
  );
  const all: HistoryRow[] = rows.map((r) => {
    const refunded = r.refunded_cents ?? 0;
    const status: HistoryRow['status'] =
      r.status === 'betaald'
        ? refunded >= r.amount_incl_cents && refunded > 0
          ? 'terugbetaald'
          : refunded > 0
            ? 'deels_terugbetaald'
            : 'betaald'
        : r.status === 'verlopen'
          ? 'niet_betaald'
          : r.status;
    return {
      payment: toPay(r),
      invoiceId: r.invoice_id,
      invoiceNumber: r.invoice_number,
      refundedCents: refunded,
      status,
      opnieuwBetalen: (r.status === 'mislukt' || r.status === 'verlopen') && !r.superseded,
    };
  });
  const jaren = [...new Set(all.map((r) => new Date(r.payment.createdAt).getFullYear()))].sort((a, b) => b - a);
  const filter = (HISTORY_FILTERS as readonly string[]).includes(opts.status ?? '') ? (opts.status as HistoryFilter) : 'alle';
  const jaar = opts.jaar ? Number(opts.jaar) : null;
  const zoek = (opts.zoek ?? '').trim().toLowerCase().slice(0, 100);
  const shown = all.filter((r) => {
    if (jaar && new Date(r.payment.createdAt).getFullYear() !== jaar) return false;
    if (filter === 'betaald' && r.status !== 'betaald' && r.status !== 'deels_terugbetaald') return false;
    if (filter === 'open' && r.status !== 'open') return false;
    if (filter === 'mislukt' && r.status !== 'mislukt' && r.status !== 'niet_betaald') return false;
    if (filter === 'terugbetaald' && r.refundedCents === 0) return false;
    if (zoek && !`${r.invoiceNumber ?? ''} ${r.payment.description}`.toLowerCase().includes(zoek)) return false;
    return true;
  });
  const paid = all.filter((r) => r.invoiceId && (!jaar || new Date(r.payment.createdAt).getFullYear() === jaar));
  return {
    rows: shown,
    jaren,
    totaal: {
      exclCents: paid.reduce((s, r) => s + r.payment.amountExclCents, 0),
      vatCents: paid.reduce((s, r) => s + r.payment.vatCents, 0),
      inclCents: paid.reduce((s, r) => s + r.payment.amountInclCents, 0),
      aantal: paid.length,
    },
    actieNodig: all.filter((r) => r.opnieuwBetalen),
  };
}

/**
 * Een mislukte of verlopen betaling opnieuw proberen: een nieuwe betaling voor
 * precies hetzelfde (periode, bedrag, upgrade of Audit), met een nieuwe betaalpagina.
 */
export async function retryPayment(p: Platform, actor: UserActor, organizationId: string, paymentId: string): Promise<{ payment: Payment; checkoutUrl: string }> {
  await authorize(p.pool, actor.userId, organizationId, 'abonnement:beheren');
  if (!isUuid(paymentId)) throw notFound('Deze betaling');
  const history = await getBillingHistory(p, actor.userId, organizationId);
  const row = history.actieNodig.find((r) => r.payment.id === paymentId);
  if (!row) throw new PlatformError('conflict', 'Deze betaling kun je niet opnieuw doen. Hij is al betaald of vervangen.');
  return withTransaction(p.pool, async (q) => {
    const old = await one<PayRow>(q, `SELECT ${PAY_COLS} FROM payment WHERE id = $1 AND organization_id = $2 FOR UPDATE`, [paymentId, organizationId]);
    if (!old) throw notFound('Deze betaling');
    if (old.subscription_id) {
      const sub = await one<{ status: string }>(q, 'SELECT status FROM subscription WHERE id = $1', [old.subscription_id]);
      if (!sub || sub.status === 'beeindigd') throw new PlatformError('conflict', 'Dit abonnement is beëindigd. Kies opnieuw een pakket.');
    }
    const row2 = await one<{ id: string }>(
      q,
      `INSERT INTO payment (organization_id, subscription_id, audit_order_id, description, period_start, period_end,
                            amount_excl_cents, vat_cents, amount_incl_cents, status, provider, created_by, plan_change, lines)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'open', $10, $11, $12, $13) RETURNING id`,
      [
        organizationId,
        old.subscription_id,
        old.audit_order_id,
        old.description,
        old.period_start,
        old.period_end,
        old.amount_excl_cents,
        old.vat_cents,
        old.amount_incl_cents,
        p.payments.name,
        actor.userId,
        old.plan_change ? JSON.stringify(old.plan_change) : null,
        old.lines ? JSON.stringify(old.lines) : null,
      ],
    );
    const checkoutUrl = await createProviderPayment(p, q, row2!.id, old.amount_incl_cents, old.description);
    await audit(q, actor, { organizationId, action: 'betaling.aangemaakt', subject: row2!.id, detail: { bedrag: old.amount_incl_cents, opnieuwVoor: paymentId } });
    const pay = await one<PayRow>(q, `SELECT ${PAY_COLS} FROM payment WHERE id = $1`, [row2!.id]);
    return { payment: toPay(pay!), checkoutUrl };
  });
}

// Add-on extra domeinen ------------------------------------------------------------------

/** Domeinen boven de limiet van het pakket (add-on, keuze Erik 27-11-2026). */
export function extraDomainsFor(plan: Plan, domains: number): number {
  return Math.max(0, domains - plan.limieten.domeinen);
}

function euroText(cents: number): string {
  return new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR', maximumFractionDigits: cents % 100 ? 2 : 0 }).format(cents / 100).replace(/\u00a0/g, ' ');
}

/**
 * Factuurregels voor een periode: het pakket, plus extra domeinen boven de limiet.
 * Het aantal extra domeinen telt op het moment dat de betaling klaargezet wordt;
 * halverwege een periode bijtellen doen we niet.
 */
export async function periodLines(
  p: Platform,
  q: Queryable,
  organizationId: string,
  plan: Plan,
  interval: BillingInterval,
  monthlyCents: number,
  description: string,
): Promise<InvoiceLine[]> {
  const base = periodAmountCents(monthlyCents, interval);
  const lines: InvoiceLine[] = [{ omschrijving: description.slice(0, 200), aantal: 1, prijsExclCenten: base, totaalExclCenten: base }];
  const extra = extraDomainsFor(plan, (await usageCounts(q, organizationId)).domeinen);
  if (extra > 0 && p.catalog.extraDomeinCenten > 0) {
    const months = interval === 'jaar' ? 12 : 1;
    const each = p.catalog.extraDomeinCenten * months;
    lines.push({
      omschrijving: `Extra domeinen boven ${plan.limieten.domeinen} (${euroText(p.catalog.extraDomeinCenten)} p/m, ${months} mnd)`,
      aantal: extra,
      prijsExclCenten: each,
      totaalExclCenten: extra * each,
    });
  }
  return lines;
}

/** Wat de add-on nu kost, voor de abonnements- en domeinenpagina. */
export async function extraDomainCharge(
  p: Platform,
  userId: string,
  organizationId: string,
): Promise<{ extra: number; perMaandCenten: number; limiet: number | null }> {
  await authorize(p.pool, userId, organizationId, 'org:lezen');
  const sub = await currentSubscription(p.pool, organizationId);
  const plan = sub && accessState(sub) !== 'geen_abonnement' ? findPlan(p.catalog, sub.plan) : undefined;
  if (!plan) return { extra: 0, perMaandCenten: 0, limiet: null };
  const extra = extraDomainsFor(plan, (await usageCounts(p.pool, organizationId)).domeinen);
  return { extra, perMaandCenten: extra * p.catalog.extraDomeinCenten, limiet: plan.limieten.domeinen };
}
