/** @jsxImportSource hono/jsx */
import { checkVatNumber, EU_VAT_FORMATS, PlatformError, vatStatus } from '@qbicle/platform';
import { z } from 'zod';
import { can } from '../core/roles.ts';
import { addNote, getOrganizationDetail, listNotes, listOrganizations, orgTimeline, SUB_FILTERS, type SubFilter } from '../core/customers.ts';
import { getPaymentSettings, PAYMENT_METHODS, setPaymentSettings } from '../core/billing-admin.ts';
import { METHOD_LABEL, ORG_KIND, PayStatusFull, planName, SubStatus } from '../labels.tsx';
import { datum, datumTijd, Empty, euro, euroKort, FormError, Status } from '../layout.tsx';
import type { CockpitModule } from '../module.ts';
import { actionLabel } from './audit.tsx';

const FILTER_LABEL: Record<SubFilter, string> = {
  alle: 'Alle',
  actief: 'Actief',
  proef: 'Proef',
  achterstallig: 'Achterstallig',
  opgezegd: 'Opgezegd',
  geen: 'Zonder abonnement',
};

const TABS = ['overzicht', 'gebruikers', 'domeinen', 'facturatie', 'notities', 'tijdlijn'] as const;
type Tab = (typeof TABS)[number];
const TAB_LABEL: Record<Tab, string> = {
  overzicht: 'Overzicht',
  gebruikers: 'Gebruikers',
  domeinen: 'Domeinen',
  facturatie: 'Facturatie',
  notities: 'Notities',
  tijdlijn: 'Tijdlijn',
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function idParam(v: string | undefined, what = 'Dit bedrijf'): string {
  if (!v || !UUID_RE.test(v)) throw new PlatformError('niet_gevonden', `${what} bestaat niet.`);
  return v;
}

const PAGE = 50;

export const klanten: CockpitModule = {
  key: 'klanten',
  nav: [{ key: 'klanten', label: 'Bedrijven', href: '/klanten', icon: 'bedrijf', group: 'klanten', order: 10 }],
  register({ pages, api }, ctx) {
    const catalog = ctx.cockpit.p.catalog;

    pages.get('/klanten', async (c) => {
      const zoek = c.req.query('zoek') ?? '';
      const f = c.req.query('filter');
      const filter: SubFilter = (SUB_FILTERS as readonly string[]).includes(f ?? '') ? (f as SubFilter) : 'alle';
      const pagina = Math.max(1, Number(c.req.query('pagina')) || 1);
      const { rows, total } = await listOrganizations(ctx.cockpit.p.pool, { zoek, filter, limit: PAGE, offset: (pagina - 1) * PAGE });
      const link = (extra: Record<string, string>, f: SubFilter = filter) => {
        const u = new URLSearchParams({ ...(zoek ? { zoek } : {}), ...(f !== 'alle' ? { filter: f } : {}), ...extra });
        const s = u.toString();
        return s ? `/klanten?${s}` : '/klanten';
      };
      return ctx.page(c, {
        title: 'Bedrijven',
        active: 'klanten',
        eyebrow: 'Klanten',
        tabs: SUB_FILTERS.map((k) => [FILTER_LABEL[k], link({}, k), k === filter]),
        children: (
          <section class="card">
            <div class="card-head">
              <form class="filter" method="get" action="/klanten">
                {filter !== 'alle' ? <input type="hidden" name="filter" value={filter} /> : null}
                <input type="search" name="zoek" value={zoek} placeholder="Naam, domein, e-mail of KvK-nummer" aria-label="Zoek bedrijf" />
                <button class="btn secondary sm" type="submit">
                  Zoeken
                </button>
              </form>
              <span class="small">{total === 1 ? '1 bedrijf' : `${total} bedrijven`}</span>
            </div>
            {rows.length === 0 ? (
              <Empty title={zoek ? `Niets gevonden voor “${zoek}”` : 'Nog geen bedrijven'} />
            ) : (
              <div class="table-wrap">
                <table class="table">
                  <thead>
                    <tr>
                      <th>Bedrijf</th>
                      <th>Pakket</th>
                      <th>Status</th>
                      <th>Betaalwijze</th>
                      <th class="num">Per maand</th>
                      <th class="num">Gebruikers</th>
                      <th class="num">Domeinen</th>
                      <th>Klant sinds</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr>
                        <td>
                          <a href={`/klanten/${r.id}`}>
                            <b>{r.name}</b>
                          </a>
                          {r.kind !== 'klant' ? <span class="tag">{ORG_KIND[r.kind] ?? r.kind}</span> : null}
                          {r.failed_payments ? <span class="sub t-crit">{r.failed_payments}× betaling mislukt</span> : null}
                        </td>
                        <td>
                          {planName(catalog, r.plan)}
                          {r.billing_interval ? <span class="sub">per {r.billing_interval}</span> : null}
                        </td>
                        <td>
                          <SubStatus status={r.sub_status} />
                          {r.sub_status === 'proef' && r.trial_ends_at ? <span class="sub">tot {datum(r.trial_ends_at)}</span> : null}
                        </td>
                        <td>{METHOD_LABEL[r.payment_method] ?? r.payment_method}</td>
                        <td class="num">{r.monthly_price_cents != null ? euroKort(r.monthly_price_cents) : '—'}</td>
                        <td class="num">{r.users}</td>
                        <td class="num">{r.domains}</td>
                        <td class="nowrap">{datum(r.created_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {total > PAGE ? (
              <div class="row between">
                <span class="small">
                  Pagina {pagina} van {Math.ceil(total / PAGE)}
                </span>
                <div class="row">
                  {pagina > 1 ? <a class="btn secondary sm" href={link({ pagina: String(pagina - 1) })}>Vorige</a> : null}
                  {pagina * PAGE < total ? <a class="btn secondary sm" href={link({ pagina: String(pagina + 1) })}>Volgende</a> : null}
                </div>
              </div>
            ) : null}
          </section>
        ),
      });
    });

    pages.get('/klanten/:id', async (c) => {
      const id = idParam(c.req.param('id'));
      const t = c.req.query('tab');
      const tab: Tab = (TABS as readonly string[]).includes(t ?? '') ? (t as Tab) : 'overzicht';
      const q = ctx.cockpit.p.pool;
      const d = await getOrganizationDetail(q, id);
      const btw = await vatStatus(ctx.cockpit.p, q, id);
      const staff = c.get('staff');
      const s = d.subscription;
      const lopend = s && ['proef', 'actief', 'achterstallig', 'opgezegd'].includes(s.status) ? s : null;

      let body;
      if (tab === 'overzicht') {
        const betaald = d.payments.filter((p) => p.status === 'betaald').reduce((n, p) => n + p.amount_incl_cents, 0);
        const mislukt = d.payments.filter((p) => p.status === 'mislukt').length;
        body = (
          <>
            <section class="kpis">
              <div class="kpi">
                <p class="kpi-label">Abonnement</p>
                <p class="kpi-value sm">{lopend ? planName(catalog, lopend.plan) : 'Geen'}</p>
                <p class="kpi-sub">{lopend ? `${euroKort(lopend.monthly_price_cents)} per maand, ${lopend.billing_interval}betaling` : 'Geen lopend abonnement'}</p>
              </div>
              <div class="kpi">
                <p class="kpi-label">Gebruikers</p>
                <p class="kpi-value">{d.members.length}</p>
                <p class="kpi-sub">{d.partners.length ? `${d.partners.length} IT-partner(s) met toegang` : 'geen IT-partner'}</p>
              </div>
              <div class="kpi">
                <p class="kpi-label">Domeinen</p>
                <p class="kpi-value">{d.domains.length}</p>
                <p class="kpi-sub">{d.domains.filter((x) => x.verified_at).length} geverifieerd</p>
              </div>
              <div class="kpi">
                <p class="kpi-label">Totaal betaald (incl. btw)</p>
                <p class="kpi-value sm">{euro(betaald)}</p>
                <p class={`kpi-sub ${mislukt ? 't-crit' : ''}`}>{mislukt ? `${mislukt}× mislukt` : 'geen mislukte betalingen'}</p>
              </div>
            </section>
            <div class="cols">
              <section class="card">
                <h2>Abonnement</h2>
                {s ? (
                  <dl class="facts">
                    <dt>Pakket</dt>
                    <dd>
                      {planName(catalog, s.plan)} <SubStatus status={s.status} />
                    </dd>
                    <dt>Prijs</dt>
                    <dd>
                      {euro(s.monthly_price_cents)} per maand excl. btw, betaald per {s.billing_interval}
                    </dd>
                    {s.trial_ends_at ? (
                      <>
                        <dt>Proef tot</dt>
                        <dd>{datum(s.trial_ends_at)}</dd>
                      </>
                    ) : null}
                    {s.current_period_end ? (
                      <>
                        <dt>Huidige periode</dt>
                        <dd>
                          {datum(s.current_period_start)} t/m {datum(s.current_period_end)}
                          {s.cancel_at_period_end ? ' (stopt daarna)' : ''}
                        </dd>
                      </>
                    ) : null}
                    <dt>Afgesloten</dt>
                    <dd>{datum(s.created_at)}</dd>
                  </dl>
                ) : (
                  <Empty title="Geen abonnement" />
                )}
              </section>
              <section class="card">
                <h2>Factuurgegevens</h2>
                <dl class="facts">
                  <dt>Naam</dt>
                  <dd>{d.org.billing_name || d.org.name}</dd>
                  <dt>E-mail</dt>
                  <dd>{d.org.billing_email || '—'}</dd>
                  <dt>Adres</dt>
                  <dd>
                    {d.org.billing_address ? `${d.org.billing_address}, ${d.org.billing_postcode ?? ''} ${d.org.billing_city ?? ''}` : '—'} ({d.org.billing_country})
                  </dd>
                  <dt>KvK</dt>
                  <dd>{d.org.kvk_number || '—'}</dd>
                  <dt>Land</dt>
                  <dd>
                    {EU_VAT_FORMATS[d.org.billing_country]?.naam ?? d.org.billing_country}
                    {d.org.billing_country === 'NL' ? '' : EU_VAT_FORMATS[d.org.billing_country] ? ' (EU)' : ' (buiten de EU)'}
                  </dd>
                  <dt>Btw-nummer</dt>
                  <dd>{d.org.vat_number || '—'}</dd>
                  <dt>Btw</dt>
                  <dd>
                    {btw.verlegd ? <Status kind="ok">Verlegd, 0%</Status> : <Status kind={btw.vanToepassing && d.org.vat_number ? 'warn' : 'info'}>{`${ctx.cockpit.p.catalog.btwPercentage}%`}</Status>}
                  </dd>
                  {btw.vanToepassing ? (
                    <>
                      <dt>VIES</dt>
                      <dd>
                        {btw.laatsteControle ? (
                          <>
                            {btw.laatsteControle.status === 'geldig' ? 'Geldig' : btw.laatsteControle.status === 'ongeldig' ? 'Ongeldig' : 'Storing'} op{' '}
                            {datumTijd(btw.laatsteControle.checkedAt)}
                            {btw.laatsteControle.requestIdentifier ? ` · consultatienummer ${btw.laatsteControle.requestIdentifier}` : ' · geen consultatienummer (btw-nummer Qbicle ontbreekt)'}
                            {btw.laatsteControle.traderName ? ` · ${btw.laatsteControle.traderName}` : ''}
                            {btw.laatsteControle.error ? ` · ${btw.laatsteControle.error}` : ''}
                          </>
                        ) : (
                          'Nog niet gecontroleerd'
                        )}
                      </dd>
                    </>
                  ) : null}
                </dl>
                {btw.melding ? <p class="melding warn">{datum(btw.melding.at)}: {btw.melding.tekst}</p> : null}
                {btw.vanToepassing && d.org.vat_number && can(staff.role, 'facturatie.beheren') ? (
                  <form class="stack" data-api={`/api/klanten/${id}/btw-controle`}>
                    <FormError />
                    <div>
                      <button class="btn secondary" type="submit">
                        Opnieuw controleren bij VIES
                      </button>
                    </div>
                  </form>
                ) : null}
              </section>
            </div>
          </>
        );
      } else if (tab === 'gebruikers') {
        body = (
          <section class="card">
            {d.members.length === 0 ? (
              <Empty title="Geen gebruikers" />
            ) : (
              <div class="table-wrap">
                <table class="table">
                  <thead>
                    <tr>
                      <th>Gebruiker</th>
                      <th>Rol</th>
                      <th>Laatst ingelogd</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.members.map((m) => (
                      <tr>
                        <td>
                          <a href={`/gebruikers/${m.user_id}`}>{m.display_name || m.email}</a>
                          {m.display_name ? <span class="sub">{m.email}</span> : null}
                        </td>
                        <td>{m.role}</td>
                        <td class="nowrap">{m.last_login_at ? datumTijd(m.last_login_at) : 'Nooit'}</td>
                        <td>{m.disabled_at ? <Status kind="crit">Geblokkeerd</Status> : <Status kind="ok">Actief</Status>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {d.partners.length ? (
              <p class="small">
                IT-partners met toegang: {d.partners.map((p) => `${p.name} (${p.access})`).join(', ')}
              </p>
            ) : null}
          </section>
        );
      } else if (tab === 'domeinen') {
        body = (
          <section class="card">
            {d.domains.length === 0 ? (
              <Empty title="Nog geen domeinen toegevoegd" />
            ) : (
              <div class="table-wrap">
                <table class="table">
                  <thead>
                    <tr>
                      <th>Domein</th>
                      <th>Verificatie</th>
                      <th>Toegevoegd</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.domains.map((x) => (
                      <tr>
                        <td>
                          <code>{x.name}</code>
                        </td>
                        <td>
                          {x.verified_at ? (
                            <Status kind="ok">{x.verification_method === 'dns-txt' ? 'DNS' : 'E-mail'}</Status>
                          ) : (
                            <Status kind="warn">Niet geverifieerd</Status>
                          )}
                        </td>
                        <td class="nowrap">{datum(x.created_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        );
      } else if (tab === 'facturatie') {
        const ps = await getPaymentSettings(q, id);
        const magBetaal = can(staff.role, 'facturatie.beheren');
        body = (
          <>
            <section class="card">
              <div class="card-head">
                <h2>Betaalwijze</h2>
                <span class="small">Standaard automatische incasso. Factuur alleen bij een afspraak (corporate of klantspecifiek project).</span>
              </div>
              {magBetaal ? (
                <form class="stack betaalwijze" data-api={`/api/klanten/${id}/betaalwijze`}>
                  <FormError />
                  <div class="row">
                    {PAYMENT_METHODS.map((m) => (
                      <label class="radio">
                        <input type="radio" name="methode" value={m} checked={ps.payment_method === m} />
                        {m === 'incasso' ? 'Automatische incasso (standaard)' : 'Factuur op rekening'}
                      </label>
                    ))}
                  </div>
                  <div class="row">
                    <label>
                      Betaaltermijn factuur (dagen)
                      <input type="number" name="termijnDagen" min={0} max={90} value={String(ps.payment_terms_days)} data-getal />
                    </label>
                    <label class="grow">
                      Afspraak of reden (verplicht bij factuur)
                      <input type="text" name="notitie" maxlength={400} value={ps.payment_method_note ?? ''} placeholder="Bijv. raamovereenkomst, inkoopordernummer verplicht" />
                    </label>
                  </div>
                  <div>
                    <button class="btn" type="submit">
                      Opslaan
                    </button>
                  </div>
                </form>
              ) : (
                <dl class="facts">
                  <dt>Betaalwijze</dt>
                  <dd>{METHOD_LABEL[ps.payment_method]}</dd>
                  <dt>Termijn</dt>
                  <dd>{ps.payment_terms_days} dagen</dd>
                  {ps.payment_method_note ? (
                    <>
                      <dt>Afspraak</dt>
                      <dd>{ps.payment_method_note}</dd>
                    </>
                  ) : null}
                </dl>
              )}
            </section>
            <div class="cols">
              <section class="card">
                <h2>Betalingen</h2>
                {d.payments.length === 0 ? (
                  <Empty title="Nog geen betalingen" />
                ) : (
                  <div class="table-wrap">
                    <table class="table">
                      <thead>
                        <tr>
                          <th>Omschrijving</th>
                          <th>Status</th>
                          <th class="num">Bedrag</th>
                          <th class="num">Datum</th>
                        </tr>
                      </thead>
                      <tbody>
                        {d.payments.map((p) => (
                          <tr>
                            <td>
                              {p.description}
                              {p.provider === 'nep' ? <span class="tag">test</span> : null}
                            </td>
                            <td>
                              <PayStatusFull status={p.status} refundedAt={p.refunded_at} />
                            </td>
                            <td class="num">{euro(p.amount_incl_cents)}</td>
                            <td class="num">{datum(p.created_at)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
              <section class="card">
                <h2>Facturen</h2>
                {d.invoices.length === 0 ? (
                  <Empty title="Nog geen facturen" />
                ) : (
                  <ul class="feed">
                    {d.invoices.map((i) => (
                      <li>
                        <b>
                          {i.number} · {euro(i.amount_incl_cents)}
                        </b>
                        <span>{datum(i.issued_at)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          </>
        );
      } else if (tab === 'notities') {
        const notes = await listNotes(q, id);
        body = (
          <div class="cols">
            <section class="card">
              <h2>Notities</h2>
              {notes.length === 0 ? (
                <Empty title="Nog geen notities">Afspraken, belnotities en bijzonderheden. Alleen zichtbaar voor Qbicle.</Empty>
              ) : (
                <ul class="feed notes">
                  {notes.map((n) => (
                    <li>
                      <p class="note">{n.body}</p>
                      <span>
                        {n.source === 'agent' ? 'Agent' : (n.author_email ?? 'Systeem')} · {datumTijd(n.created_at)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            {can(staff.role, 'klanten.beheren') ? (
              <section class="card">
                <h2>Notitie toevoegen</h2>
                <form class="stack" data-api={`/api/klanten/${id}/notities`}>
                  <FormError />
                  <label>
                    Notitie
                    <textarea name="tekst" required maxlength={4000}></textarea>
                  </label>
                  <p class="small">Notities zijn niet te wijzigen; een correctie is een nieuwe notitie.</p>
                  <div>
                    <button class="btn" type="submit">
                      Opslaan
                    </button>
                  </div>
                </form>
              </section>
            ) : null}
          </div>
        );
      } else {
        const events = await orgTimeline(q, id);
        body = (
          <section class="card">
            {events.length === 0 ? (
              <Empty title="Nog niets gebeurd" />
            ) : (
              <ul class="feed">
                {events.map((e) => (
                  <li>
                    <b>
                      {actionLabel(e.action)}
                      {e.actor.startsWith('medewerker:') ? <span class="tag">Qbicle</span> : null}
                    </b>
                    <span>
                      {e.actor_email ?? 'Systeem'} · {datumTijd(e.at)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      }

      return ctx.page(c, {
        title: d.org.name,
        active: 'klanten',
        eyebrow: `${ORG_KIND[d.org.kind] ?? d.org.kind} · klant sinds ${datum(d.org.created_at)}`,
        actions: <SubStatus status={lopend?.status ?? null} />,
        tabs: TABS.map((k) => [TAB_LABEL[k], k === 'overzicht' ? `/klanten/${id}` : `/klanten/${id}?tab=${k}`, k === tab]),
        children: body,
      });
    });

    api.post('/klanten/:id/betaalwijze', async (c) => {
      ctx.require(c, 'facturatie.beheren');
      const b = await ctx.body(
        c,
        z.object({ methode: z.enum(PAYMENT_METHODS), termijnDagen: z.number().int().min(0).max(90), notitie: z.string().max(400).nullish() }),
      );
      await setPaymentSettings(ctx.cockpit.p.pool, idParam(c.req.param('id')), b, c.get('actor'));
      return c.json({ ok: true });
    });

    api.post('/klanten/:id/btw-controle', async (c) => {
      ctx.require(c, 'facturatie.beheren');
      const check = await checkVatNumber(ctx.cockpit.p, idParam(c.req.param('id')), 'cockpit', c.get('actor'));
      if (!check) throw new PlatformError('conflict', 'Btw verleggen is voor deze klant niet van toepassing (geen btw-nummer, of land is NL of buiten de EU).');
      return c.json({ uitslag: check.status });
    });

    api.post('/klanten/:id/notities', async (c) => {
      ctx.require(c, 'klanten.beheren');
      const { tekst } = await ctx.body(c, z.object({ tekst: z.string().max(4000) }));
      const noteId = await addNote(ctx.cockpit.p.pool, idParam(c.req.param('id')), tekst, c.get('actor'));
      return c.json({ notitie: noteId }, 201);
    });
  },
};
