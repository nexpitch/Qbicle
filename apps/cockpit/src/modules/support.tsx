/** @jsxImportSource hono/jsx */
import {
  addTicketMessage,
  createTicket,
  getTicket,
  listProposals,
  listTickets,
  replyToCustomer,
  ticketContext,
  TICKET_CATEGORIES,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  updateTicket,
  type TicketPriority,
  type TicketStatus,
} from '@qbicle/ops';
import { notFound } from '@qbicle/platform';
import { z } from 'zod';
import { opsActor, opsContext } from '../core/ops.ts';
import { can } from '../core/roles.ts';
import { datum, datumTijd, Empty, euro, FormError, Status, type StatusKind } from '../layout.tsx';
import type { CockpitModule } from '../module.ts';
import { LIMIT_LABEL } from './gebruik.tsx';

const uuid = z.uuid();
export const TICKET_STATUS: Record<TicketStatus, [string, StatusKind]> = {
  open: ['Open', 'info'],
  wacht_op_klant: ['Wacht op klant', 'unk'],
  opgelost: ['Opgelost', 'ok'],
  gesloten: ['Gesloten', 'unk'],
};
const PRIO: Record<TicketPriority, StatusKind> = { laag: 'unk', normaal: 'info', hoog: 'warn', urgent: 'crit' };

const schemas = {
  nieuw: z.object({
    email: z.email().max(254),
    onderwerp: z.string().trim().min(1).max(200),
    bericht: z.string().trim().min(1).max(20000),
    prioriteit: z.enum(TICKET_PRIORITIES).default('normaal'),
    categorie: z.enum(TICKET_CATEGORIES).optional(),
    kanaal: z.enum(['mail', 'telefoon']).default('mail'),
  }),
  bericht: z.object({ bericht: z.string().trim().min(1).max(20000), soort: z.enum(['antwoord', 'notitie']) }),
  wijzig: z.object({
    status: z.enum(TICKET_STATUSES).optional(),
    prioriteit: z.enum(TICKET_PRIORITIES).optional(),
    toewijzen: z.enum(['mij', 'niemand', 'ongewijzigd']).default('ongewijzigd'),
  }),
};

function ticketId(v: string | undefined): string {
  if (!v || !uuid.safeParse(v).success) throw notFound('Dit ticket');
  return v;
}

export const support: CockpitModule = {
  key: 'support',
  nav: [{ key: 'support', label: 'Support', href: '/support', icon: 'support', group: 'techniek', order: 30 }],
  register({ pages, api }, ctx) {
    const ops = () => opsContext(ctx.cockpit);

    pages.get('/support', async (c) => {
      const status = (c.req.query('status') ?? 'actief') as TicketStatus | 'actief' | 'alle';
      const zoek = c.req.query('zoek') ?? '';
      const mine = c.req.query('mijn') === '1';
      const tickets = await listTickets(ops().pool, {
        status: status === 'alle' ? undefined : status,
        search: zoek,
        assignee: mine ? `gebruiker:${c.get('staff').user.id}` : undefined,
        limit: 100,
      });
      const mag = can(c.get('staff').role, 'support.beheren');
      const tab = (key: string, label: string): [string, string, boolean] => [label, `/support?status=${key}`, status === key && !mine];
      return ctx.page(c, {
        title: 'Support',
        active: 'support',
        eyebrow: 'Techniek en support',
        tabs: [
          tab('actief', 'Actief'),
          tab('open', 'Open'),
          tab('wacht_op_klant', 'Wacht op klant'),
          tab('opgelost', 'Opgelost'),
          tab('alle', 'Alles'),
          ['Aan mij', '/support?status=actief&mijn=1', mine],
        ],
        children: (
          <>
            <section class="card">
              <form class="filter" method="get" action="/support">
                <input type="hidden" name="status" value={status} />
                <input type="search" name="zoek" value={zoek} placeholder="Zoek op onderwerp, e-mail, bedrijf of nummer" aria-label="Zoek tickets" />
                <button class="btn secondary sm" type="submit">
                  Zoeken
                </button>
              </form>
              {tickets.length === 0 ? (
                <Empty title="Geen tickets">Vragen van klanten en meldingen van agents verschijnen hier.</Empty>
              ) : (
                <div class="table-wrap">
                  <table class="table">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>Onderwerp</th>
                        <th>Bedrijf</th>
                        <th>Status</th>
                        <th>Prioriteit</th>
                        <th>Bron</th>
                        <th class="num">Bijgewerkt</th>
                      </tr>
                    </thead>
                    <tbody>
                      {tickets.map((t) => (
                        <tr>
                          <td class="nowrap">{t.number}</td>
                          <td>
                            <a href={`/support/${t.id}`}>{t.subject}</a>
                            <span class="sub">{t.requester_email ?? (t.channel === 'agent' ? 'Interne melding van een agent' : '')}</span>
                          </td>
                          <td>{t.organization_name ?? <span class="muted">onbekend</span>}</td>
                          <td>
                            <Status kind={TICKET_STATUS[t.status][1]}>{TICKET_STATUS[t.status][0]}</Status>
                          </td>
                          <td>
                            <Status kind={PRIO[t.priority]}>{t.priority}</Status>
                          </td>
                          <td>{t.channel}</td>
                          <td class="num">{datumTijd(t.updated_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {mag ? (
              <section class="card narrow">
                <h2>Ticket aanmaken</h2>
                <p class="small">Voor een vraag die per mail of telefoon binnenkwam. Qbicle koppelt het ticket via het e-mailadres aan het bedrijf.</p>
                <form class="stack" data-api="/api/support" data-next="/support/{ticket}">
                  <FormError />
                  <label>
                    E-mailadres van de klant
                    <input type="email" name="email" required />
                  </label>
                  <label>
                    Onderwerp
                    <input type="text" name="onderwerp" required maxlength={200} />
                  </label>
                  <label>
                    Vraag van de klant
                    <textarea name="bericht" required></textarea>
                  </label>
                  <div class="row">
                    <label>
                      Prioriteit
                      <select name="prioriteit">
                        {TICKET_PRIORITIES.map((p) => (
                          <option value={p} selected={p === 'normaal'}>
                            {p}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Kanaal
                      <select name="kanaal">
                        <option value="mail">mail</option>
                        <option value="telefoon">telefoon</option>
                      </select>
                    </label>
                  </div>
                  <div>
                    <button class="btn" type="submit">
                      Aanmaken
                    </button>
                  </div>
                </form>
              </section>
            ) : null}
          </>
        ),
      });
    });

    pages.get('/support/:id', async (c) => {
      const id = ticketId(c.req.param('id'));
      const { ticket, messages } = await getTicket(ops().pool, id);
      const cx = await ticketContext(ops(), id);
      const voorstellen = await listProposals(ops().pool, { kind: 'ticket.antwoord', limit: 200 }).then((r) => r.filter((p) => p.payload.ticketId === id));
      const mag = can(c.get('staff').role, 'support.beheren');
      const org = cx.organisatie as Record<string, unknown> | null;
      return ctx.page(c, {
        title: ticket.subject,
        active: 'support',
        eyebrow: `Ticket #${ticket.number} · ${ticket.channel} · ${datum(ticket.created_at)}`,
        actions: (
          <>
            <Status kind={TICKET_STATUS[ticket.status][1]}>{TICKET_STATUS[ticket.status][0]}</Status>
            <Status kind={PRIO[ticket.priority]}>{ticket.priority}</Status>
          </>
        ),
        children: (
          <div class="cols">
            <div class="stack">
              <section class="card">
                <ul class="thread">
                  {messages.map((m) => (
                    <li class={`msg ${m.internal ? 'intern' : ''} ${m.author_kind === 'klant' ? 'van-klant' : ''}`}>
                      <div class="msg-head">
                        <b>
                          {m.author_kind === 'klant'
                            ? (m.author_email ?? ticket.requester_email ?? 'Klant')
                            : m.author_kind === 'agent'
                              ? `Agent ${m.author_agent}`
                              : m.author_kind === 'systeem'
                                ? 'Systeem'
                                : (m.author_email ?? 'Medewerker')}
                        </b>
                        <span>
                          {m.internal ? 'Interne notitie · ' : ''}
                          {datumTijd(m.created_at)}
                        </span>
                      </div>
                      <div class="msg-body">{m.body}</div>
                    </li>
                  ))}
                </ul>
              </section>

              {voorstellen.length ? (
                <section class="card">
                  <h2>Antwoordvoorstellen van agents</h2>
                  <ul class="feed">
                    {voorstellen.map((p) => (
                      <li>
                        <b>
                          {p.title} <Status kind={p.status === 'voorgesteld' ? 'warn' : p.status === 'uitgevoerd' ? 'ok' : 'unk'}>{p.status}</Status>
                        </b>
                        <span>
                          {p.status === 'voorgesteld' ? <a href="/agents">Beoordelen in de wachtrij</a> : datumTijd(p.decided_at)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}

              {mag ? (
                <section class="card">
                  <h2>Reageren</h2>
                  <form class="stack" data-api={`/api/support/${id}/bericht`}>
                    <FormError />
                    <label>
                      Bericht
                      <textarea name="bericht" required></textarea>
                    </label>
                    <div class="row">
                      <button class="btn" type="submit" name="soort" value="antwoord" disabled={!ticket.requester_email}>
                        Antwoord mailen naar klant
                      </button>
                      <button class="btn secondary" type="submit" name="soort" value="notitie">
                        Interne notitie
                      </button>
                    </div>
                    {!ticket.requester_email ? <p class="small">Dit ticket heeft geen e-mailadres; alleen interne notities.</p> : null}
                  </form>
                </section>
              ) : null}
            </div>

            <div class="stack">
              {mag ? (
                <section class="card">
                  <h2>Afhandeling</h2>
                  <form class="stack" data-api={`/api/support/${id}`}>
                    <FormError />
                    <label>
                      Status
                      <select name="status">
                        {TICKET_STATUSES.map((s) => (
                          <option value={s} selected={s === ticket.status}>
                            {TICKET_STATUS[s][0]}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Prioriteit
                      <select name="prioriteit">
                        {TICKET_PRIORITIES.map((p) => (
                          <option value={p} selected={p === ticket.priority}>
                            {p}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Toegewezen aan
                      <select name="toewijzen">
                        <option value="ongewijzigd">{ticket.assignee ? (ticket.assignee === `gebruiker:${c.get('staff').user.id}` ? 'Mij' : ticket.assignee) : 'Niemand'}</option>
                        <option value="mij">Mij</option>
                        <option value="niemand">Niemand</option>
                      </select>
                    </label>
                    <div>
                      <button class="btn secondary" type="submit">
                        Opslaan
                      </button>
                    </div>
                  </form>
                </section>
              ) : null}

              <section class="card">
                <h2>Klant</h2>
                {!org ? (
                  <Empty title="Niet gekoppeld aan een bedrijf">{ticket.requester_email ? `Geen bedrijf gevonden voor ${ticket.requester_email}.` : ''}</Empty>
                ) : (
                  <dl class="kv">
                    <dt>Bedrijf</dt>
                    <dd>
                      <a href={`/klanten/${String(org.id)}`}>{String(org.name)}</a>
                    </dd>
                    <dt>Pakket</dt>
                    <dd>
                      {String(org.plan ?? 'geen')} {org.abonnement_status ? <span class="tag">{String(org.abonnement_status)}</span> : null}
                    </dd>
                    <dt>Klant sinds</dt>
                    <dd>{datum(org.created_at as Date)}</dd>
                    <dt>Leden</dt>
                    <dd>{(cx.leden ?? []).map((l) => `${l.email} (${l.role})`).join(', ') || 'geen'}</dd>
                    <dt>Domeinen</dt>
                    <dd>{(cx.domeinen ?? []).map((d) => `${d.name}${d.verified_at ? '' : ' (niet geverifieerd)'}`).join(', ') || 'geen'}</dd>
                    <dt>Open bevindingen</dt>
                    <dd>{cx.openBevindingen ?? 0}</dd>
                  </dl>
                )}
              </section>

              {org ? (
                <section class="card">
                  <h2>Laatste scans</h2>
                  {(cx.laatsteScans ?? []).length === 0 ? (
                    <Empty title="Nog geen scans" />
                  ) : (
                    <ul class="feed">
                      {cx.laatsteScans!.map((s) => (
                        <li>
                          <b>
                            {s.domain} <Status kind={s.stuck ? 'warn' : s.status === 'mislukt' ? 'crit' : s.status === 'klaar' ? 'ok' : 'info'}>{s.stuck ? 'vast' : s.status}</Status>
                          </b>
                          <span>
                            {datumTijd(s.created_at)}
                            {s.error ? ` · ${s.error}` : ''}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              ) : null}

              {org && (cx.fouten ?? []).length ? (
                <section class="card">
                  <h2>Open fouten</h2>
                  <ul class="feed">
                    {cx.fouten!.map((e) => (
                      <li>
                        <b>{e.message}</b>
                        <span>
                          {e.source} · {e.occurrences}x · {datumTijd(e.last_seen)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}

              {org ? (
                <section class="card">
                  <h2>Gebruik en betalingen</h2>
                  <ul class="feed">
                    {(cx.gebruik ?? []).map((g) => (
                      <li>
                        <b>
                          {LIMIT_LABEL[g.metric]}{' '}
                          {g.status !== 'ok' ? <Status kind={g.status === 'over' ? 'crit' : 'warn'}>{g.status === 'over' ? 'over limiet' : 'bijna'}</Status> : null}
                        </b>
                        <span>{g.limit === null ? `${g.used} (onbeperkt)` : `${g.pct}% van de limiet`}</span>
                      </li>
                    ))}
                    {(cx.betalingen ?? []).map((b) => (
                      <li>
                        <b>
                          {b.description} <Status kind={b.status === 'betaald' ? 'ok' : b.status === 'mislukt' ? 'crit' : 'unk'}>{b.status}</Status>
                        </b>
                        <span>
                          {euro(b.amount_incl_cents)} · {datum(b.created_at)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}

              {cx.mails.length ? (
                <section class="card">
                  <h2>Mails aan deze klant</h2>
                  <ul class="feed">
                    {cx.mails.map((m) => (
                      <li>
                        <b>
                          {m.subject} <Status kind={['gebounced', 'geblokkeerd', 'spam', 'mislukt'].includes(m.status) ? 'crit' : 'unk'}>{m.status}</Status>
                        </b>
                        <span>{datumTijd(m.created_at)}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
            </div>
          </div>
        ),
      });
    });

    api.post('/support', async (c) => {
      ctx.require(c, 'support.beheren');
      const b = await ctx.body(c, schemas.nieuw);
      const t = await createTicket(ops().pool, opsActor(c), {
        requesterEmail: b.email,
        subject: b.onderwerp,
        body: b.bericht,
        priority: b.prioriteit,
        category: b.categorie ?? null,
        channel: b.kanaal,
      });
      return c.json({ ticket: t.id }, 201);
    });

    api.post('/support/:id/bericht', async (c) => {
      ctx.require(c, 'support.beheren');
      const id = ticketId(c.req.param('id'));
      const b = await ctx.body(c, schemas.bericht);
      if (b.soort === 'antwoord') await replyToCustomer(ops(), opsActor(c), id, b.bericht);
      else await addTicketMessage(ops().pool, opsActor(c), id, { body: b.bericht, internal: true });
      return c.json({ ok: true });
    });

    api.post('/support/:id', async (c) => {
      ctx.require(c, 'support.beheren');
      const id = ticketId(c.req.param('id'));
      const b = await ctx.body(c, schemas.wijzig);
      const actor = opsActor(c);
      await updateTicket(ops().pool, actor, id, {
        ...(b.status ? { status: b.status } : {}),
        ...(b.prioriteit ? { priority: b.prioriteit } : {}),
        ...(b.toewijzen === 'mij' ? { assignee: `gebruiker:${actor.userId}` } : b.toewijzen === 'niemand' ? { assignee: null } : {}),
      });
      return c.json({ ok: true });
    });
  },
};
