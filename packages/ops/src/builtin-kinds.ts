import { many, one, PlatformError } from '@qbicle/platform';
import { registerProposalKind } from './agents.ts';
import { LIMIT_METRICS, type LimitMetric } from './config.ts';
import { createTicket, getTicket, replyToCustomer, TICKET_CATEGORIES, TICKET_PRIORITIES, type TicketCategory, type TicketPriority } from './support.ts';
import { setLimitOverride } from './usage.ts';

/**
 * De soorten voorstellen die agents standaard kunnen doen. Elk met vaste
 * validatie en uitvoering; agents kunnen hier niets aan toevoegen.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function obj(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new PlatformError('ongeldige_invoer', 'Payload moet een object zijn.');
  return v as Record<string, unknown>;
}

function text(v: unknown, name: string, max: number): string {
  if (typeof v !== 'string' || !v.trim() || v.trim().length > max) {
    throw new PlatformError('ongeldige_invoer', `${name} moet 1 tot ${max} tekens zijn.`);
  }
  return v.trim();
}

function uuid(v: unknown, name: string): string {
  if (typeof v !== 'string' || !UUID.test(v)) throw new PlatformError('ongeldige_invoer', `${name} is geen geldig id.`);
  return v.toLowerCase();
}

/** Vastgelopen of mislukte scan opnieuw in de wachtrij. Intern en omkeerbaar: automatisch. */
registerProposalKind<{ scanId: string }>({
  kind: 'scan.opnieuw',
  label: 'Scan opnieuw in de wachtrij',
  impact: 'geen',
  approvers: ['support'],
  autoApprove: true,
  parse: (p) => ({ scanId: uuid(obj(p).scanId, 'scanId') }),
  async execute(ctx, { payload }) {
    const r = await one<{ attempts: number }>(
      ctx.pool,
      `UPDATE scan SET status = 'wachtrij', started_at = NULL, finished_at = NULL, error = NULL, attempts = attempts + 1
        WHERE id = $1 AND status IN ('bezig', 'mislukt') AND attempts < 3 RETURNING attempts`,
      [payload.scanId],
    );
    if (!r) throw new Error('Scan is niet meer vast of mislukt, of is al 3 keer opnieuw geprobeerd');
    return { poging: r.attempts };
  },
});

/** Interne melding (ticket) openen voor iets wat een mens moet bekijken. Automatisch. */
registerProposalKind<{ subject: string; body: string; priority: TicketPriority; category: TicketCategory | null }>({
  kind: 'ticket.melding',
  label: 'Interne melding openen',
  impact: 'geen',
  approvers: ['support'],
  autoApprove: true,
  parse(p) {
    const o = obj(p);
    const priority = (o.priority ?? 'normaal') as TicketPriority;
    const category = (o.category ?? null) as TicketCategory | null;
    if (!TICKET_PRIORITIES.includes(priority)) throw new PlatformError('ongeldige_invoer', 'Onbekende prioriteit.');
    if (category !== null && !TICKET_CATEGORIES.includes(category)) throw new PlatformError('ongeldige_invoer', 'Onbekende categorie.');
    return { subject: text(o.subject, 'Onderwerp', 200), body: text(o.body, 'Bericht', 4000), priority, category };
  },
  async execute(ctx, { proposal, payload }) {
    const t = await createTicket(ctx.pool, { kind: 'agent', agentKey: proposal.agent_key }, {
      channel: 'agent',
      organizationId: proposal.organization_id,
      subject: payload.subject,
      body: payload.body,
      priority: payload.priority,
      category: payload.category,
    });
    return { ticket: t.id, nummer: t.number };
  },
});

/** Door een agent opgesteld antwoord aan een klant. Een medewerker leest mee en keurt goed. */
registerProposalKind<{ ticketId: string; body: string }>({
  kind: 'ticket.antwoord',
  label: 'Antwoord aan klant sturen',
  impact: 'klant',
  approvers: ['support'],
  parse(p) {
    const o = obj(p);
    return { ticketId: uuid(o.ticketId, 'ticketId'), body: text(o.body, 'Antwoord', 8000) };
  },
  async check(q, { payload, organizationId }) {
    const t = await one<{ organization_id: string | null; requester_email: string | null; status: string }>(
      q,
      'SELECT organization_id, requester_email, status FROM support_ticket WHERE id = $1',
      [payload.ticketId],
    );
    if (!t) throw new PlatformError('niet_gevonden', 'Dit ticket bestaat niet.');
    if (!t.requester_email) throw new PlatformError('conflict', 'Dit ticket heeft geen e-mailadres van de klant.');
    if ((t.organization_id ?? null) !== (organizationId ?? null)) throw new PlatformError('ongeldige_invoer', 'Klant van het voorstel hoort niet bij dit ticket.');
  },
  async execute(ctx, { proposal, payload, approvedBy }) {
    const { ticket } = await getTicket(ctx.pool, payload.ticketId);
    if (ticket.status === 'gesloten') throw new Error('Ticket is inmiddels gesloten');
    const m = await replyToCustomer(ctx, { kind: 'goedgekeurd_voorstel', agentKey: proposal.agent_key, approvedBy: approvedBy ?? '' }, payload.ticketId, payload.body);
    return { bericht: m.id, aan: ticket.requester_email };
  },
});

/** Bericht aan de eigenaren van een klant, bijv. over gebruik. Alleen eigenaren; nooit een vrij adres. */
registerProposalKind<{ subject: string; body: string }>({
  kind: 'klant.bericht',
  label: 'Bericht aan klant mailen',
  impact: 'klant',
  approvers: ['support'],
  requiresOrganization: true,
  parse(p) {
    const o = obj(p);
    return { subject: text(o.subject, 'Onderwerp', 150), body: text(o.body, 'Bericht', 4000) };
  },
  async execute(ctx, { proposal, payload }) {
    const owners = await many<{ email: string }>(
      ctx.pool,
      `SELECT u.email::text FROM membership m JOIN app_user u ON u.id = m.user_id
        WHERE m.organization_id = $1 AND m.role = 'eigenaar' AND u.disabled_at IS NULL`,
      [proposal.organization_id],
    );
    if (owners.length === 0) throw new Error('Deze klant heeft geen eigenaar met een actief account');
    for (const o of owners) {
      await ctx.mailer.send({ to: o.email, subject: payload.subject, text: `${payload.body}\n\nMet vriendelijke groet,\nQbicle` });
    }
    return { aantal: owners.length };
  },
});

/** Afwijkende gebruikslimiet voor één klant. Raakt omzet en kosten: financieel. */
registerProposalKind<{ metric: LimitMetric; limit: number | null; reason: string }>({
  kind: 'limiet.aanpassen',
  label: 'Gebruikslimiet aanpassen',
  impact: 'financieel',
  approvers: ['financieel'],
  requiresOrganization: true,
  parse(p) {
    const o = obj(p);
    if (!LIMIT_METRICS.includes(o.metric as LimitMetric)) throw new PlatformError('ongeldige_invoer', 'Onbekende limiet.');
    if (o.limit !== null && (typeof o.limit !== 'number' || !Number.isFinite(o.limit) || o.limit < 0)) {
      throw new PlatformError('ongeldige_invoer', 'Limiet moet een getal >= 0 of null (onbeperkt) zijn.');
    }
    return { metric: o.metric as LimitMetric, limit: o.limit as number | null, reason: text(o.reason, 'Reden', 400) };
  },
  async execute(ctx, { proposal, payload, approvedBy }) {
    await setLimitOverride(ctx.pool, {
      organizationId: proposal.organization_id!,
      metric: payload.metric,
      limit: payload.limit,
      reason: payload.reason,
      setBy: approvedBy,
    });
    return { limiet: payload.metric, waarde: payload.limit };
  },
});
