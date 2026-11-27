/** @jsxImportSource hono/jsx */
import { listPayments, PAY_FILTERS, type PayFilter } from '../core/billing-admin.ts';
import { METHOD_LABEL, PayStatusFull } from '../labels.tsx';
import { datum, Empty, euro, Kpi } from '../layout.tsx';
import type { CockpitModule } from '../module.ts';

const LABEL: Record<PayFilter, string> = {
  alle: 'Alle',
  open: 'Openstaand',
  betaald: 'Betaald',
  mislukt: 'Mislukt',
  terugbetaald: 'Terugbetaald',
};
const PAGE = 50;

export const facturen: CockpitModule = {
  key: 'facturen',
  nav: [{ key: 'facturen', label: 'Facturen', href: '/facturen', icon: 'factuur', group: 'financien', order: 30 }],
  register({ pages }, ctx) {
    pages.get('/facturen', async (c) => {
      const st = c.req.query('status');
      const status: PayFilter = (PAY_FILTERS as readonly string[]).includes(st ?? '') ? (st as PayFilter) : 'alle';
      const zoek = c.req.query('zoek') ?? '';
      const pagina = Math.max(1, Number(c.req.query('pagina')) || 1);
      const { rows, total, totals } = await listPayments(ctx.cockpit.p.pool, { status, zoek, limit: PAGE, offset: (pagina - 1) * PAGE });
      const link = (s: PayFilter, p?: number) => {
        const u = new URLSearchParams({ ...(s !== 'alle' ? { status: s } : {}), ...(zoek ? { zoek } : {}), ...(p ? { pagina: String(p) } : {}) }).toString();
        return u ? `/facturen?${u}` : '/facturen';
      };
      return ctx.page(c, {
        title: 'Facturen en betalingen',
        active: 'facturen',
        eyebrow: 'Financiën',
        tabs: PAY_FILTERS.map((k) => [LABEL[k], link(k), k === status]),
        children: (
          <>
            <section class="kpis">
              <Kpi label="Openstaand (incl. btw)" value={euro(totals.open)} tone={totals.open ? 'warn' : undefined} href={link('open')} />
              <Kpi label="Betaald (incl. btw)" value={euro(totals.betaald)} href={link('betaald')} />
              <Kpi label="Mislukt (incl. btw)" value={euro(totals.mislukt)} sub={totals.mislukt ? 'zie Incasso’s voor vervolgacties' : undefined} tone={totals.mislukt ? 'crit' : undefined} href={link('mislukt')} />
              <Kpi label="Terugbetaald" value={euro(totals.terugbetaald)} href={link('terugbetaald')} />
            </section>
            <section class="card">
              <div class="card-head">
                <form class="filter" method="get" action="/facturen">
                  {status !== 'alle' ? <input type="hidden" name="status" value={status} /> : null}
                  <input type="search" name="zoek" value={zoek} placeholder="Bedrijf, factuurnummer of omschrijving" aria-label="Zoek factuur" />
                  <button class="btn secondary sm" type="submit">
                    Zoeken
                  </button>
                </form>
                <span class="small">{total === 1 ? '1 regel' : `${total} regels`}</span>
              </div>
              {rows.length === 0 ? (
                <Empty title="Geen facturen of betalingen in deze selectie" />
              ) : (
                <div class="table-wrap">
                  <table class="table">
                    <thead>
                      <tr>
                        <th>Factuur</th>
                        <th>Bedrijf</th>
                        <th>Omschrijving</th>
                        <th>Status</th>
                        <th>Betaalwijze</th>
                        <th class="num">Bedrag</th>
                        <th class="num">Datum</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr>
                          <td class="nowrap">{r.invoice_number ? <code>{r.invoice_number}</code> : <span class="muted">nog geen</span>}</td>
                          <td>
                            <a href={`/klanten/${r.organization_id}?tab=facturatie`}>{r.organization_name}</a>
                          </td>
                          <td>
                            {r.description}
                            {r.provider === 'nep' ? <span class="tag">test</span> : null}
                          </td>
                          <td>
                            <PayStatusFull status={r.status} refundedAt={r.refunded_at} refundedCents={r.refunded_cents} amountCents={r.amount_incl_cents} />
                          </td>
                          <td>{METHOD_LABEL[r.payment_method]}</td>
                          <td class="num">{euro(r.amount_incl_cents)}</td>
                          <td class="num">{datum(r.paid_at ?? r.created_at)}</td>
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
                    {pagina > 1 ? <a class="btn secondary sm" href={link(status, pagina - 1)}>Vorige</a> : null}
                    {pagina * PAGE < total ? <a class="btn secondary sm" href={link(status, pagina + 1)}>Volgende</a> : null}
                  </div>
                </div>
              ) : null}
            </section>
          </>
        ),
      });
    });
  },
};
