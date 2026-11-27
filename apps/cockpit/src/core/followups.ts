import { audit, isNepProvider, many, one, PlatformError, syncPayment, withTransaction, type Actor, type Platform, type Queryable } from '@qbicle/platform';
import { FAILURE_LABEL, type FailureReason } from './collections.ts';

/**
 * Vervolg op mislukte incasso's. Bij elke mislukte regel komt er automatisch een
 * voorstel klaar (wat te doen, waarom, en een conceptmail aan de klant). Een
 * medewerker voert het voorstel uit, kiest een andere actie, of wijst het af.
 * Er gaat nooit iets naar de klant zonder die klik.
 */

export const FOLLOWUP_ACTIONS = ['herpoging', 'klant_mailen', 'factuur_sturen', 'bellen'] as const;
export type FollowupAction = (typeof FOLLOWUP_ACTIONS)[number];

export const ACTION_LABEL: Record<FollowupAction, string> = {
  herpoging: 'Opnieuw incasseren',
  klant_mailen: 'Klant mailen',
  factuur_sturen: 'Betaalverzoek per mail sturen',
  bellen: 'Klant bellen',
};

const euro = (c: number) => new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' }).format(c / 100);

interface ItemContext {
  id: string;
  organization_id: string;
  organization_name: string;
  description: string;
  amount_incl_cents: number;
  failure_reason: FailureReason | null;
  failures: number;
  payment_method: string;
}

/** Regels die nu het "agent"-voorstel maken. Later vervangbaar door een echte agent. */
export function suggest(it: Pick<ItemContext, 'failure_reason' | 'failures'>): { action: FollowupAction; reason: string } {
  const r = it.failure_reason ?? 'onbekend';
  if (it.failures >= 3) return { action: 'bellen', reason: `${it.failures}e mislukte incasso in een half jaar: persoonlijk contact werkt hier beter dan nog een mail.` };
  if (r === 'mandaat_ingetrokken' || r === 'rekening_opgeheven') {
    return { action: 'factuur_sturen', reason: `${FAILURE_LABEL[r]}: opnieuw incasseren lukt niet. Stuur een betaalverzoek; met de eerste betaling geeft de klant een nieuw mandaat.` };
  }
  if (r === 'storno') return { action: 'klant_mailen', reason: 'De klant heeft de incasso zelf teruggeboekt. Eerst vragen waarom, niet meteen opnieuw incasseren.' };
  if (r === 'geen_dekking' && it.failures <= 1) return { action: 'herpoging', reason: 'Eerste keer geen dekking: meestal lukt een nieuwe poging over een paar dagen.' };
  return { action: 'factuur_sturen', reason: 'Incasso lukt niet. Een betaalverzoek per mail geeft de klant de kans zelf te betalen.' };
}

/** Conceptmail per actie. Ook gebruikt als de medewerker een andere actie kiest dan voorgesteld. */
export function mailDraft(
  it: Pick<ItemContext, 'organization_id' | 'description' | 'amount_incl_cents' | 'failure_reason'>,
  action: FollowupAction,
  appOrigin: string,
): { subject: string; body: string } {
  const bedrag = euro(it.amount_incl_cents);
  const link = `${appOrigin}/o/${it.organization_id}/abonnement`;
  const reden =
    it.failure_reason === 'geen_dekking'
      ? 'Er was onvoldoende saldo op de rekening.'
      : it.failure_reason === 'storno'
        ? 'De afschrijving is teruggeboekt.'
        : it.failure_reason === 'mandaat_ingetrokken'
          ? 'De machtiging voor automatische incasso is ingetrokken.'
          : it.failure_reason === 'rekening_opgeheven'
            ? 'De rekening waarvan we afschreven bestaat niet meer.'
            : 'De bank heeft de afschrijving niet uitgevoerd.';
  const opening = `Beste klant van Qbicle,\n\nDe automatische incasso van ${bedrag} voor ${it.description} is niet gelukt. ${reden}`;
  const slot = '\n\nHeb je vragen? Beantwoord dan deze mail.\n\nMet vriendelijke groet,\nQbicle';
  if (action === 'factuur_sturen') {
    return {
      subject: `Betaalverzoek Qbicle: ${it.description}`,
      body: `${opening}\n\nJe kunt het bedrag betalen via de betaallink hieronder. Daarmee loopt je abonnement gewoon door.\n\n{betaallink}${slot}`,
    };
  }
  if (action === 'herpoging') {
    return {
      subject: `Nieuwe poging automatische incasso: ${it.description}`,
      body: `${opening}\n\nWe proberen het bedrag binnenkort opnieuw af te schrijven. Zorg ervoor dat er voldoende saldo is. Je hoeft verder niets te doen.${slot}`,
    };
  }
  return {
    subject: `Incasso niet gelukt: ${it.description}`,
    body: `${opening}\n\nWil je ons laten weten wat er aan de hand is? Je kunt je betaalgegevens ook zelf bekijken via ${link}.${slot}`,
  };
}

async function itemContext(q: Queryable, itemId: string): Promise<ItemContext> {
  const it = await one<ItemContext>(
    q,
    `SELECT i.id, i.organization_id, o.name AS organization_name, i.description, i.amount_incl_cents, i.failure_reason, o.payment_method,
            (SELECT count(*) FROM collection_item f WHERE f.organization_id = i.organization_id AND f.status = 'mislukt'
                AND f.result_at > now() - interval '180 days')::int AS failures
       FROM collection_item i JOIN organization o ON o.id = i.organization_id WHERE i.id = $1`,
    [itemId],
  );
  if (!it) throw new PlatformError('niet_gevonden', 'Deze regel bestaat niet.');
  return it;
}

/** Wordt aangeroepen zodra een regel mislukt. Idempotent. */
export async function createFollowupSuggestion(q: Queryable, appOrigin: string, itemId: string): Promise<void> {
  const it = await itemContext(q, itemId);
  const s = suggest(it);
  const mail = s.action === 'bellen' ? null : mailDraft(it, s.action, appOrigin);
  await q.query(
    `INSERT INTO collection_followup (item_id, organization_id, suggested_action, suggestion_reason, mail_subject, mail_body)
     VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (item_id) DO NOTHING`,
    [itemId, it.organization_id, s.action, s.reason, mail?.subject ?? null, mail?.body ?? null],
  );
}

export interface FollowupRow {
  id: string;
  item_id: string;
  organization_id: string;
  organization_name: string;
  description: string;
  amount_incl_cents: number;
  failure_reason: FailureReason | null;
  failures: number;
  suggested_action: FollowupAction;
  suggestion_reason: string;
  mail_subject: string | null;
  mail_body: string | null;
  status: 'voorgesteld' | 'uitgevoerd' | 'afgewezen';
  chosen_action: FollowupAction | null;
  decided_at: Date | null;
  decided_by_email: string | null;
  decision_note: string | null;
  result_payment_id: string | null;
  result_payment_status: string | null;
  recipient: string | null;
  created_at: Date;
}

export async function listFollowups(q: Queryable, status: 'open' | 'afgehandeld' = 'open', limit = 100): Promise<FollowupRow[]> {
  return many<FollowupRow>(
    q,
    `SELECT f.id, f.item_id, f.organization_id, o.name AS organization_name, i.description, i.amount_incl_cents, i.failure_reason,
            (SELECT count(*) FROM collection_item x WHERE x.organization_id = i.organization_id AND x.status = 'mislukt'
                AND x.result_at > now() - interval '180 days')::int AS failures,
            f.suggested_action, f.suggestion_reason, f.mail_subject, f.mail_body, f.status, f.chosen_action, f.decided_at,
            du.email::text AS decided_by_email, f.decision_note, f.result_payment_id, rp.status AS result_payment_status,
            coalesce(o.billing_email::text,
                     (SELECT u.email::text FROM membership m JOIN app_user u ON u.id = m.user_id
                       WHERE m.organization_id = o.id AND m.role = 'eigenaar' AND u.disabled_at IS NULL ORDER BY m.created_at LIMIT 1)) AS recipient,
            f.created_at
       FROM collection_followup f
       JOIN collection_item i ON i.id = f.item_id
       JOIN organization o ON o.id = f.organization_id
       LEFT JOIN app_user du ON du.id = f.decided_by
       LEFT JOIN payment rp ON rp.id = f.result_payment_id
      WHERE ($1 = 'open' AND f.status = 'voorgesteld') OR ($1 = 'afgehandeld' AND f.status <> 'voorgesteld')
      ORDER BY f.created_at DESC LIMIT $2`,
    [status, limit],
  );
}

export async function countOpenFollowups(q: Queryable): Promise<number> {
  return (await one<{ n: number }>(q, `SELECT count(*)::int AS n FROM collection_followup WHERE status = 'voorgesteld'`))?.n ?? 0;
}

/** Nieuwe betaling voor hetzelfde bedrag en dezelfde periode als de mislukte incasso. */
async function newPaymentFor(p: Platform, q: Queryable, itemId: string, prefix: string, actor: Actor): Promise<{ id: string; checkoutUrl: string }> {
  const pay = await one<{ id: string; amount_incl_cents: number; description: string }>(
    q,
    `INSERT INTO payment (organization_id, subscription_id, description, period_start, period_end,
                          amount_excl_cents, vat_cents, amount_incl_cents, status, provider, created_by)
     SELECT organization_id, subscription_id, $2 || description, period_start, period_end,
            amount_excl_cents, vat_cents, amount_incl_cents, 'open', $3, $4
       FROM collection_item WHERE id = $1
     RETURNING id, amount_incl_cents, description`,
    [itemId, prefix, p.payments.name, actor.userId],
  );
  const created = await p.payments.createPayment({
    paymentId: pay!.id,
    amountInclCents: pay!.amount_incl_cents,
    description: `Qbicle ${pay!.description}`,
    redirectUrl: `${p.config.appOrigin}/betaling/${pay!.id}`,
    webhookUrl: `${p.config.appOrigin}/api/v1/betalingen/webhook`,
  });
  await q.query('UPDATE payment SET provider_payment_id = $2, checkout_url = $3 WHERE id = $1', [pay!.id, created.providerPaymentId, created.checkoutUrl]);
  return { id: pay!.id, checkoutUrl: created.checkoutUrl };
}

export async function executeFollowup(
  p: Platform,
  followupId: string,
  input: { actie: FollowupAction; onderwerp?: string | null; tekst?: string | null; notitie?: string | null },
  actor: Actor,
): Promise<{ paymentId?: string; mailedTo?: string }> {
  const note = input.notitie?.trim() || null;
  if (input.actie === 'bellen' && !note) throw new PlatformError('ongeldige_invoer', 'Noteer kort wat er met de klant is afgesproken.');
  const mailNeeded = input.actie !== 'bellen';
  const subject = input.onderwerp?.trim() || '';
  const body = input.tekst?.trim() || '';
  if (mailNeeded && (!subject || !body)) throw new PlatformError('ongeldige_invoer', 'Vul het onderwerp en de tekst van de mail in.');
  if (input.actie === 'factuur_sturen' && !body.includes('{betaallink}')) {
    throw new PlatformError('ongeldige_invoer', 'Zet {betaallink} in de tekst; daar komt de link om te betalen.');
  }

  const result = await withTransaction(p.pool, async (q) => {
    const f = await one<{ status: string; item_id: string; organization_id: string }>(
      q,
      'SELECT status, item_id, organization_id FROM collection_followup WHERE id = $1 FOR UPDATE',
      [followupId],
    );
    if (!f) throw new PlatformError('niet_gevonden', 'Dit voorstel bestaat niet.');
    if (f.status !== 'voorgesteld') throw new PlatformError('conflict', 'Dit voorstel is al afgehandeld.');
    const row = (await listFollowupById(q, followupId))!;
    if (mailNeeded && !row.recipient) throw new PlatformError('conflict', 'Er is geen e-mailadres voor deze klant (factuuradres of eigenaar).');

    let paymentId: string | undefined;
    let text = body;
    if (input.actie === 'herpoging' || input.actie === 'factuur_sturen') {
      const pay = await newPaymentFor(p, q, f.item_id, input.actie === 'herpoging' ? 'Herpoging: ' : 'Betaalverzoek: ', actor);
      paymentId = pay.id;
      text = text.replaceAll('{betaallink}', pay.checkoutUrl);
    }
    await q.query(
      `UPDATE collection_followup SET status = 'uitgevoerd', chosen_action = $2, decided_at = now(), decided_by = $3,
              decision_note = $4, result_payment_id = $5, mail_subject = coalesce($6, mail_subject), mail_body = coalesce($7, mail_body)
        WHERE id = $1`,
      [followupId, input.actie, actor.userId, note, paymentId ?? null, mailNeeded ? subject : null, mailNeeded ? text : null],
    );
    await audit(q, actor, {
      organizationId: f.organization_id,
      action: 'cockpit.incasso_vervolg_uitgevoerd',
      subject: followupId,
      detail: { actie: input.actie, voorstel: row.suggested_action, ...(paymentId ? { betaling: paymentId } : {}), ...(mailNeeded ? { mail_aan: row.recipient } : {}) },
    });
    return { paymentId, recipient: mailNeeded ? row.recipient! : undefined, text };
  });
  // Mail pas na een geslaagde transactie.
  if (result.recipient) await p.mailer.send({ to: result.recipient, subject, text: result.text });
  return { paymentId: result.paymentId, mailedTo: result.recipient };
}

async function listFollowupById(q: Queryable, id: string): Promise<FollowupRow | undefined> {
  const rows = await many<FollowupRow>(
    q,
    `SELECT f.suggested_action,
            coalesce(o.billing_email::text,
                     (SELECT u.email::text FROM membership m JOIN app_user u ON u.id = m.user_id
                       WHERE m.organization_id = o.id AND m.role = 'eigenaar' AND u.disabled_at IS NULL ORDER BY m.created_at LIMIT 1)) AS recipient
       FROM collection_followup f JOIN organization o ON o.id = f.organization_id WHERE f.id = $1`,
    [id],
  );
  return rows[0];
}

export async function rejectFollowup(p: Platform, followupId: string, note: string, actor: Actor): Promise<void> {
  const why = note.trim();
  if (!why || why.length > 400) throw new PlatformError('ongeldige_invoer', 'Geef kort aan waarom je dit voorstel afwijst.');
  await withTransaction(p.pool, async (q) => {
    const f = await one<{ status: string; organization_id: string }>(q, 'SELECT status, organization_id FROM collection_followup WHERE id = $1 FOR UPDATE', [followupId]);
    if (!f) throw new PlatformError('niet_gevonden', 'Dit voorstel bestaat niet.');
    if (f.status !== 'voorgesteld') throw new PlatformError('conflict', 'Dit voorstel is al afgehandeld.');
    await q.query(
      `UPDATE collection_followup SET status = 'afgewezen', decided_at = now(), decided_by = $2, decision_note = $3 WHERE id = $1`,
      [followupId, actor.userId, why],
    );
    await audit(q, actor, { organizationId: f.organization_id, action: 'cockpit.incasso_vervolg_afgewezen', subject: followupId, detail: { reden: why } });
  });
}

/** Testmodus: uitkomst van een herpoging of betaalverzoek nabootsen. */
export async function settleTestFollowupPayment(p: Platform, followupId: string, outcome: 'betaald' | 'mislukt', actor: Actor): Promise<string> {
  const provider = p.payments;
  if (!isNepProvider(provider)) throw new PlatformError('geen_toegang', 'Testuitkomsten kunnen alleen in testmodus.');
  const r = await one<{ id: string; provider_payment_id: string | null }>(
    p.pool,
    'SELECT pm.id, pm.provider_payment_id FROM collection_followup f JOIN payment pm ON pm.id = f.result_payment_id WHERE f.id = $1',
    [followupId],
  );
  if (!r?.provider_payment_id) throw new PlatformError('niet_gevonden', 'Er hoort geen betaling bij dit voorstel.');
  provider.settle(r.provider_payment_id, outcome);
  return (await syncPayment(p, r.id, actor)).status;
}
