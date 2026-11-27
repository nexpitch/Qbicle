/** @jsxImportSource hono/jsx */
import { healthSummary, listErrors, listMails, listScanJobs, opsAudit, resolveError } from '@qbicle/ops';
import { notFound, one, PlatformError } from '@qbicle/platform';
import { z } from 'zod';
import { opsActor, opsContext, getal } from '../core/ops.ts';
import { can } from '../core/roles.ts';
import { datumTijd, Empty, FormError, Kpi, Status, type StatusKind } from '../layout.tsx';
import type { CockpitModule } from '../module.ts';

const uuid = z.uuid();
const SCAN_STATUS: Record<string, [string, StatusKind]> = {
  wachtrij: ['Wachtrij', 'info'],
  bezig: ['Bezig', 'info'],
  klaar: ['Klaar', 'ok'],
  mislukt: ['Mislukt', 'crit'],
};
const MAIL_STATUS: Record<string, StatusKind> = {
  verstuurd: 'info', afgeleverd: 'ok', geopend: 'ok', uitgesteld: 'warn', gebounced: 'crit', geblokkeerd: 'crit', spam: 'crit', mislukt: 'crit',
};

export const gezondheid: CockpitModule = {
  key: 'gezondheid',
  nav: [{ key: 'gezondheid', label: 'Gezondheid', href: '/gezondheid', icon: 'gezondheid', group: 'techniek', order: 20 }],
  register({ pages, api }, ctx) {
    const ops = () => opsContext(ctx.cockpit);

    pages.get('/gezondheid', async (c) => {
      const tab = c.req.query('tab') ?? 'scans';
      const filter = (c.req.query('filter') ?? 'aandacht') as 'aandacht' | 'vast' | 'mislukt' | 'wachtrij' | 'alle';
      const h = await healthSummary(ops());
      const mag = can(c.get('staff').role, 'support.beheren');
      const tone = h.oordeel === 'goed' ? 'ok' : h.oordeel === 'aandacht' ? 'warn' : 'crit';
      let body;
      if (tab === 'fouten') {
        const errs = await listErrors(ops().pool, { open: c.req.query('opgelost') !== '1', limit: 100 });
        body = (
          <section class="card">
            <div class="card-head">
              <h2>Fouten</h2>
              <a class="small" href={c.req.query('opgelost') === '1' ? '/gezondheid?tab=fouten' : '/gezondheid?tab=fouten&opgelost=1'}>
                {c.req.query('opgelost') === '1' ? 'Alleen open fouten' : 'Ook opgeloste'}
              </a>
            </div>
            {errs.length === 0 ? (
              <Empty title="Geen open fouten" />
            ) : (
              <div class="table-wrap">
                <table class="table">
                  <thead>
                    <tr>
                      <th>Laatst</th>
                      <th>Bron</th>
                      <th>Melding</th>
                      <th>Bedrijf</th>
                      <th class="num">Aantal</th>
                      {mag ? <th class="num"></th> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {errs.map((e) => (
                      <tr class={e.resolved_at ? 'dim' : undefined}>
                        <td class="nowrap">{datumTijd(e.last_seen)}</td>
                        <td>{e.source}</td>
                        <td>
                          {e.message}
                          <span class="sub">sinds {datumTijd(e.first_seen)}</span>
                        </td>
                        <td>{e.organization_id ? <a href={`/gebruik/${e.organization_id}`}>{e.organization_name}</a> : ''}</td>
                        <td class="num">{getal(e.occurrences)}</td>
                        {mag ? (
                          <td class="num">
                            {e.resolved_at ? null : (
                              <form data-api={`/api/gezondheid/fouten/${e.id}/opgelost`}>
                                <button class="btn secondary sm" type="submit">
                                  Opgelost
                                </button>
                                <FormError />
                              </form>
                            )}
                          </td>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        );
      } else if (tab === 'mail') {
        const problemen = c.req.query('alles') !== '1';
        const mails = await listMails(ops().pool, { problemsOnly: problemen, limit: 100 });
        body = (
          <>
            <section class="kpis">
              {Object.entries(h.mail.perStatus).map(([s, n]) => (
                <Kpi label={s} value={getal(n)} sub="laatste 7 dagen" tone={MAIL_STATUS[s] === 'crit' ? 'crit' : undefined} />
              ))}
            </section>
            <section class="card">
              <div class="card-head">
                <h2>{problemen ? 'Mails die niet aankwamen' : 'Alle mails'}</h2>
                <a class="small" href={problemen ? '/gezondheid?tab=mail&alles=1' : '/gezondheid?tab=mail'}>
                  {problemen ? 'Alle mails tonen' : 'Alleen problemen'}
                </a>
              </div>
              {mails.length === 0 ? (
                <Empty title={problemen ? 'Alle mail komt aan' : 'Nog geen mail verstuurd'} />
              ) : (
                <div class="table-wrap">
                  <table class="table">
                    <thead>
                      <tr>
                        <th>Verstuurd</th>
                        <th>Aan</th>
                        <th>Onderwerp</th>
                        <th>Status</th>
                        <th>Reden</th>
                      </tr>
                    </thead>
                    <tbody>
                      {mails.map((m) => (
                        <tr>
                          <td class="nowrap">{datumTijd(m.created_at)}</td>
                          <td>{m.recipient}</td>
                          <td>{m.subject}</td>
                          <td>
                            <Status kind={MAIL_STATUS[m.status] ?? 'unk'}>{m.status}</Status>
                          </td>
                          <td class="muted small">{m.error ?? ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p class="small">Bezorgstatus komt van Brevo (webhook). Zonder webhook blijft de status op 'verstuurd'.</p>
            </section>
          </>
        );
      } else {
        const jobs =
          filter === 'aandacht'
            ? [...(await listScanJobs(ops(), 'vast', { limit: 50 })), ...(await listScanJobs(ops(), 'mislukt', { limit: 50 }))]
            : await listScanJobs(ops(), filter, { limit: 100 });
        const f = (key: string, label: string) => (
          <a href={`/gezondheid?filter=${key}`} aria-current={filter === key ? 'page' : undefined}>
            {label}
          </a>
        );
        body = (
          <section class="card">
            <div class="card-head">
              <h2>Scanjobs</h2>
              <nav class="row small" aria-label="Filter">
                {f('aandacht', 'Vast of mislukt')} · {f('wachtrij', 'Wachtrij')} · {f('alle', 'Alle')}
              </nav>
            </div>
            {jobs.length === 0 ? (
              <Empty title="Geen scanjobs die aandacht vragen" />
            ) : (
              <div class="table-wrap">
                <table class="table">
                  <thead>
                    <tr>
                      <th>Aangemaakt</th>
                      <th>Domein</th>
                      <th>Bedrijf</th>
                      <th>Status</th>
                      <th class="num">Pogingen</th>
                      <th>Fout</th>
                      {mag ? <th class="num"></th> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {jobs.map((j) => (
                      <tr>
                        <td class="nowrap">{datumTijd(j.created_at)}</td>
                        <td>{j.domain}</td>
                        <td>
                          <a href={`/gebruik/${j.organization_id}`}>{j.organization_name}</a>
                        </td>
                        <td>
                          {j.stuck ? <Status kind="warn">Vast</Status> : <Status kind={SCAN_STATUS[j.status]?.[1] ?? 'unk'}>{SCAN_STATUS[j.status]?.[0] ?? j.status}</Status>}
                        </td>
                        <td class="num">{j.attempts}</td>
                        <td class="muted small">{j.error ?? ''}</td>
                        {mag ? (
                          <td class="num">
                            {j.stuck || j.status === 'mislukt' ? (
                              <form data-api={`/api/gezondheid/scans/${j.id}/opnieuw`}>
                                <button class="btn secondary sm" type="submit">
                                  Opnieuw
                                </button>
                                <FormError />
                              </form>
                            ) : null}
                          </td>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        );
      }
      return ctx.page(c, {
        title: 'Gezondheid',
        active: 'gezondheid',
        eyebrow: 'Techniek en support',
        tabs: [
          ['Scanjobs', '/gezondheid', tab === 'scans'],
          [`Fouten (${h.openFouten})`, '/gezondheid?tab=fouten', tab === 'fouten'],
          ['Mail', '/gezondheid?tab=mail', tab === 'mail'],
        ],
        children: (
          <>
            <div class={`banner b-${tone}`} role="status">
              <Status kind={tone}>{h.oordeel === 'goed' ? 'Alles werkt' : h.oordeel === 'aandacht' ? 'Aandacht' : 'Storing'}</Status>
              {h.redenen.length ? (
                <ul>
                  {h.redenen.map((r) => (
                    <li>{r}</li>
                  ))}
                </ul>
              ) : (
                <span class="small">Geen vastgelopen scans, fouten of mailproblemen.</span>
              )}
            </div>
            <section class="kpis" aria-label="Scans">
              <Kpi label="Wachtrij" value={getal(h.scans.wachtrij)} sub={h.scans.oudsteWachtrijMinuten === null ? 'leeg' : `oudste ${h.scans.oudsteWachtrijMinuten} min`} />
              <Kpi label="Bezig" value={getal(h.scans.bezig)} sub={h.scans.vast ? `${h.scans.vast} vast` : 'niets vast'} tone={h.scans.vast ? 'warn' : 'ok'} />
              <Kpi
                label="Scan-worker"
                value={h.scans.workersActief ? 'draait' : 'stil'}
                sub={h.scans.workerLaatstGezienMinuten === null ? 'nog nooit gezien' : h.scans.workersActief ? `${getal(h.scans.workersActief)} actief` : `${h.scans.workerLaatstGezienMinuten} min geleden`}
                tone={h.scans.workersActief ? 'ok' : h.scans.wachtrij ? 'crit' : 'warn'}
              />
              <Kpi
                label="Mislukt (24 uur)"
                value={getal(h.scans.mislukt24u)}
                sub={h.scans.foutPercentage24u === null ? 'nog geen scans' : `${h.scans.foutPercentage24u}% van ${h.scans.klaar24u + h.scans.mislukt24u}`}
                tone={h.scans.mislukt24u ? 'crit' : 'ok'}
              />
              <Kpi
                label="Mail komt niet aan"
                value={h.mail.probleemPercentage === null ? '—' : `${h.mail.probleemPercentage}%`}
                sub={`${getal(h.mail.totaal)} mails in 7 dagen`}
                tone={(h.mail.probleemPercentage ?? 0) > 0 ? 'warn' : 'ok'}
                href="/gezondheid?tab=mail"
              />
            </section>
            {body}
          </>
        ),
      });
    });

    // Een medewerker zet een scan opnieuw in de wachtrij (zelfde regels als de Bewaker).
    api.post('/gezondheid/scans/:id/opnieuw', async (c) => {
      ctx.require(c, 'support.beheren');
      const id = c.req.param('id');
      if (!uuid.safeParse(id).success) throw notFound('Deze scan');
      const r = await one<{ organization_id: string }>(
        ops().pool,
        `UPDATE scan s SET status = 'wachtrij', started_at = NULL, finished_at = NULL, error = NULL, attempts = attempts + 1
           FROM domain d WHERE s.id = $1 AND d.id = s.domain_id AND s.status IN ('bezig', 'mislukt')
         RETURNING d.organization_id`,
        [id],
      );
      if (!r) throw new PlatformError('conflict', 'Deze scan is niet vast of mislukt.');
      await opsAudit(ops().pool, opsActor(c), { action: 'ops.scan_opnieuw', organizationId: r.organization_id, subject: id });
      return c.json({ ok: true });
    });

    api.post('/gezondheid/fouten/:id/opgelost', async (c) => {
      ctx.require(c, 'support.beheren');
      const id = c.req.param('id');
      if (!uuid.safeParse(id).success) throw notFound('Deze fout');
      const actor = opsActor(c);
      if (!(await resolveError(ops().pool, id, actor.userId))) throw new PlatformError('conflict', 'Deze fout is al opgelost.');
      await opsAudit(ops().pool, actor, { action: 'ops.fout_opgelost', subject: id });
      return c.json({ ok: true });
    });
  },
};
