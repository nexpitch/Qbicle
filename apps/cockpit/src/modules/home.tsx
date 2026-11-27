/** @jsxImportSource hono/jsx */
import { getAttention, getKpis, listCockpitAudit, type AttentionItem } from '../core/overview.ts';
import { datum, datumTijd, Empty, euroKort, Kpi, Status, type StatusKind } from '../layout.tsx';
import type { CockpitModule } from '../module.ts';
import { actionLabel } from './audit.tsx';
import { planName } from '../labels.tsx';

const ATTENTION: Record<AttentionItem['kind'], [string, StatusKind]> = {
  betaling_mislukt: ['Betaling mislukt', 'crit'],
  achterstallig: ['Achterstallig', 'warn'],
  proef_loopt_af: ['Proef loopt af', 'info'],
  btw_verlegd_gestopt: ['Btw verlegd gestopt', 'warn'],
};

export const home: CockpitModule = {
  key: 'home',
  nav: [{ key: 'home', label: 'Overzicht', href: '/', icon: 'home', group: 'start' }],
  register({ pages }, ctx) {
    pages.get('/', async (c) => {
      const q = ctx.cockpit.p.pool;
      const [k, attention, recent] = await Promise.all([getKpis(q), getAttention(q), listCockpitAudit(q, { limit: 8 })]);
      const staff = c.get('staff');
      const kort = staff.user.email.split('@')[0] ?? '';
      const naam = staff.user.displayName || kort.charAt(0).toUpperCase() + kort.slice(1);
      return ctx.page(c, {
        title: `${groet()}, ${naam}`,
        active: 'home',
        eyebrow: new Date().toLocaleDateString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Europe/Amsterdam' }),
        children: (
          <>
            <section class="kpis" aria-label="Kerncijfers">
              <Kpi label="Klanten" value={String(k.klanten)} sub={`${k.nieuwDezeMaand} nieuw deze maand`} href="/klanten" />
              <Kpi label="MRR (excl. btw)" value={euroKort(k.mrrCents)} sub={`ARR ${euroKort(k.mrrCents * 12)}`} href="/abonnementen" />
              <Kpi label="Actieve abonnementen" value={String(k.actief)} sub={`${k.proef} in proefperiode`} href="/abonnementen" />
              <Kpi
                label="Mislukte betalingen"
                value={String(k.mislukt30d)}
                sub={k.achterstallig ? `${k.achterstallig} achterstallig` : 'laatste 30 dagen'}
                tone={k.mislukt30d || k.achterstallig ? 'crit' : 'ok'}
                href="/incasso/mislukt"
              />
            </section>

            <div class="cols">
              <section class="card">
                <div class="card-head">
                  <h2>Aandacht nodig</h2>
                  <span class="small">Agents bereiden vervolgacties voor; jij beslist.</span>
                </div>
                {attention.length === 0 ? (
                  <Empty title="Niets dat nu aandacht vraagt">Mislukte betalingen, achterstallige abonnementen en aflopende proeven verschijnen hier.</Empty>
                ) : (
                  <div class="table-wrap">
                    <table class="table">
                      <thead>
                        <tr>
                          <th>Bedrijf</th>
                          <th>Wat</th>
                          <th>Detail</th>
                          <th class="num">Datum</th>
                        </tr>
                      </thead>
                      <tbody>
                        {attention.map((a) => (
                          <tr>
                            <td>
                              <a href={`/klanten/${a.organizationId}`}>{a.organizationName}</a>
                            </td>
                            <td>
                              <Status kind={ATTENTION[a.kind][1]}>{ATTENTION[a.kind][0]}</Status>
                            </td>
                            <td class="muted">{a.kind === 'betaling_mislukt' || a.kind === 'btw_verlegd_gestopt' ? a.detail : planName(ctx.cockpit.p.catalog, a.detail)}</td>
                            <td class="num">{datum(a.at)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>

              <section class="card">
                <div class="card-head">
                  <h2>Laatste beheeracties</h2>
                  <a class="small" href="/audit">Alles bekijken</a>
                </div>
                {recent.length === 0 ? (
                  <Empty title="Nog geen beheeracties" />
                ) : (
                  <ul class="feed">
                    {recent.map((r) => (
                      <li>
                        <b>{actionLabel(r.action)}</b>
                        <span>
                          {r.actor_email ?? (r.actor === 'systeem' ? 'Systeem' : r.actor)} · {datumTijd(r.at)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          </>
        ),
      });
    });
  },
};

function groet(): string {
  const uur = Number(new Date().toLocaleString('nl-NL', { hour: 'numeric', hour12: false, timeZone: 'Europe/Amsterdam' }));
  if (uur < 6) return 'Goedenacht';
  if (uur < 12) return 'Goedemorgen';
  if (uur < 18) return 'Goedemiddag';
  return 'Goedenavond';
}
