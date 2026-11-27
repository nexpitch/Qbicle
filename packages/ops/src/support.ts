import type pg from 'pg';
import { many, notFound, one, PlatformError, withTransaction, type Queryable } from '@qbicle/platform';
import { opsAudit } from './audit.ts';
import type { OpsActor, OpsContext } from './context.ts';
import { listErrors, listMails, listScanJobs } from './health.ts';
import { effectiveLimits, limitStatus } from './usage.ts';

export const TICKET_STATUSES = ['open', 'wacht_op_klant', 'opgelost', 'gesloten'] as const;
export const TICKET_PRIORITIES = ['laag', 'normaal', 'hoog', 'urgent'] as const;
export const TICKET_CHANNELS = ['mail', 'app', 'agent', 'systeem', 'telefoon'] as const;
export const TICKET_CATEGORIES = ['inloggen', 'scan', 'bevinding', 'factuur', 'abonnement', 'netwerk', 'overig'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];
export type TicketChannel = (typeof TICKET_CHANNELS)[number];
export type TicketCategory = (typeof TICKET_CATEGORIES)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface Ticket {
  id: string;
  number: number;
  organization_id: string | null;
  organization_name: string | null;
  requester_email: string | null;
  subject: string;
  status: TicketStatus;
  priority: TicketPriority;
  channel: TicketChannel;
  category: TicketCategory | null;
  assignee: string | null;
  created_at: Date;
  updated_at: Date;
  first_response_at: Date | null;
  resolved_at: Date | null;
}

export interface TicketMessage {
  id: string;
  author_kind: 'klant' | 'medewerker' | 'agent' | 'systeem';
  author_user_id: string | null;
  author_email: string | null;
  author_agent: string | null;
  body: string;
  internal: boolean;
  created_at: Date;
}

const TICKET_SELECT = `SELECT t.id, t.number, t.organization_id, o.name AS organization_name, t.requester_email::text,
  t.subject, t.status, t.priority, t.channel, t.category, t.assignee, t.created_at, t.updated_at,
  t.first_response_at, t.resolved_at
  FROM support_ticket t LEFT JOIN organization o ON o.id = t.organization_id`;

function authorOf(actor: OpsActor | { kind: 'klant'; userId: string | null }) {
  if (actor.kind === 'medewerker') return { kind: 'medewerker' as const, userId: actor.userId, agent: null };
  if (actor.kind === 'agent') return { kind: 'agent' as const, userId: null, agent: actor.agentKey };
  if (actor.kind === 'klant') return { kind: 'klant' as const, userId: actor.userId, agent: null };
  return { kind: 'systeem' as const, userId: null, agent: null };
}

/**
 * Nieuw ticket. Zonder organisatie zoekt Qbicle die op via het e-mailadres
 * (alleen als dat adres bij precies één organisatie hoort).
 */
export async function createTicket(
  pool: pg.Pool,
  actor: OpsActor | { kind: 'klant'; userId: string | null },
  input: {
    subject: string;
    body: string;
    channel: TicketChannel;
    organizationId?: string | null;
    requesterEmail?: string | null;
    priority?: TicketPriority;
    category?: TicketCategory | null;
  },
): Promise<Ticket> {
  const subject = input.subject.trim();
  const body = input.body.trim();
  if (!subject || subject.length > 200) throw new PlatformError('ongeldige_invoer', 'Onderwerp moet 1 tot 200 tekens zijn.');
  if (!body || body.length > 20000) throw new PlatformError('ongeldige_invoer', 'Bericht moet 1 tot 20.000 tekens zijn.');
  if (!TICKET_CHANNELS.includes(input.channel)) throw new PlatformError('ongeldige_invoer', 'Onbekend kanaal.');
  if (input.priority && !TICKET_PRIORITIES.includes(input.priority)) throw new PlatformError('ongeldige_invoer', 'Onbekende prioriteit.');
  if (input.category && !TICKET_CATEGORIES.includes(input.category)) throw new PlatformError('ongeldige_invoer', 'Onbekende categorie.');
  if (input.organizationId && !UUID.test(input.organizationId)) throw notFound('Deze organisatie');
  const email = input.requesterEmail?.trim().toLowerCase() || null;
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new PlatformError('ongeldige_invoer', 'Ongeldig e-mailadres.');

  return withTransaction(pool, async (c) => {
    let orgId = input.organizationId ?? null;
    let requesterUserId = actor.kind === 'klant' ? actor.userId : null;
    if (email) {
      const u = await one<{ id: string }>(c, 'SELECT id FROM app_user WHERE email = $1', [email]);
      requesterUserId ??= u?.id ?? null;
      if (!orgId && u) {
        const orgs = await many<{ organization_id: string }>(c, 'SELECT organization_id FROM membership WHERE user_id = $1', [u.id]);
        if (orgs.length === 1) orgId = orgs[0]!.organization_id;
      }
    }
    const t = await one<{ id: string }>(
      c,
      `INSERT INTO support_ticket (organization_id, requester_email, requester_user_id, subject, priority, channel, category)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [orgId, email, requesterUserId, subject, input.priority ?? 'normaal', input.channel, input.category ?? null],
    );
    const a = authorOf(actor);
    await c.query(
      `INSERT INTO support_message (ticket_id, author_kind, author_user_id, author_agent, body, internal)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      // Een ticket dat een agent of het systeem opent, is een interne melding.
      [t!.id, a.kind, a.userId, a.agent, body, a.kind === 'agent' || a.kind === 'systeem'],
    );
    if (actor.kind !== 'klant') {
      await opsAudit(c, actor, { action: 'ops.ticket_aangemaakt', organizationId: orgId, subject: t!.id, detail: { onderwerp: subject } });
    }
    return (await one<Ticket>(c, `${TICKET_SELECT} WHERE t.id = $1`, [t!.id]))!;
  });
}

export async function getTicket(q: Queryable, id: string): Promise<{ ticket: Ticket; messages: TicketMessage[] }> {
  if (!UUID.test(id)) throw notFound('Dit ticket');
  const ticket = await one<Ticket>(q, `${TICKET_SELECT} WHERE t.id = $1`, [id]);
  if (!ticket) throw notFound('Dit ticket');
  const messages = await many<TicketMessage>(
    q,
    `SELECT m.id, m.author_kind, m.author_user_id, u.email::text AS author_email, m.author_agent, m.body, m.internal, m.created_at
       FROM support_message m LEFT JOIN app_user u ON u.id = m.author_user_id
      WHERE m.ticket_id = $1 ORDER BY m.created_at, m.id`,
    [id],
  );
  return { ticket, messages };
}

export async function listTickets(
  q: Queryable,
  opts: { status?: TicketStatus | 'actief'; organizationId?: string; assignee?: string; search?: string; limit?: number } = {},
): Promise<Ticket[]> {
  const search = opts.search?.trim() ? `%${opts.search.trim().replace(/[%_\\]/g, (m) => '\\' + m)}%` : null;
  return many<Ticket>(
    q,
    `${TICKET_SELECT}
      WHERE ($1::text IS NULL OR ($1 = 'actief' AND t.status IN ('open', 'wacht_op_klant')) OR t.status = $1)
        AND ($2::uuid IS NULL OR t.organization_id = $2)
        AND ($3::text IS NULL OR t.assignee = $3)
        AND ($4::text IS NULL OR t.subject ILIKE $4 OR t.requester_email::text ILIKE $4 OR o.name ILIKE $4
             OR t.number::text = trim(both '%' from $4))
      ORDER BY CASE t.priority WHEN 'urgent' THEN 0 WHEN 'hoog' THEN 1 WHEN 'normaal' THEN 2 ELSE 3 END,
               t.updated_at DESC
      LIMIT $5`,
    [opts.status ?? null, opts.organizationId ?? null, opts.assignee ?? null, search, Math.min(Math.max(opts.limit ?? 50, 1), 500)],
  );
}

/**
 * Bericht bij een ticket. Een openbaar antwoord van een medewerker zet het
 * ticket op 'wacht_op_klant'; een reactie van de klant zet het weer open.
 * Mailen naar de klant gebeurt apart (replyToCustomer), zodat een agent nooit zelf mailt.
 */
export async function addTicketMessage(
  pool: pg.Pool,
  actor: OpsActor | { kind: 'klant'; userId: string | null },
  ticketId: string,
  input: { body: string; internal?: boolean },
): Promise<TicketMessage> {
  const body = input.body.trim();
  if (!body || body.length > 20000) throw new PlatformError('ongeldige_invoer', 'Bericht moet 1 tot 20.000 tekens zijn.');
  if (!UUID.test(ticketId)) throw notFound('Dit ticket');
  const a = authorOf(actor);
  // Agents schrijven alleen interne notities; een antwoord aan de klant is een voorstel.
  const internal = a.kind === 'agent' || a.kind === 'systeem' ? true : a.kind === 'klant' ? false : (input.internal ?? false);
  return withTransaction(pool, async (c) => {
    const t = await one<{ status: TicketStatus; organization_id: string | null }>(
      c,
      'SELECT status, organization_id FROM support_ticket WHERE id = $1 FOR UPDATE',
      [ticketId],
    );
    if (!t) throw notFound('Dit ticket');
    const m = await one<{ id: string }>(
      c,
      `INSERT INTO support_message (ticket_id, author_kind, author_user_id, author_agent, body, internal)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [ticketId, a.kind, a.userId, a.agent, body, internal],
    );
    let status = t.status;
    if (a.kind === 'klant') status = 'open';
    else if (a.kind === 'medewerker' && !internal && t.status === 'open') status = 'wacht_op_klant';
    await c.query(
      `UPDATE support_ticket SET status = $2, updated_at = now(),
              first_response_at = CASE WHEN $3 AND first_response_at IS NULL THEN now() ELSE first_response_at END,
              resolved_at = CASE WHEN $2 IN ('opgelost', 'gesloten') THEN resolved_at ELSE NULL END
        WHERE id = $1`,
      [ticketId, status, a.kind === 'medewerker' && !internal],
    );
    if (actor.kind !== 'klant') {
      await opsAudit(c, actor, {
        action: internal ? 'ops.ticket_notitie' : 'ops.ticket_antwoord',
        organizationId: t.organization_id,
        subject: ticketId,
      });
    }
    const out = await one<TicketMessage>(
      c,
      `SELECT m.id, m.author_kind, m.author_user_id, u.email::text AS author_email, m.author_agent, m.body, m.internal, m.created_at
         FROM support_message m LEFT JOIN app_user u ON u.id = m.author_user_id WHERE m.id = $1`,
      [m!.id],
    );
    return out!;
  });
}

/** Antwoord van een medewerker aan de klant: bericht bij het ticket plus een mail. */
export async function replyToCustomer(
  ctx: Pick<OpsContext, 'pool' | 'mailer'>,
  actor: Extract<OpsActor, { kind: 'medewerker' }> | { kind: 'goedgekeurd_voorstel'; agentKey: string; approvedBy: string },
  ticketId: string,
  body: string,
): Promise<TicketMessage> {
  const { ticket } = await getTicket(ctx.pool, ticketId);
  const to = ticket.requester_email;
  if (!to) throw new PlatformError('conflict', 'Dit ticket heeft geen e-mailadres van de klant.');
  let msg: TicketMessage;
  if (actor.kind === 'medewerker') {
    msg = await addTicketMessage(ctx.pool, actor, ticketId, { body, internal: false });
  } else {
    // Door een agent opgesteld en door een medewerker goedgekeurd: openbaar bericht namens de agent.
    msg = await withTransaction(ctx.pool, async (c) => {
      const m = await one<TicketMessage>(
        c,
        `INSERT INTO support_message (ticket_id, author_kind, author_agent, body, internal)
         VALUES ($1, 'agent', $2, $3, false)
         RETURNING id, author_kind, author_user_id, NULL::text AS author_email, author_agent, body, internal, created_at`,
        [ticketId, actor.agentKey, body.trim()],
      );
      await c.query(
        `UPDATE support_ticket SET status = CASE WHEN status = 'open' THEN 'wacht_op_klant' ELSE status END,
                updated_at = now(), first_response_at = coalesce(first_response_at, now()) WHERE id = $1`,
        [ticketId],
      );
      return m!;
    });
  }
  await ctx.mailer.send({
    to,
    subject: `Re: ${ticket.subject} [Qbicle #${ticket.number}]`,
    text: `${body.trim()}\n\nMet vriendelijke groet,\nQbicle support\n\nReageer op deze mail om verder te gaan met melding #${ticket.number}.`,
  });
  return msg;
}

export async function updateTicket(
  q: Queryable,
  actor: OpsActor,
  ticketId: string,
  changes: { status?: TicketStatus; priority?: TicketPriority; category?: TicketCategory | null; assignee?: string | null },
): Promise<Ticket> {
  if (!UUID.test(ticketId)) throw notFound('Dit ticket');
  if (changes.status && !TICKET_STATUSES.includes(changes.status)) throw new PlatformError('ongeldige_invoer', 'Onbekende status.');
  if (changes.priority && !TICKET_PRIORITIES.includes(changes.priority)) throw new PlatformError('ongeldige_invoer', 'Onbekende prioriteit.');
  if (changes.category && !TICKET_CATEGORIES.includes(changes.category)) throw new PlatformError('ongeldige_invoer', 'Onbekende categorie.');
  if (changes.assignee && changes.assignee.length > 80) throw new PlatformError('ongeldige_invoer', 'Toewijzing te lang.');
  const r = await one<{ organization_id: string | null }>(
    q,
    `UPDATE support_ticket SET
       status = coalesce($2, status),
       priority = coalesce($3, priority),
       category = CASE WHEN $4::boolean THEN $5 ELSE category END,
       assignee = CASE WHEN $6::boolean THEN $7 ELSE assignee END,
       resolved_at = CASE WHEN coalesce($2, status) IN ('opgelost', 'gesloten') THEN coalesce(resolved_at, now()) ELSE NULL END,
       updated_at = now()
     WHERE id = $1 RETURNING organization_id`,
    [ticketId, changes.status ?? null, changes.priority ?? null, 'category' in changes, changes.category ?? null, 'assignee' in changes, changes.assignee ?? null],
  );
  if (!r) throw notFound('Dit ticket');
  await opsAudit(q, actor, { action: 'ops.ticket_gewijzigd', organizationId: r.organization_id, subject: ticketId, detail: changes });
  return (await one<Ticket>(q, `${TICKET_SELECT} WHERE t.id = $1`, [ticketId]))!;
}

/**
 * Alles wat een medewerker of agent nodig heeft om een klant snel te helpen:
 * account, abonnement, leden, domeinen, laatste scans, fouten, mails en gebruik.
 * Bevat geen geheimen (tokens, sleutels) en geen bewijsmateriaal van scans.
 */
export async function ticketContext(ctx: Pick<OpsContext, 'pool' | 'config'>, ticketId: string) {
  const { ticket } = await getTicket(ctx.pool, ticketId);
  const orgId = ticket.organization_id;
  const mails = ticket.requester_email ? await listMails(ctx.pool, { recipient: ticket.requester_email, limit: 10 }) : [];
  if (!orgId) return { ticket, organisatie: null, mails };
  const org = await one<Record<string, unknown>>(
    ctx.pool,
    `SELECT o.id, o.name, o.kind, o.created_at, o.billing_email::text,
            s.plan, s.status AS abonnement_status, s.billing_interval, s.trial_ends_at, s.current_period_end,
            s.cancel_at_period_end
       FROM organization o
       LEFT JOIN subscription s ON s.organization_id = o.id AND s.status IN ('proef', 'actief', 'achterstallig', 'opgezegd')
      WHERE o.id = $1`,
    [orgId],
  );
  const leden = await many<{ email: string; role: string; last_login_at: Date | null }>(
    ctx.pool,
    `SELECT u.email::text, m.role, u.last_login_at FROM membership m JOIN app_user u ON u.id = m.user_id
      WHERE m.organization_id = $1 ORDER BY m.role, u.email`,
    [orgId],
  );
  const domeinen = await many<{ name: string; verified_at: Date | null }>(
    ctx.pool,
    'SELECT name, verified_at FROM domain WHERE organization_id = $1 ORDER BY name',
    [orgId],
  );
  const bevindingen = await one<{ n: string }>(
    ctx.pool,
    `SELECT count(*) AS n FROM finding f JOIN asset a ON a.id = f.asset_id
      WHERE a.organization_id = $1 AND f.resolved_at IS NULL`,
    [orgId],
  );
  const betalingen = await many<{ description: string; status: string; amount_incl_cents: number; created_at: Date }>(
    ctx.pool,
    `SELECT description, status, amount_incl_cents, created_at FROM payment
      WHERE organization_id = $1 ORDER BY created_at DESC LIMIT 5`,
    [orgId],
  );
  const andereTickets = await many<{ id: string; number: number; subject: string; status: string; created_at: Date }>(
    ctx.pool,
    `SELECT id, number, subject, status, created_at FROM support_ticket
      WHERE organization_id = $1 AND id <> $2 ORDER BY created_at DESC LIMIT 5`,
    [orgId, ticketId],
  );
  const { plan } = await effectiveLimits(ctx, orgId);
  return {
    ticket,
    organisatie: { ...org, limietPakket: plan },
    leden,
    domeinen,
    laatsteScans: await listScanJobs(ctx, 'alle', { organizationId: orgId, limit: 5 }),
    openBevindingen: Number(bevindingen?.n ?? 0),
    fouten: await listErrors(ctx.pool, { open: true, organizationId: orgId, limit: 10 }),
    mails,
    gebruik: await limitStatus(ctx, orgId),
    betalingen,
    andereTickets,
  };
}
