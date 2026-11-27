/** @jsxImportSource hono/jsx */
import { listSubscriptions, PAYMENT_METHODS, SUB_STATUSES, type PaymentMethod, type SubStatusFilter } from '../core/billing-admin.ts';
import { METHOD_LABEL, PayStatus, planName, SubStatus } from '../labels.tsx';
import { datum, Empty, euroKort, Kpi } from '../layout.tsx';
import type { CockpitModule } from '../module.ts';

const STATUS_LABEL: Record<SubStatusFilter, string> = {
  lopend: 'Lopend',
  proef: 'Proef',
  actief: 'Actief',
  achterstallig: 'Achterstallig',
  opgezegd: 'Opgezegd',
  beeindigd: 'Beëindigd',
};
const PAGE = 50;

export const abonnementen: CockpitModule = {
  key: 'abonnementen',
  nav: [{ key: 'abonnementen', label: 'Abonnementen', href: '/abonnementen', icon: 'abonnement', group: 'financien', order: 10 }],
  register({ pages }, ctx) {
    const catalog = ctx.cockpit.p.catalog;
    pages.get('/abonnementen', async (c) => {
      const st = c.req.query('status');
      const status: SubStatusFilter = (SUB_STATUSES as readonly string[]).includes(st ?? '') ? (st as SubStatusFilter) : 'lopend';
      const m = c.req.query('methode');
      const methode: PaymentMethod | null = (PAYMENT_METHODS as readonly string[]).includes(m ?? '') ? (m as PaymentMethod) : null;
      const zoek = c.req.query('zoek') ?? '';
      const pagina = Math.max(1, Number(c.req.query('pagina')) || 1);
      const { rows, total, mrrCents } = await listSubscriptions(ctx.cockpit.p.pool, { status, methode, zoek, limit: PAGE, offset: (pagina - 1) * PAGE });
      const link = (o: { status?: SubStatusFilter; methode?: PaymentMethod | null; pagina?: number }) => {
        const s = o.status ?? status;
        const me = o.methode === undefined ? methode : o.methode;
        const u = new URLSearchParams({
          ...(s !== 'lopend' ? { status: s } : {}),
          ...(me ? { methode: me } : {}),
          ...(zoek ? { zoek } : {}),
          ...(o.pagina ? { pagina: String(o.pagina) } : {}),
        }).toString();
        return u ? `/abonnementen?${u}` : '/abonnementen';
      };
      return ctx.page(c, {
        title: 'Abonnementen',
        active: 'abonnementen',
        eyebrow: 'Financiën',
        tabs: SUB_STATUSES.map((k) => [STATUS_LABEL[k], link({ status: k }), k === status]),
        children: (
          <>
            <section class="kpis">
              <Kpi label="Abonnementen in deze lijst" value={String(total)} />
              <Kpi label="MRR in deze lijst (excl. btw)" value={euroKort(mrrCents)} sub={`ARR ${euroKort(mrrCents * 12)}`} />
            </section>
            <section class="card">
              <div class="card-head">
                <form class="filter" method="get" action="/abonnementen">
                  {status !== 'lopend' ? <input type="hidden" name="status" value={status} /> : null}
                  {methode ? <input type="hidden" name="methode" value={methode} /> : null}
                  <input type="search" name="zoek" value={zoek} placeholder="Zoek bedrijf" aria-label="Zoek bedrijf" />
                  <button class="btn secondary sm" type="submit">
                    Zoeken
                  </button>
                </form>
                <div class="seg-links" role="group" aria-label="Betaalwijze">
                  <a href={link({ methode: null })} aria-current={!methode ? 'true' : undefined}>
                    Alle betaalwijzen
                  </a>
                  {PAYMENT_METHODS.map((pm) => (
                    <a href={link({ methode: pm })} aria-current={methode === pm ? 'true' : undefined}>
                      {METHOD_LABEL[pm]}
                    </a>
                  ))}
                </div>
              </div>
              {rows.length === 0 ? (
                <Empty title="Geen abonnementen in deze selectie" />
              ) : (
                <div class="table-wrap">
                  <table class="table">
                    <thead>
                      <tr>
                        <th>Bedrijf</th>
                        <th>Pakket</th>
                        <th>Status</th>
                        <th>Betaalwijze</th>
                        <th>Laatste betaling</th>
                        <th class="num">Per maand</th>
                        <th>Loopt tot</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr>
                          <td>
                            <a href={`/klanten/${r.organization_id}?tab=facturatie`}>
                              <b>{r.organization_name}</b>
                            </a>
                          </td>
                          <td>
                            {planName(catalog, r.plan)}
                            <span class="sub">per {r.billing_interval}</span>
                          </td>
                          <td>
                            <SubStatus status={r.status} />
                          </td>
                          <td>{METHOD_LABEL[r.payment_method]}</td>
                          <td>{r.last_payment_status ? <PayStatus status={r.last_payment_status} /> : <span class="muted">—</span>}</td>
                          <td class="num">{euroKort(r.monthly_price_cents)}</td>
                          <td class="nowrap">
                            {r.status === 'proef' ? `proef tot ${datum(r.trial_ends_at)}` : datum(r.current_period_end) || '—'}
                            {r.cancel_at_period_end ? <span class="sub">stopt daarna</span> : null}
                          </td>
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
                    {pagina > 1 ? <a class="btn secondary sm" href={link({ pagina: pagina - 1 })}>Vorige</a> : null}
                    {pagina * PAGE < total ? <a class="btn secondary sm" href={link({ pagina: pagina + 1 })}>Volgende</a> : null}
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
