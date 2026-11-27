/** @jsxImportSource hono/jsx */
import { isNepProvider } from '@qbicle/platform';
import { z } from 'zod';
import {
  adjustItem,
  cancelRun,
  excludeItem,
  FAILURE_LABEL,
  FAILURE_REASONS,
  getRun,
  includeItem,
  listItems,
  listRuns,
  prepareRun,
  reopenRun,
  settleTestItem,
  submitRun,
  validateRun,
  type ItemStatus,
  type RunStatus,
} from '../core/collections.ts';
import {
  ACTION_LABEL,
  countOpenFollowups,
  executeFollowup,
  FOLLOWUP_ACTIONS,
  listFollowups,
  mailDraft,
  rejectFollowup,
  settleTestFollowupPayment,
  type FollowupAction,
  type FollowupRow,
} from '../core/followups.ts';
import { can } from '../core/roles.ts';
import { datum, datumTijd, Empty, euro, FormError, Kpi, Status, type StatusKind } from '../layout.tsx';
import type { CockpitModule } from '../module.ts';
import { idParam } from './klanten.tsx';

export const RUN_STATUS: Record<RunStatus, [string, StatusKind]> = {
  concept: ['Concept', 'info'],
  gevalideerd: ['Gevalideerd', 'warn'],
  ingediend: ['Ingediend', 'info'],
  afgerond: ['Afgerond', 'ok'],
  geannuleerd: ['Geannuleerd', 'unk'],
};
const ITEM_STATUS: Record<ItemStatus, [string, StatusKind]> = {
  klaar: ['Klaar', 'info'],
  uitgesloten: ['Uitgesloten', 'unk'],
  ingediend: ['Ingediend', 'warn'],
  betaald: ['Betaald', 'ok'],
  mislukt: ['Mislukt', 'crit'],
};

function defaultDate(): string {
  const d = new Date(Date.now() + 5 * 86_400_000);
  return d.toISOString().slice(0, 10);
}

async function tabs(p: { pool: import('@qbicle/platform').Queryable }, active: 'batches' | 'mislukt'): Promise<Array<[string, string, boolean]>> {
  const n = await countOpenFollowups(p.pool);
  return [
    ['Batches', '/incasso', active === 'batches'],
    [n ? `Mislukt · ${n} te doen` : 'Mislukt', '/incasso/mislukt', active === 'mislukt'],
  ];
}

function periode(a: Date, b: Date): string {
  const end = new Date(new Date(b).getTime() - 86_400_000);
  return `${datum(a)} t/m ${datum(end)}`;
}

export const incasso: CockpitModule = {
  key: 'incasso',
  nav: [{ key: 'incasso', label: "Incasso's", href: '/incasso', icon: 'incasso', group: 'financien', order: 20 }],
  register({ pages, api }, ctx) {
    const p = ctx.cockpit.p;

    pages.get('/incasso', async (c) => {
      const runs = await listRuns(p.pool);
      const mag = can(c.get('staff').role, 'facturatie.beheren');
      const open = runs.filter((r) => r.status === 'concept' || r.status === 'gevalideerd');
      const lopend = runs.filter((r) => r.status === 'ingediend');
      const failed30 = await p.pool.query(
        `SELECT count(*)::int AS n FROM collection_item WHERE status = 'mislukt' AND result_at > now() - interval '30 days'`,
      );
      const vervolg = await countOpenFollowups(p.pool);
      return ctx.page(c, {
        title: "Incasso's",
        active: 'incasso',
        eyebrow: 'Financiën',
        tabs: await tabs(p, 'batches'),
        children: (
          <>
            <section class="kpis">
              <Kpi label="Wacht op jouw controle" value={String(open.length)} sub={open.length ? 'batch(es) klaargezet' : 'niets te doen'} tone={open.length ? 'warn' : 'ok'} />
              <Kpi label="Ingediend, wacht op bank" value={String(lopend.length)} />
              <Kpi
                label="Mislukt (30 dagen)"
                value={String(failed30.rows[0].n)}
                sub={vervolg ? `${vervolg} vervolgactie${vervolg === 1 ? '' : 's'} klaar voor jou` : 'geen open vervolgacties'}
                tone={failed30.rows[0].n || vervolg ? 'crit' : 'ok'}
                href="/incasso/mislukt"
              />
              <Kpi label="Betaalprovider" value={p.payments.name === 'nep' ? 'Testmodus' : 'Mollie'} sub={p.payments.name === 'nep' ? 'er gaat geen geld over' : undefined} />
            </section>
            <div class="cols">
              <section class="card">
                <div class="card-head">
                  <h2>Batches</h2>
                  <span class="small">Een agent zet verlengingen automatisch klaar. Jij controleert, valideert en dient in.</span>
                </div>
                {runs.length === 0 ? (
                  <Empty title="Nog geen incassobatches" />
                ) : (
                  <div class="table-wrap">
                    <table class="table">
                      <thead>
                        <tr>
                          <th>Incassodatum</th>
                          <th>Status</th>
                          <th class="num">Regels</th>
                          <th class="num">Totaal incl. btw</th>
                          <th>Uitkomst</th>
                          <th>Klaargezet</th>
                        </tr>
                      </thead>
                      <tbody>
                        {runs.map((r) => (
                          <tr>
                            <td>
                              <a href={`/incasso/${r.id}`}>
                                <b>{datum(r.collection_date)}</b>
                              </a>
                              {r.provider === 'nep' ? <span class="tag">test</span> : null}
                            </td>
                            <td>
                              <Status kind={RUN_STATUS[r.status][1]}>{RUN_STATUS[r.status][0]}</Status>
                            </td>
                            <td class="num">{r.included}</td>
                            <td class="num">{euro(r.total_incl_cents)}</td>
                            <td>
                              {r.status === 'ingediend' || r.status === 'afgerond' ? (
                                <span>
                                  {r.paid} betaald{r.failed ? <b class="t-crit"> · {r.failed} mislukt</b> : null}
                                </span>
                              ) : (
                                <span class="muted">—</span>
                              )}
                            </td>
                            <td class="nowrap">
                              {datumTijd(r.created_at)}
                              <span class="sub">{r.source === 'agent' ? 'door agent' : (r.created_by_email ?? 'systeem')}</span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
              {mag ? (
                <section class="card">
                  <h2>Batch klaarzetten</h2>
                  <p class="small">Normaal doet een agent dit automatisch. Hier kun je het zelf starten: alle abonnementen met incasso die op of vóór de datum verlengen.</p>
                  <form class="stack" data-api="/api/incasso" data-next="/incasso/{batch}">
                    <FormError />
                    <label>
                      Incassodatum
                      <input type="date" name="incassodatum" value={defaultDate()} required />
                    </label>
                    <div>
                      <button class="btn" type="submit">
                        Klaarzetten
                      </button>
                    </div>
                  </form>
                </section>
              ) : null}
            </div>
          </>
        ),
      });
    });

    pages.get('/incasso/mislukt', async (c) => {
      const toon = c.req.query('toon') === 'afgehandeld' ? 'afgehandeld' : 'open';
      const rows = await listFollowups(p.pool, toon);
      const mag = can(c.get('staff').role, 'incasso.indienen');
      const test = isNepProvider(p.payments);
      return ctx.page(c, {
        title: "Mislukte incasso's",
        active: 'incasso',
        eyebrow: "Incasso's",
        tabs: await tabs(p, 'mislukt'),
        actions: (
          <div class="row">
            <a class={`btn sm ${toon === 'open' ? '' : 'secondary'}`} href="/incasso/mislukt">
              Te doen
            </a>
            <a class={`btn sm ${toon === 'afgehandeld' ? '' : 'secondary'}`} href="/incasso/mislukt?toon=afgehandeld">
              Afgehandeld
            </a>
          </div>
        ),
        children:
          rows.length === 0 ? (
            <section class="card">
              <Empty title={toon === 'open' ? 'Geen mislukte incasso\'s om op te volgen' : 'Nog niets afgehandeld'}>
                {toon === 'open' ? 'Mislukt er een incasso, dan zet een agent hier meteen een voorstel klaar: wat te doen, waarom, en een conceptmail.' : null}
              </Empty>
            </section>
          ) : (
            <>
              {toon === 'open' ? (
                <p class="small">
                  Per mislukte incasso staat een voorstel klaar. Er gaat niets naar de klant zonder jouw klik. Kies een andere actie als het voorstel niet past.
                </p>
              ) : null}
              {rows.map((f) => (toon === 'open' ? <FollowupCard f={f} mag={mag} appOrigin={p.config.appOrigin} /> : <DoneCard f={f} mag={mag} test={test} />))}
            </>
          ),
      });
    });

    pages.get('/incasso/:id', async (c) => {
      const id = idParam(c.req.param('id'), 'Deze incassobatch');
      const [run, items] = await Promise.all([getRun(p.pool, id), listItems(p.pool, id)]);
      const role = c.get('staff').role;
      const magBewerken = can(role, 'facturatie.beheren') && run.status === 'concept';
      const magIndienen = can(role, 'incasso.indienen');
      const test = run.provider === 'nep' && isNepProvider(p.payments);
      const steps: Array<[string, boolean, string]> = [
        ['Klaargezet', true, `${datumTijd(run.created_at)}${run.source === 'agent' ? ' door agent' : run.created_by_email ? ` door ${run.created_by_email}` : ''}`],
        ['Gecontroleerd en gevalideerd', !!run.validated_at, run.validated_at ? `${datumTijd(run.validated_at)} door ${run.validated_by_email ?? ''}` : ''],
        ['Ingediend', !!run.submitted_at, run.submitted_at ? `${datumTijd(run.submitted_at)} door ${run.submitted_by_email ?? ''}` : ''],
        ['Afgerond', run.status === 'afgerond', run.status === 'afgerond' ? `${run.paid} betaald, ${run.failed} mislukt` : ''],
      ];
      return ctx.page(c, {
        title: `Incasso ${datum(run.collection_date)}`,
        active: 'incasso',
        eyebrow: run.provider === 'nep' ? "Incasso's · testmodus, er gaat geen geld over" : "Incasso's",
        actions: <Status kind={RUN_STATUS[run.status][1]}>{RUN_STATUS[run.status][0]}</Status>,
        children: (
          <>
            <div class="cols">
              <section class="card">
                <h2>Voortgang</h2>
                <ol class="flow">
                  {steps.map(([label, done, sub]) => (
                    <li class={done ? 'done' : undefined}>
                      <b>{label}</b>
                      {sub ? <span>{sub}</span> : null}
                    </li>
                  ))}
                </ol>
              </section>
              <section class="card">
                <h2>Samenvatting</h2>
                <p class="bedrag">{euro(run.total_incl_cents)}</p>
                <p class="small">
                  {run.included} incasso{run.included === 1 ? '' : "'s"} incl. btw · {run.items - run.included} uitgesloten
                </p>
                {run.status === 'concept' && magIndienen ? (
                  <form class="stack" data-api={`/api/incasso/${id}/valideren`} data-bevestig={`Batch valideren: ${run.included} incasso's, ${euro(run.total_incl_cents)}? Daarna is niets meer te wijzigen.`}>
                    <FormError />
                    <button class="btn wide" type="submit">
                      Controle klaar: valideren
                    </button>
                  </form>
                ) : null}
                {run.status === 'gevalideerd' && magIndienen ? (
                  <>
                    <form class="stack" data-api={`/api/incasso/${id}/indienen`} data-bevestig={`Nu ${run.included} incasso's indienen voor in totaal ${euro(run.total_incl_cents)}?${run.provider === 'nep' ? ' (testmodus)' : ''}`}>
                      <FormError />
                      <button class="btn wide big" type="submit">
                        Indienen: {run.included} incasso{run.included === 1 ? '' : "'s"}, {euro(run.total_incl_cents)}
                      </button>
                    </form>
                    <form data-api={`/api/incasso/${id}/concept`}>
                      <button class="linkbtn" type="submit">
                        Terug naar concept om iets aan te passen
                      </button>
                    </form>
                  </>
                ) : null}
                {(run.status === 'concept' || run.status === 'gevalideerd') && can(role, 'facturatie.beheren') ? (
                  <form data-api={`/api/incasso/${id}/annuleren`} data-bevestig="Deze batch annuleren? Er wordt niets ingediend.">
                    <button class="btn danger sm" type="submit">
                      Batch annuleren
                    </button>
                  </form>
                ) : null}
                {run.status === 'concept' && !magIndienen ? <p class="small">Een medewerker met de rol financieel of beheerder valideert en dient in.</p> : null}
              </section>
            </div>

            <section class="card">
              <div class="card-head">
                <h2>Regels</h2>
                {magBewerken ? <span class="small">Sluit een regel uit of pas het bedrag aan; je reden komt in het audit-log.</span> : null}
              </div>
              {items.length === 0 ? (
                <Empty title="Geen regels" />
              ) : (
                <div class="table-wrap">
                  <table class="table">
                    <thead>
                      <tr>
                        <th>Bedrijf</th>
                        <th>Omschrijving</th>
                        <th>Periode</th>
                        <th class="num">Excl. btw</th>
                        <th class="num">Incl. btw</th>
                        <th>Status</th>
                        <th class="num">Acties</th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((it) => (
                        <tr class={it.status === 'uitgesloten' ? 'dim' : undefined}>
                          <td>
                            <a href={`/klanten/${it.organization_id}?tab=facturatie`}>{it.organization_name}</a>
                            {it.recent_failures ? <span class="sub t-crit">{it.recent_failures}× eerder mislukt</span> : null}
                          </td>
                          <td>
                            {it.description}
                            {it.lines && it.lines.length > 1
                              ? it.lines.slice(1).map((l) => (
                                  <span class="sub">
                                    + {l.aantal}× {l.omschrijving}: {euro(l.totaalExclCenten)}
                                  </span>
                                ))
                              : null}
                            {it.adjust_reason ? (
                              <span class="sub">
                                Aangepast van {euro(it.original_excl_cents ?? 0)}: {it.adjust_reason}
                              </span>
                            ) : null}
                            {it.exclude_reason ? <span class="sub">Uitgesloten: {it.exclude_reason}</span> : null}
                          </td>
                          <td class="nowrap">{periode(it.period_start, it.period_end)}</td>
                          <td class="num">{euro(it.amount_excl_cents)}</td>
                          <td class="num">{euro(it.amount_incl_cents)}</td>
                          <td>
                            <Status kind={ITEM_STATUS[it.status][1]}>{ITEM_STATUS[it.status][0]}</Status>
                            {it.failure_reason ? <span class="sub">{FAILURE_LABEL[it.failure_reason]}</span> : null}
                          </td>
                          <td class="num">
                            {magBewerken && it.status === 'klaar' ? (
                              <details class="acties">
                                <summary class="btn secondary sm">Wijzigen</summary>
                                <div class="pop">
                                  <form class="stack" data-api={`/api/incasso/${id}/regels/${it.id}/uitsluiten`}>
                                    <FormError />
                                    <label>
                                      Uitsluiten, reden
                                      <input type="text" name="reden" required maxlength={400} placeholder="Bijv. klant betaalt deze keer op factuur" />
                                    </label>
                                    <button class="btn secondary sm" type="submit">
                                      Uitsluiten
                                    </button>
                                  </form>
                                  <form class="stack" data-api={`/api/incasso/${id}/regels/${it.id}/bedrag`}>
                                    <FormError />
                                    <label>
                                      Nieuw bedrag excl. btw (€)
                                      <input type="text" name="bedrag" inputmode="decimal" required placeholder={(it.amount_excl_cents / 100).toFixed(2).replace('.', ',')} />
                                    </label>
                                    <label>
                                      Reden
                                      <input type="text" name="reden" required maxlength={400} placeholder="Bijv. 50% korting afgesproken" />
                                    </label>
                                    <button class="btn secondary sm" type="submit">
                                      Bedrag aanpassen
                                    </button>
                                  </form>
                                </div>
                              </details>
                            ) : null}
                            {magBewerken && it.status === 'uitgesloten' ? (
                              <form data-api={`/api/incasso/${id}/regels/${it.id}/terugzetten`}>
                                <button class="btn secondary sm" type="submit">
                                  Terugzetten
                                </button>
                                <FormError />
                              </form>
                            ) : null}
                            {test && it.status === 'ingediend' && magIndienen ? (
                              <form class="inline end" data-api={`/api/incasso/regels/${it.id}/testuitkomst`}>
                                <select name="reden" aria-label="Reden bij mislukken">
                                  {FAILURE_REASONS.map((r) => (
                                    <option value={r}>{FAILURE_LABEL[r]}</option>
                                  ))}
                                </select>
                                <button class="btn secondary sm" type="submit" name="uitkomst" value="mislukt">
                                  Test: mislukt
                                </button>
                                <button class="btn sm" type="submit" name="uitkomst" value="betaald">
                                  Test: betaald
                                </button>
                                <FormError />
                              </form>
                            ) : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </>
        ),
      });
    });

    // API --------------------------------------------------------------------------------
    api.post('/incasso', async (c) => {
      ctx.require(c, 'facturatie.beheren');
      const { incassodatum } = await ctx.body(c, z.object({ incassodatum: z.string().max(10) }));
      const r = await prepareRun(p, { collectionDate: incassodatum }, c.get('actor'));
      if (!r) return c.json({ fout: 'conflict', bericht: 'Er zijn geen abonnementen met incasso die op of vóór deze datum verlengen.' }, 409);
      return c.json({ batch: r.runId, regels: r.items, overgeslagenFactuur: r.skippedFactuur, zonderMachtiging: r.skippedMandate }, 201);
    });
    api.post('/incasso/:id/valideren', async (c) => {
      ctx.require(c, 'incasso.indienen');
      await validateRun(p, idParam(c.req.param('id'), 'Deze incassobatch'), c.get('actor'));
      return c.json({ ok: true });
    });
    api.post('/incasso/:id/concept', async (c) => {
      ctx.require(c, 'incasso.indienen');
      await reopenRun(p, idParam(c.req.param('id'), 'Deze incassobatch'), c.get('actor'));
      return c.json({ ok: true });
    });
    api.post('/incasso/:id/indienen', async (c) => {
      ctx.require(c, 'incasso.indienen');
      const r = await submitRun(p, idParam(c.req.param('id'), 'Deze incassobatch'), c.get('actor'));
      return c.json({ ingediend: r.submitted });
    });
    api.post('/incasso/:id/annuleren', async (c) => {
      ctx.require(c, 'facturatie.beheren');
      await cancelRun(p, idParam(c.req.param('id'), 'Deze incassobatch'), c.get('actor'));
      return c.json({ ok: true });
    });
    api.post('/incasso/:id/regels/:item/uitsluiten', async (c) => {
      ctx.require(c, 'facturatie.beheren');
      const { reden } = await ctx.body(c, z.object({ reden: z.string().max(400) }));
      await excludeItem(p, idParam(c.req.param('id'), 'Deze incassobatch'), idParam(c.req.param('item'), 'Deze regel'), reden, c.get('actor'));
      return c.json({ ok: true });
    });
    api.post('/incasso/:id/regels/:item/terugzetten', async (c) => {
      ctx.require(c, 'facturatie.beheren');
      await includeItem(p, idParam(c.req.param('id'), 'Deze incassobatch'), idParam(c.req.param('item'), 'Deze regel'), c.get('actor'));
      return c.json({ ok: true });
    });
    api.post('/incasso/:id/regels/:item/bedrag', async (c) => {
      ctx.require(c, 'facturatie.beheren');
      const b = await ctx.body(c, z.object({ bedrag: z.union([z.string().max(20), z.number()]), reden: z.string().max(400) }));
      const cents = parseEuro(b.bedrag);
      await adjustItem(p, idParam(c.req.param('id'), 'Deze incassobatch'), idParam(c.req.param('item'), 'Deze regel'), cents, b.reden, c.get('actor'));
      return c.json({ ok: true });
    });
    api.post('/incasso/vervolg/:id/uitvoeren', async (c) => {
      ctx.require(c, 'incasso.indienen');
      const b = await ctx.body(
        c,
        z.object({
          actie: z.enum(FOLLOWUP_ACTIONS),
          onderwerp: z.string().max(200).optional(),
          tekst: z.string().max(4000).optional(),
          notitie: z.string().max(400).optional(),
        }),
      );
      const r = await executeFollowup(p, idParam(c.req.param('id'), 'Dit voorstel'), b, c.get('actor'));
      return c.json({ betaling: r.paymentId ?? null, gemaildAan: r.mailedTo ?? null });
    });
    api.post('/incasso/vervolg/:id/afwijzen', async (c) => {
      ctx.require(c, 'incasso.indienen');
      const { reden } = await ctx.body(c, z.object({ reden: z.string().max(400) }));
      await rejectFollowup(p, idParam(c.req.param('id'), 'Dit voorstel'), reden, c.get('actor'));
      return c.json({ ok: true });
    });
    api.post('/incasso/vervolg/:id/testuitkomst', async (c) => {
      ctx.require(c, 'incasso.indienen');
      const { uitkomst } = await ctx.body(c, z.object({ uitkomst: z.enum(['betaald', 'mislukt']) }));
      const status = await settleTestFollowupPayment(p, idParam(c.req.param('id'), 'Dit voorstel'), uitkomst, c.get('actor'));
      return c.json({ status });
    });
    api.post('/incasso/regels/:item/testuitkomst', async (c) => {
      ctx.require(c, 'incasso.indienen');
      const b = await ctx.body(c, z.object({ uitkomst: z.enum(['betaald', 'mislukt']), reden: z.enum(FAILURE_REASONS).optional() }));
      const status = await settleTestItem(p, idParam(c.req.param('item'), 'Deze regel'), b.uitkomst, b.reden, c.get('actor'));
      return c.json({ status });
    });
  },
};

const PAY_LABEL: Record<string, [string, StatusKind]> = {
  open: ['Wacht op betaling', 'warn'],
  betaald: ['Betaald', 'ok'],
  mislukt: ['Mislukt', 'crit'],
  verlopen: ['Verlopen', 'unk'],
  geannuleerd: ['Geannuleerd', 'unk'],
};

function FailHead({ f }: { f: FollowupRow }) {
  return (
    <div class="card-head">
      <div>
        <h2>
          <a href={`/klanten/${f.organization_id}?tab=facturatie`}>{f.organization_name}</a>
        </h2>
        <span class="small">
          {f.description} · {euro(f.amount_incl_cents)} · mislukt {datumTijd(f.created_at)}
        </span>
      </div>
      <div class="row">
        <Status kind="crit">{f.failure_reason ? FAILURE_LABEL[f.failure_reason] : 'Mislukt'}</Status>
        {f.failures > 1 ? <span class="tag">{f.failures}× in 6 maanden</span> : null}
      </div>
    </div>
  );
}

/** Formulier voor één actie, met de conceptmail vooringevuld. */
function ActionForm({ f, action, draft, primary }: { f: FollowupRow; action: FollowupAction; draft: { subject: string; body: string } | null; primary: boolean }) {
  const label = ACTION_LABEL[action];
  const bevestig =
    action === 'bellen'
      ? 'Vastleggen dat je de klant hebt gebeld?'
      : `${label}: mail naar ${f.recipient ?? '(geen adres)'}${action === 'herpoging' || action === 'factuur_sturen' ? ` en een nieuwe betaling van ${euro(f.amount_incl_cents)}` : ''}?`;
  return (
    <form class="stack" data-api={`/api/incasso/vervolg/${f.id}/uitvoeren`} data-bevestig={bevestig}>
      <FormError />
      <input type="hidden" name="actie" value={action} />
      {draft ? (
        <>
          <p class="small">
            Mail aan{' '}
            {f.recipient ? (
              <b>{f.recipient}</b>
            ) : (
              <b class="t-crit">
                geen e-mailadres bekend; vul eerst een factuuradres in bij <a href={`/klanten/${f.organization_id}?tab=facturatie`}>de klant</a>
              </b>
            )}
            {action === 'factuur_sturen' ? '. {betaallink} wordt vervangen door de link om te betalen.' : ''}
          </p>
          <label>
            Onderwerp
            <input type="text" name="onderwerp" value={draft.subject} required maxlength={200} />
          </label>
          <label>
            Tekst
            <textarea name="tekst" rows={12} required maxlength={4000}>
              {draft.body}
            </textarea>
          </label>
        </>
      ) : null}
      <label>
        {action === 'bellen' ? 'Wat is er afgesproken? (komt in het audit-log)' : 'Notitie (optioneel)'}
        <input type="text" name="notitie" maxlength={400} required={action === 'bellen'} />
      </label>
      <div>
        <button class={`btn${primary ? '' : ' secondary'}`} type="submit">
          {action === 'bellen' ? 'Gebeld, vastleggen' : `${label}: versturen`}
        </button>
      </div>
    </form>
  );
}

function FollowupCard({ f, mag, appOrigin }: { f: FollowupRow; mag: boolean; appOrigin: string }) {
  const draftOf = (a: FollowupAction) =>
    a === 'bellen' ? null : a === f.suggested_action && f.mail_subject && f.mail_body ? { subject: f.mail_subject, body: f.mail_body } : mailDraft(f, a, appOrigin);
  return (
    <section class="card">
      <FailHead f={f} />
      <div class="voorstel">
        <span class="tag">Voorstel agent</span>
        <b>{ACTION_LABEL[f.suggested_action]}</b>
        <span class="small">{f.suggestion_reason}</span>
      </div>
      {mag ? (
        <>
          <ActionForm f={f} action={f.suggested_action} draft={draftOf(f.suggested_action)} primary />
          <details class="meer">
            <summary class="linkbtn">Andere actie kiezen</summary>
            {FOLLOWUP_ACTIONS.filter((a) => a !== f.suggested_action).map((a) => (
              <div class="alt">
                <h3>{ACTION_LABEL[a]}</h3>
                <ActionForm f={f} action={a} draft={draftOf(a)} primary={false} />
              </div>
            ))}
          </details>
          <details class="meer">
            <summary class="linkbtn">Afwijzen, niets doen</summary>
            <form class="stack" data-api={`/api/incasso/vervolg/${f.id}/afwijzen`}>
              <FormError />
              <label>
                Waarom? (komt in het audit-log)
                <input type="text" name="reden" required maxlength={400} placeholder="Bijv. klant heeft al overgemaakt" />
              </label>
              <div>
                <button class="btn secondary sm" type="submit">
                  Afwijzen
                </button>
              </div>
            </form>
          </details>
        </>
      ) : (
        <p class="small">Een medewerker met de rol financieel of beheerder handelt dit af.</p>
      )}
    </section>
  );
}

function DoneCard({ f, mag, test }: { f: FollowupRow; mag: boolean; test: boolean }) {
  const pay = f.result_payment_status ? PAY_LABEL[f.result_payment_status] : undefined;
  return (
    <section class="card">
      <FailHead f={f} />
      <dl class="facts">
        <dt>Besluit</dt>
        <dd>
          {f.status === 'afgewezen' ? 'Afgewezen' : ACTION_LABEL[f.chosen_action ?? f.suggested_action]}
          {f.chosen_action && f.chosen_action !== f.suggested_action ? <span class="muted"> (voorstel was: {ACTION_LABEL[f.suggested_action]})</span> : null}
        </dd>
        <dt>Door</dt>
        <dd>
          {f.decided_by_email ?? 'onbekend'}
          {f.decided_at ? `, ${datumTijd(f.decided_at)}` : ''}
        </dd>
        {f.decision_note ? (
          <>
            <dt>Notitie</dt>
            <dd>{f.decision_note}</dd>
          </>
        ) : null}
        {pay ? (
          <>
            <dt>Nieuwe betaling</dt>
            <dd>
              <Status kind={pay[1]}>{pay[0]}</Status>
            </dd>
          </>
        ) : null}
      </dl>
      {test && mag && f.result_payment_status === 'open' ? (
        <form class="inline" data-api={`/api/incasso/vervolg/${f.id}/testuitkomst`}>
          <button class="btn secondary sm" type="submit" name="uitkomst" value="mislukt">
            Test: mislukt
          </button>
          <button class="btn sm" type="submit" name="uitkomst" value="betaald">
            Test: betaald
          </button>
          <FormError />
        </form>
      ) : null}
    </section>
  );
}

/** "49,00", "49.5", "1.234,56" of 49 → centen. */
export function parseEuro(v: string | number): number {
  if (typeof v === 'number') return Math.round(v * 100);
  let s = v.trim().replace(/[€\s]/g, '');
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return Number.NaN;
  return Math.round(Number(s) * 100);
}
