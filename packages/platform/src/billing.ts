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
}

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
}
const SUB_COLS = `id, organization_id, plan, billing_interval, monthly_price_cents, status, trial_ends_at,
  current_period_start, current_period_end, cancel_at_period_end, created_at`;
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
}
const PAY_COLS = `id, organization_id, subscription_id, audit_order_id, description, period_start, period_end,
  amount_excl_cents, vat_cents, amount_incl_cents, status, provider, provider_payment_id, checkout_url, created_at, paid_at`;
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

export function accessState(sub: Subscription | undefined, now = new Date()): AccessState {
  if (!sub || sub.status === 'beeindigd') return 'geen_abonnement';
  if ((sub.status === 'actief' || sub.status === 'opgezegd') && sub.currentPeriodEnd && sub.currentPeriodEnd > now) return 'actief';
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
export async function cancelSubscription(p: Platform, actor: UserActor, organizationId: string): Promise<Subscription> {
  await authorize(p.pool, actor.userId, organizationId, 'abonnement:beheren');
  return withTransaction(p.pool, async (q) => {
    const cur = await currentSubscription(q, organizationId, true);
    if (!cur) throw new PlatformError('conflict', 'Er is geen lopend abonnement om op te zeggen.');
    const paidAndRunning = accessState(cur) === 'actief';
    const r = await one<SubRow>(
      q,
      paidAndRunning
        ? `UPDATE subscription SET status = 'opgezegd', cancel_at_period_end = true, canceled_at = now() WHERE id = $1 RETURNING ${SUB_COLS}`
        : `UPDATE subscription SET status = 'beeindigd', canceled_at = now() WHERE id = $1 RETURNING ${SUB_COLS}`,
      [cur.id],
    );
    await q.query(
      `UPDATE payment SET status = 'geannuleerd' WHERE subscription_id = $1 AND status = 'open'`,
      [cur.id],
    );
    if (!paidAndRunning) await q.query(`UPDATE organization SET plan = 'gratis' WHERE id = $1`, [organizationId]);
    await audit(q, actor, { organizationId, action: 'abonnement.opgezegd', subject: cur.id, detail: { directStoppen: !paidAndRunning } });
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
  return {
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
    const sub = await currentSubscription(q, organizationId, true);
    if (!sub) throw new PlatformError('conflict', 'Kies eerst een pakket.');
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

    const excl = periodAmountCents(monthly, sub.interval);
    const vat = vatCents(p.catalog, excl);
    const description = `${plan.naam}, ${sub.interval === 'jaar' ? 'jaar' : 'maand'} ${nlDate(start)} t/m ${nlDate(new Date(end.getTime() - 86_400_000))}`;

    await q.query(`UPDATE payment SET status = 'geannuleerd' WHERE subscription_id = $1 AND status = 'open'`, [sub.id]);
    const row = await one<{ id: string }>(
      q,
      `INSERT INTO payment (organization_id, subscription_id, description, period_start, period_end,
                            amount_excl_cents, vat_cents, amount_incl_cents, status, provider, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'open', $9, $10) RETURNING id`,
      [organizationId, sub.id, description.slice(0, 200), start, end, excl, vat, excl + vat, p.payments.name, actor.userId],
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
      if (r.subscription_id) {
        await q.query(
          `UPDATE subscription
              SET status = 'actief', cancel_at_period_end = false,
                  -- Verlenging: de lopende periode schuift door. Anders begint hij bij de betaalde periode
                  -- (bij betalen tijdens de proef is dat het einde van de proef).
                  current_period_start = CASE WHEN current_period_start IS NOT NULL AND current_period_end >= $2
                                              THEN current_period_start ELSE $2 END,
                  current_period_end = $3
            WHERE id = $1`,
          [r.subscription_id, r.period_start, r.period_end],
        );
        const sub = await one<{ plan: string }>(q, 'SELECT plan FROM subscription WHERE id = $1', [r.subscription_id]);
        await q.query('UPDATE organization SET plan = $2 WHERE id = $1', [r.organization_id, sub!.plan]);
        await audit(q, actor, { organizationId: r.organization_id, action: 'abonnement.geactiveerd', subject: r.subscription_id });
      }
      if (r.audit_order_id) {
        await q.query(`UPDATE audit_order SET status = 'betaald' WHERE id = $1 AND status = 'wacht_op_betaling'`, [r.audit_order_id]);
      }
      await issueInvoice(p, q, r, actor);
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
  const lines: InvoiceLine[] = [
    { omschrijving: pay.description, aantal: 1, prijsExclCenten: pay.amount_excl_cents, totaalExclCenten: pay.amount_excl_cents },
  ];
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
  }>(
    q,
    `SELECT name, billing_name, billing_email::text, billing_address, billing_postcode, billing_city, billing_country, kvk_number, vat_number
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
            billing_city = $6, billing_country = $7, kvk_number = $8, vat_number = $9
      WHERE id = $1`,
    [organizationId, opt(input.naam, 200, 'Naam'), email, opt(input.adres, 400, 'Adres'), opt(input.postcode, 16, 'Postcode'), opt(input.plaats, 100, 'Plaats'), land, kvk, btw],
  );
  await audit(p.pool, actor, { organizationId, action: 'factuurgegevens.gewijzigd', subject: organizationId });
  return billingDetailsRow(p.pool, organizationId);
}
