/** @jsxImportSource hono/jsx */
import {
  aiUsageByFeature,
  detectUsageSignals,
  effectiveLimits,
  LIMIT_METRICS,
  limitStatus,
  opsAudit,
  setLimitOverride,
  usageOverview,
  usageTrend,
  type LimitMetric,
} from '@qbicle/ops';
import { notFound, one } from '@qbicle/platform';
import { z } from 'zod';
import { Bars, Meter } from '../charts.tsx';
import { opsActor, opsContext, getal, getalKort, microEuro, periode } from '../core/ops.ts';
import { can } from '../core/roles.ts';
import { Empty, euroKort, FormError, Kpi, Status } from '../layout.tsx';
import type { CockpitModule } from '../module.ts';

export const LIMIT_LABEL: Record<LimitMetric, string> = {
  scans_maand: 'Scans deze maand',
  api_dag: 'API-aanroepen vandaag',
  ai_tokens_maand: 'AI-tokens deze maand',
  ai_kosten_maand: 'AI-kosten deze maand',
};

const fmtLimit = (m: LimitMetric, v: number) => (m === 'ai_kosten_maand' ? microEuro(Math.round(v * 1e6)) : getal(v));

const uuid = z.uuid();
const schemas = {
  limiet: z.object({
    metric: z.enum(LIMIT_METRICS),
    // Leeg = onbeperkt.
    waarde: z.number().min(0).max(1e12).nullable(),
    reden: z.string().trim().min(3).max(400),
  }),
};

export const gebruik: CockpitModule = {
  key: 'gebruik',
  nav: [{ key: 'gebruik', label: 'Gebruik', href: '/gebruik', icon: 'gebruik', group: 'techniek', order: 10 }],
  register({ pages, api }, ctx) {
    const ops = () => opsContext(ctx.cockpit);

    pages.get('/gebruik', async (c) => {
      const per = periode(c.req.query('periode'));
      const zoek = (c.req.query('zoek') ?? '').trim().toLowerCase();
      const [rows, trend, features, signals] = await Promise.all([
        usageOverview(ops(), per.from, per.to),
        usageTrend(ops().pool, null, 30),
        aiUsageByFeature(ops().pool, null, 30),
        detectUsageSignals(ops()),
      ]);
      const shown = zoek ? rows.filter((r) => r.name.toLowerCase().includes(zoek)) : rows;
      const sum = (f: (r: (typeof rows)[number]) => number) => rows.reduce((a, r) => a + f(r), 0);
      const mrr = sum((r) => r.mrr_cents);
      const cost = sum((r) => r.cost_micros);
      const tab = (key: string, label: string): [string, string, boolean] => [label, `/gebruik?periode=${key}`, per.key === key];
      return ctx.page(c, {
        title: 'Gebruik',
        active: 'gebruik',
        eyebrow: 'Techniek en support',
        tabs: [tab('maand', 'Deze maand'), tab('vorige', 'Vorige maand'), tab('30d', 'Laatste 30 dagen')],
        children: (
          <>
            <section class="kpis" aria-label="Gebruik">
              <Kpi label="AI-kosten" value={microEuro(sum((r) => r.ai_cost_micros))} sub={`${getalKort(sum((r) => r.ai_tokens))} tokens, ${per.label}`} />
              <Kpi label="Scans" value={getal(sum((r) => r.scans))} sub={`${getal(sum((r) => r.scans_mislukt))} mislukt`} tone={sum((r) => r.scans_mislukt) ? 'warn' : 'ok'} href="/gezondheid" />
              <Kpi label="API-aanroepen" value={getalKort(sum((r) => r.api_calls))} sub={`${getal(sum((r) => r.assets))} assets in beeld`} />
              <Kpi
                label="Marge (MRR min kosten)"
                value={euroKort(mrr - Math.round(cost / 10_000))}
                sub={`MRR ${euroKort(mrr)}, kosten ${microEuro(cost)}`}
                tone={mrr - cost / 10_000 < 0 ? 'crit' : 'ok'}
              />
            </section>

            <div class="cols">
              <section class="card">
                <div class="card-head">
                  <h2>AI-kosten per dag</h2>
                  <span class="small">Hele platform, laatste 30 dagen</span>
                </div>
                <Bars title="AI-kosten per dag in euro" points={trend.map((t) => ({ label: t.day, value: t.ai_cost_micros }))} format={microEuro} />
              </section>
              <section class="card">
                <div class="card-head">
                  <h2>Signalen</h2>
                  <a class="small" href="/agents">Voorstellen</a>
                </div>
                {signals.length === 0 ? (
                  <Empty title="Geen afwijkend gebruik">Klanten die hun limiet naderen of plots veel meer gebruiken, verschijnen hier.</Empty>
                ) : (
                  <ul class="feed">
                    {signals.slice(0, 12).map((s) => (
                      <li>
                        <b>
                          <a href={`/gebruik/${s.organizationId}`}>{s.organizationName}</a>{' '}
                          <Status kind={s.kind === 'limiet_over' ? 'crit' : s.kind === 'limiet_bijna' ? 'warn' : 'info'}>
                            {s.kind === 'limiet_over' ? 'Over limiet' : s.kind === 'limiet_bijna' ? 'Bijna limiet' : 'Afwijkend'}
                          </Status>
                        </b>
                        <span>{s.message}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>

            <section class="card">
              <div class="card-head">
                <h2>Per klant</h2>
                <form class="filter" method="get" action="/gebruik">
                  <input type="hidden" name="periode" value={per.key} />
                  <input type="search" name="zoek" value={zoek} placeholder="Zoek bedrijf" aria-label="Zoek bedrijf" />
                  <button class="btn secondary sm" type="submit">
                    Zoeken
                  </button>
                </form>
              </div>
              {shown.length === 0 ? (
                <Empty title="Nog geen gebruik" />
              ) : (
                <div class="table-wrap">
                  <table class="table">
                    <thead>
                      <tr>
                        <th>Bedrijf</th>
                        <th>Pakket</th>
                        <th class="num">Assets</th>
                        <th class="num">Scans</th>
                        <th class="num">API</th>
                        <th class="num">AI-tokens</th>
                        <th class="num">AI-kosten</th>
                        <th class="num">MRR</th>
                        <th class="num">Marge</th>
                      </tr>
                    </thead>
                    <tbody>
                      {shown.map((r) => (
                        <tr>
                          <td>
                            <a href={`/gebruik/${r.organization_id}`}>{r.name}</a>
                          </td>
                          <td>{r.plan}</td>
                          <td class="num">{getal(r.assets)}</td>
                          <td class="num">
                            {getal(r.scans)}
                            {r.scans_mislukt ? <span class="sub">{r.scans_mislukt} mislukt</span> : null}
                          </td>
                          <td class="num">{getalKort(r.api_calls)}</td>
                          <td class="num">{getalKort(r.ai_tokens)}</td>
                          <td class="num">{microEuro(r.ai_cost_micros)}</td>
                          <td class="num">{euroKort(r.mrr_cents)}</td>
                          <td class="num">{r.mrr_cents === 0 && r.cost_micros > 0 ? <span class="muted">{euroKort(r.margin_cents)}</span> : euroKort(r.margin_cents)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p class="small">Kosten = AI (werkelijke tokens) + scans en mail tegen een vaste kostprijs uit config/gebruik.json. Marge is alleen zinvol per maand.</p>
            </section>

            <section class="card">
              <div class="card-head">
                <h2>AI per functie</h2>
                <span class="small">Laatste 30 dagen</span>
              </div>
              {features.length === 0 ? (
                <Empty title="Nog geen AI-aanroepen" />
              ) : (
                <FeatureTable rows={features} />
              )}
            </section>
          </>
        ),
      });
    });

    pages.get('/gebruik/:org', async (c) => {
      const orgId = c.req.param('org');
      if (!uuid.safeParse(orgId).success) throw notFound('Dit bedrijf');
      const org = await one<{ name: string }>(ops().pool, 'SELECT name FROM organization WHERE id = $1', [orgId]);
      if (!org) throw notFound('Dit bedrijf');
      const [limits, eff, trend, features] = await Promise.all([
        limitStatus(ops(), orgId),
        effectiveLimits(ops(), orgId),
        usageTrend(ops().pool, orgId, 30),
        aiUsageByFeature(ops().pool, orgId, 30),
      ]);
      const mag = can(c.get('staff').role, 'facturatie.beheren');
      return ctx.page(c, {
        title: org.name,
        active: 'gebruik',
        eyebrow: `Gebruik · pakket ${eff.plan}`,
        actions: (
          <a class="btn secondary sm" href="/gebruik">
            Terug naar overzicht
          </a>
        ),
        children: (
          <>
            <section class="card">
              <div class="card-head">
                <h2>Limieten</h2>
                <span class="small">{eff.overrides.length ? 'Met afwijkende limiet voor deze klant' : `Standaard voor pakket ${eff.plan}`}</span>
              </div>
              <div class="limits">
                {limits.map((l) => {
                  const tone = l.status === 'over' ? 'crit' : l.status === 'waarschuwing' ? 'warn' : 'ok';
                  return (
                    <div class="limit">
                      <div class="limit-head">
                        <b>{LIMIT_LABEL[l.metric]}</b>
                        <span>
                          {fmtLimit(l.metric, l.used)} / {l.limit === null ? 'onbeperkt' : fmtLimit(l.metric, l.limit)}
                          {eff.overrides.includes(l.metric) ? <span class="tag">maatwerk</span> : null}
                        </span>
                      </div>
                      <Meter pct={l.pct} tone={tone} label={`${LIMIT_LABEL[l.metric]}: ${l.pct ?? 0}%`} />
                    </div>
                  );
                })}
              </div>
            </section>

            <section class="card">
              <div class="card-head">
                <h2>AI-tokens per dag</h2>
                <span class="small">Laatste 30 dagen</span>
              </div>
              <Bars title="AI-tokens per dag" points={trend.map((t) => ({ label: t.day, value: t.ai_tokens }))} format={getalKort} />
              <Bars title="Scans per dag" points={trend.map((t) => ({ label: t.day, value: t.scans }))} format={getal} />
            </section>

            <section class="card">
              <h2>AI per functie</h2>
              {features.length === 0 ? <Empty title="Nog geen AI-aanroepen" /> : <FeatureTable rows={features} />}
            </section>

            {mag ? (
              <section class="card narrow">
                <h2>Limiet aanpassen</h2>
                <form class="stack" data-api={`/api/gebruik/${orgId}/limiet`}>
                  <FormError />
                  <label>
                    Limiet
                    <select name="metric">
                      {LIMIT_METRICS.map((m) => (
                        <option value={m}>{LIMIT_LABEL[m]}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Nieuwe waarde (leeg = onbeperkt; kosten in euro)
                    <input type="number" name="waarde" min="0" step="any" data-getal />
                  </label>
                  <label>
                    Reden (komt in het audit-log)
                    <input type="text" name="reden" required maxlength={400} />
                  </label>
                  <div>
                    <button class="btn" type="submit">
                      Opslaan
                    </button>
                  </div>
                </form>
              </section>
            ) : null}
          </>
        ),
      });
    });

    api.post('/gebruik/:org/limiet', async (c) => {
      ctx.require(c, 'facturatie.beheren');
      const orgId = c.req.param('org');
      if (!uuid.safeParse(orgId).success) throw notFound('Dit bedrijf');
      const b = await ctx.body(c, schemas.limiet);
      const exists = await one(ops().pool, 'SELECT 1 FROM organization WHERE id = $1', [orgId]);
      if (!exists) throw notFound('Dit bedrijf');
      const actor = opsActor(c);
      await setLimitOverride(ops().pool, { organizationId: orgId, metric: b.metric, limit: b.waarde, reason: b.reden, setBy: actor.userId });
      await opsAudit(ops().pool, actor, { action: 'ops.limiet_gewijzigd', organizationId: orgId, detail: { limiet: b.metric, waarde: b.waarde, reden: b.reden } });
      return c.json({ ok: true });
    });
  },
};

function FeatureTable(props: { rows: Awaited<ReturnType<typeof aiUsageByFeature>> }) {
  return (
    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>Functie</th>
            <th>Model</th>
            <th class="num">Aanroepen</th>
            <th class="num">Mislukt</th>
            <th class="num">Invoer</th>
            <th class="num">Uitvoer</th>
            <th class="num">Kosten</th>
            <th class="num">Gem. duur</th>
          </tr>
        </thead>
        <tbody>
          {props.rows.map((f) => (
            <tr>
              <td>{f.feature}</td>
              <td class="muted">{f.model}</td>
              <td class="num">{getal(f.calls)}</td>
              <td class="num">{f.failed ? <Status kind="warn">{String(f.failed)}</Status> : '0'}</td>
              <td class="num">{getalKort(f.input_tokens)}</td>
              <td class="num">{getalKort(f.output_tokens)}</td>
              <td class="num">{microEuro(f.cost_micros)}</td>
              <td class="num">{f.avg_duration_ms === null ? '—' : `${(f.avg_duration_ms / 1000).toFixed(1)} s`}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
