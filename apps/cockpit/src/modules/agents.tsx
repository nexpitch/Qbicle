/** @jsxImportSource hono/jsx */
import {
  agentOverview,
  BEWAKER,
  canApprove,
  decideProposal,
  executeProposal,
  getProposal,
  getProposalKind,
  listOpsActivity,
  listProposalKinds,
  listProposals,
  runBewaker,
  setAgentEnabled,
  type Impact,
  type Proposal,
  type ProposalStatus,
} from '@qbicle/ops';
import { notFound, PlatformError } from '@qbicle/platform';
import { z } from 'zod';
import { opsActor, opsContext } from '../core/ops.ts';
import { can, STAFF_ROLE_LABEL } from '../core/roles.ts';
import { datumTijd, Empty, euro, FormError, Kpi, Status, type StatusKind } from '../layout.tsx';
import type { CockpitModule } from '../module.ts';

const uuid = z.uuid();
const IMPACT: Record<Impact, [string, StatusKind]> = {
  financieel: ['Financieel', 'crit'],
  klant: ['Klant', 'warn'],
  geen: ['Intern', 'unk'],
};
const STATUS: Record<ProposalStatus, [string, StatusKind]> = {
  voorgesteld: ['Wacht op jou', 'warn'],
  goedgekeurd: ['Goedgekeurd', 'info'],
  bezig: ['Wordt uitgevoerd', 'info'],
  uitgevoerd: ['Uitgevoerd', 'ok'],
  mislukt: ['Mislukt', 'crit'],
  afgewezen: ['Afgewezen', 'unk'],
  verlopen: ['Verlopen', 'unk'],
  ingetrokken: ['Ingetrokken', 'unk'],
};
const ACTIE: Record<string, string> = {
  'ops.voorstel_gedaan': 'Deed een voorstel',
  'ops.voorstel_automatisch_goedgekeurd': 'Voerde een interne actie automatisch uit',
  'ops.voorstel_goedgekeurd': 'Voorstel goedgekeurd',
  'ops.voorstel_afgewezen': 'Voorstel afgewezen',
  'ops.voorstel_uitgevoerd': 'Voorstel uitgevoerd',
  'ops.voorstel_mislukt': 'Voorstel mislukt',
  'ops.voorstel_ingetrokken': 'Voorstel ingetrokken',
  'ops.agent_gepauzeerd': 'Agent gepauzeerd',
  'ops.agent_hervat': 'Agent hervat',
  'ops.ticket_aangemaakt': 'Ticket aangemaakt',
  'ops.ticket_notitie': 'Interne notitie bij ticket',
  'ops.ticket_antwoord': 'Antwoord aan klant',
  'ops.ticket_gewijzigd': 'Ticket gewijzigd',
  'ops.scan_opnieuw': 'Scan opnieuw in wachtrij',
  'ops.fout_opgelost': 'Fout opgelost',
  'ops.limiet_gewijzigd': 'Limiet gewijzigd',
};

const schemas = {
  besluit: z.object({ besluit: z.enum(['goedkeuren', 'afwijzen']), toelichting: z.string().trim().max(1000).optional() }),
  pauze: z.object({ reden: z.string().trim().max(400).optional() }),
};

function proposalId(v: string | undefined): string {
  if (!v || !uuid.safeParse(v).success) throw notFound('Dit voorstel');
  return v;
}

const VELD: Record<string, string> = { body: 'Bericht', subject: 'Onderwerp', reason: 'Reden', metric: 'Limiet', limit: 'Nieuwe waarde' };

/** Wat het voorstel doet, leesbaar: tekstvelden voluit, de rest als JSON. */
function PayloadView(props: { p: Proposal }) {
  const entries = Object.entries(props.p.payload);
  const long = entries.filter(([, v]) => typeof v === 'string' && v.length > 80);
  const rest = Object.fromEntries(entries.filter(([, v]) => !(typeof v === 'string' && v.length > 80)));
  return (
    <>
      {long.map(([k, v]) => (
        <div class="msg">
          <div class="msg-head">
            <b>{VELD[k] ?? k}</b>
          </div>
          <div class="msg-body">{String(v)}</div>
        </div>
      ))}
      {Object.keys(rest).length ? <pre class="payload">{JSON.stringify(rest, null, 2)}</pre> : null}
    </>
  );
}

function ProposalCard(props: { p: Proposal; mayDecide: boolean }) {
  const { p } = props;
  const kind = getProposalKind(p.kind);
  const approvers = kind ? ['beheerder', ...kind.approvers.filter((r) => r !== 'beheerder')].map((r) => STAFF_ROLE_LABEL[r as 'beheerder']).join(' of ') : '';
  return (
    <article class={`proposal imp-${p.impact}`}>
      <div class="proposal-head">
        <h2>{p.title}</h2>
        <div class="row">
          <Status kind={IMPACT[p.impact][1]}>{IMPACT[p.impact][0]}</Status>
          <Status kind={STATUS[p.status][1]}>{STATUS[p.status][0]}</Status>
        </div>
      </div>
      <dl class="kv">
        <dt>Agent</dt>
        <dd>{p.agent_name ?? p.agent_key}</dd>
        <dt>Actie</dt>
        <dd>{kind?.label ?? p.kind}</dd>
        {p.organization_id ? (
          <>
            <dt>Bedrijf</dt>
            <dd>
              <a href={`/gebruik/${p.organization_id}`}>{p.organization_name}</a>
            </dd>
          </>
        ) : null}
        {p.amount_cents !== null ? (
          <>
            <dt>Bedrag</dt>
            <dd>{euro(Number(p.amount_cents))}</dd>
          </>
        ) : null}
        <dt>Waarom</dt>
        <dd>{p.rationale}</dd>
        <dt>Voorgesteld</dt>
        <dd>
          {datumTijd(p.created_at)}
          {p.status === 'voorgesteld' ? ` · verloopt ${datumTijd(p.expires_at)}` : ''}
        </dd>
        {p.decided_at ? (
          <>
            <dt>Besluit</dt>
            <dd>
              {p.decided_via === 'automatisch' ? 'Automatisch (interne actie zonder gevolgen voor klant of geld)' : `${p.decided_by_email ?? 'Medewerker'}, ${datumTijd(p.decided_at)}`}
              {p.decision_note ? ` · "${p.decision_note}"` : ''}
            </dd>
          </>
        ) : null}
        {p.result ? (
          <>
            <dt>Uitkomst</dt>
            <dd>
              <code>{JSON.stringify(p.result)}</code>
            </dd>
          </>
        ) : null}
      </dl>
      <PayloadView p={p} />
      {p.status === 'voorgesteld' ? (
        props.mayDecide ? (
          <form class="stack" data-api={`/api/agents/voorstellen/${p.id}`}>
            <FormError />
            <label>
              Toelichting (optioneel)
              <input type="text" name="toelichting" maxlength={1000} />
            </label>
            <div class="row">
              <button class="btn" type="submit" name="besluit" value="goedkeuren">
                Goedkeuren en uitvoeren
              </button>
              <button class="btn danger" type="submit" name="besluit" value="afwijzen">
                Afwijzen
              </button>
            </div>
          </form>
        ) : (
          <p class="small">Alleen {approvers} kan dit goedkeuren.</p>
        )
      ) : p.status === 'goedgekeurd' && props.mayDecide ? (
        <form data-api={`/api/agents/voorstellen/${p.id}/uitvoeren`}>
          <FormError />
          <button class="btn" type="submit">
            Nu uitvoeren
          </button>
        </form>
      ) : null}
    </article>
  );
}

export const agents: CockpitModule = {
  key: 'agents',
  nav: [{ key: 'agents', label: 'Agents', href: '/agents', icon: 'agent', group: 'techniek', order: 40 }],
  register({ pages, api }, ctx) {
    const ops = () => opsContext(ctx.cockpit);

    pages.get('/agents', async (c) => {
      const tab = c.req.query('tab') ?? 'wachtrij';
      const role = c.get('staff').role;
      const beheer = can(role, 'agents.beheren');
      const [overview, open] = await Promise.all([agentOverview(ops().pool), listProposals(ops().pool, { status: 'open', limit: 100 })]);
      let body;
      if (tab === 'agents') {
        body = (
          <>
            <section class="card">
              <div class="card-head">
                <h2>Agents</h2>
                <span class="small">Agents lezen en doen voorstellen. Alleen interne acties zonder gevolgen voor klanten of geld gaan automatisch.</span>
              </div>
              {overview.length === 0 ? (
                <Empty title="Nog geen agents actief">Start de Bewaker hieronder of met docker compose run --rm bewaker.</Empty>
              ) : (
                <div class="table-wrap">
                  <table class="table">
                    <thead>
                      <tr>
                        <th>Agent</th>
                        <th>Status</th>
                        <th>Laatste ronde</th>
                        <th class="num">Open</th>
                        <th class="num">Goedgekeurd</th>
                        <th class="num">Afgewezen</th>
                        <th class="num">Automatisch</th>
                        <th class="num">Mislukt</th>
                        {beheer ? <th class="num"></th> : null}
                      </tr>
                    </thead>
                    <tbody>
                      {overview.map((a) => (
                        <tr class={a.enabled ? undefined : 'dim'}>
                          <td>
                            <b>{a.name}</b>
                            <span class="sub">{a.description}</span>
                          </td>
                          <td>
                            {a.enabled ? <Status kind="ok">Actief</Status> : <Status kind="unk">Gepauzeerd</Status>}
                            {a.paused_reason ? <span class="sub">{a.paused_reason}</span> : null}
                          </td>
                          <td>
                            {a.last_run_at ? datumTijd(a.last_run_at) : '—'}
                            {a.last_run_summary ? <span class="sub">{a.last_run_summary}</span> : null}
                            {a.failed_runs_24h ? <Status kind="crit">{`${a.failed_runs_24h} mislukt`}</Status> : null}
                          </td>
                          <td class="num">{a.open_proposals}</td>
                          <td class="num">{a.approved_30d}</td>
                          <td class="num">{a.rejected_30d}</td>
                          <td class="num">{a.auto_30d}</td>
                          <td class="num">{a.failed_30d}</td>
                          {beheer ? (
                            <td class="num">
                              <form
                                data-api={`/api/agents/${a.key}/${a.enabled ? 'pauzeren' : 'hervatten'}`}
                                data-bevestig={a.enabled ? `${a.name} pauzeren? De agent doet dan geen voorstellen meer.` : undefined}
                              >
                                <button class={a.enabled ? 'btn danger sm' : 'btn secondary sm'} type="submit">
                                  {a.enabled ? 'Pauzeren' : 'Hervatten'}
                                </button>
                                <FormError />
                              </form>
                            </td>
                          ) : null}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p class="small">Goedkeuringspercentage laag? Dan doet een agent te veel onnodige voorstellen: pas zijn regels aan of pauzeer hem.</p>
              {beheer ? (
                <form data-api="/api/agents/bewaker/ronde">
                  <FormError />
                  <button class="btn secondary sm" type="submit">
                    Bewaker nu een ronde laten draaien
                  </button>
                </form>
              ) : null}
            </section>
            <section class="card">
              <h2>Wat agents mogen voorstellen</h2>
              <div class="table-wrap">
                <table class="table">
                  <thead>
                    <tr>
                      <th>Actie</th>
                      <th>Impact</th>
                      <th>Wie keurt goed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {listProposalKinds().map((k) => (
                      <tr>
                        <td>
                          {k.label}
                          <span class="sub">{k.kind}</span>
                        </td>
                        <td>
                          <Status kind={IMPACT[k.impact][1]}>{IMPACT[k.impact][0]}</Status>
                        </td>
                        <td>{k.autoApprove ? 'Automatisch' : ['Beheerder', ...k.approvers.filter((r) => r !== 'beheerder').map((r) => STAFF_ROLE_LABEL[r])].join(', ')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        );
      } else if (tab === 'geschiedenis') {
        const all = (await listProposals(ops().pool, { limit: 100 })).filter((p) => p.status !== 'voorgesteld');
        body = all.length === 0 ? <Empty title="Nog geen afgehandelde voorstellen" /> : <div class="stack">{all.map((p) => <ProposalCard p={p} mayDecide={false} />)}</div>;
      } else if (tab === 'activiteit') {
        const rows = await listOpsActivity(ops().pool, { agentsOnly: c.req.query('alles') !== '1', limit: 100 });
        body = (
          <section class="card">
            <div class="card-head">
              <h2>{c.req.query('alles') === '1' ? 'Alle activiteit in techniek en support' : 'Wat agents deden'}</h2>
              <a class="small" href={c.req.query('alles') === '1' ? '/agents?tab=activiteit' : '/agents?tab=activiteit&alles=1'}>
                {c.req.query('alles') === '1' ? 'Alleen agents' : 'Ook medewerkers'}
              </a>
            </div>
            {rows.length === 0 ? (
              <Empty title="Nog geen activiteit" />
            ) : (
              <ul class="feed">
                {rows.map((r) => (
                  <li>
                    <b>
                      {ACTIE[r.action] ?? r.action}
                      {typeof r.detail?.titel === 'string' ? `: ${r.detail.titel}` : ''}
                    </b>
                    <span>
                      {r.actor.startsWith('agent:') ? `Agent ${r.actor.slice(6)}` : r.actor === 'systeem' ? 'Systeem' : 'Medewerker'} · {datumTijd(r.at)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      } else {
        const fin = open.filter((p) => p.impact === 'financieel').length;
        body = (
          <>
            <section class="kpis">
              <Kpi label="Wachten op besluit" value={String(open.length)} sub={fin ? `${fin} financieel` : 'geen financiële'} tone={open.length ? 'warn' : 'ok'} />
              <Kpi label="Actieve agents" value={String(overview.filter((a) => a.enabled).length)} sub={`${overview.filter((a) => !a.enabled).length} gepauzeerd`} href="/agents?tab=agents" />
              <Kpi label="Automatisch afgehandeld (30 d)" value={String(overview.reduce((s, a) => s + a.auto_30d, 0))} sub="interne acties" href="/agents?tab=geschiedenis" />
              <Kpi
                label="Mislukt (30 d)"
                value={String(overview.reduce((s, a) => s + a.failed_30d, 0))}
                tone={overview.some((a) => a.failed_30d) ? 'crit' : 'ok'}
                href="/agents?tab=geschiedenis"
              />
            </section>
            {open.length === 0 ? (
              <Empty title="Geen voorstellen die op je wachten">Agents leggen hier acties neer die een klant of geld raken. Jij keurt goed of wijst af.</Empty>
            ) : (
              <div class="stack">
                {open.map((p) => {
                  const k = getProposalKind(p.kind);
                  return <ProposalCard p={p} mayDecide={!!k && canApprove(role, k)} />;
                })}
              </div>
            )}
          </>
        );
      }
      return ctx.page(c, {
        title: 'Agents',
        active: 'agents',
        eyebrow: 'Techniek en support',
        tabs: [
          [`Wachtrij (${open.length})`, '/agents', tab === 'wachtrij'],
          ['Agents', '/agents?tab=agents', tab === 'agents'],
          ['Geschiedenis', '/agents?tab=geschiedenis', tab === 'geschiedenis'],
          ['Activiteit', '/agents?tab=activiteit', tab === 'activiteit'],
        ],
        children: body,
      });
    });

    // Goedkeuren (en direct uitvoeren) of afwijzen. Rechten per soort voorstel staan in packages/ops.
    api.post('/agents/voorstellen/:id', async (c) => {
      ctx.require(c, 'cockpit.lezen');
      const id = proposalId(c.req.param('id'));
      const b = await ctx.body(c, schemas.besluit);
      const p = await decideProposal(ops(), opsActor(c), id, { approve: b.besluit === 'goedkeuren', note: b.toelichting, execute: true });
      if (p.status === 'mislukt') throw new PlatformError('conflict', `Goedgekeurd, maar uitvoeren mislukte: ${String(p.result?.fout ?? 'onbekende fout')}`);
      return c.json({ status: p.status });
    });

    api.post('/agents/voorstellen/:id/uitvoeren', async (c) => {
      const id = proposalId(c.req.param('id'));
      const p = await getProposal(ops().pool, id);
      if (!p) throw notFound('Dit voorstel');
      const k = getProposalKind(p.kind);
      if (!k || !canApprove(c.get('staff').role, k)) throw new PlatformError('geen_toegang', 'Je rol mag dit voorstel niet uitvoeren.');
      const done = await executeProposal(ops(), opsActor(c), id);
      return c.json({ status: done.status });
    });

    api.post('/agents/:key/pauzeren', async (c) => {
      ctx.require(c, 'agents.beheren');
      const b = await ctx.body(c, schemas.pauze);
      await setAgentEnabled(ops().pool, opsActor(c), c.req.param('key'), false, b.reden || 'Gepauzeerd in de cockpit');
      return c.json({ ok: true });
    });

    api.post('/agents/:key/hervatten', async (c) => {
      ctx.require(c, 'agents.beheren');
      await setAgentEnabled(ops().pool, opsActor(c), c.req.param('key'), true);
      return c.json({ ok: true });
    });

    api.post('/agents/bewaker/ronde', async (c) => {
      ctx.require(c, 'agents.beheren');
      const r = await runBewaker(ops());
      return c.json({ agent: BEWAKER.key, ...r });
    });
  },
};
