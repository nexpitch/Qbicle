/** @jsxImportSource hono/jsx */
import type {
  AssetDetail,
  AssetFindingDetail,
  BillingOverview,
  Dashboard,
  DashboardAction,
  DashboardAsset,
  Domain,
  DomainScanInfo,
  Level,
  TrendPoint,
} from '@qbicle/platform';
import { ASSET_GROUPS, FOR_WHO_LABELS } from '@qbicle/platform';
import { datum, FormError, Layout, Status, type NavOrg, type PageUser } from '../layout.tsx';
import { DomeinScanBlok } from './scan.tsx';

/**
 * Het klantdashboard (Licht-stijl): eerst één heldere volgende stap, dan vier
 * kerncijfers, de acties in gewone taal, de trend, wat er veranderde, en alle
 * assets per soort. Alles server-side; geen inline stijl of script (CSP).
 */

type Ctx = { user: PageUser; org: NavOrg };

const LEVEL_LABEL: Record<Level, string> = { crit: 'Urgent', warn: 'Aandacht', unk: 'Onbekend', ok: 'In orde' };
const CERTAINTY_LABEL: Record<string, string> = {
  vastgesteld: 'Vastgesteld',
  opgegeven: 'Door jou opgegeven',
  mogelijk: 'Mogelijk',
  onbekend: 'Niet vast te stellen',
};
const CERTAINTY_UITLEG: Record<string, string> = {
  vastgesteld: 'We hebben dit zelf gezien.',
  opgegeven: 'Dit heb je zelf aan ons doorgegeven.',
  mogelijk: 'We zien sterke aanwijzingen, maar konden het niet helemaal vaststellen.',
  onbekend: 'We konden dit niet controleren. Dat betekent niet dat het in orde is.',
};
const EXPOSURE_LABEL: Record<string, string> = {
  internet: 'Bereikbaar vanaf internet',
  cloud: 'In de cloud',
  intern: 'Alleen in het eigen netwerk',
  onbekend: 'Onbekend',
};

function bandLevel(key: string): Level {
  return key === 'direct' || key === 'hoog' ? 'crit' : key === 'aandacht' ? 'warn' : 'ok';
}

function kort(d: Date | string): string {
  return new Date(d).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', timeZone: 'Europe/Amsterdam' });
}

function wanneer(d: Date | string, now = new Date()): string {
  const days = Math.floor((now.getTime() - new Date(d).getTime()) / 86400000);
  if (days <= 0) return 'vandaag';
  if (days === 1) return 'gisteren';
  if (days < 7) return `${days} dagen geleden`;
  return kort(d);
}

// Dashboard ---------------------------------------------------------------------------------

export function DashboardPage(props: Ctx & { d: Dashboard; b: BillingOverview | null; demo: boolean }) {
  const { d, org, b } = props;
  const base = `/o/${org.id}`;
  return (
    <Layout title="Overzicht" user={props.user} org={org} active="overzicht">
      <div class="dash-head">
        <div class="intro">
          <p class="eyebrow">Overzicht</p>
          <h1>{org.name}</h1>
          <p class="small">
            {d.lastScanAt ? `Laatst bijgewerkt ${wanneer(d.lastScanAt)}` : 'Nog geen scan afgerond'}
            {d.coverage ? ` · ${d.coverage.pct}% gecontroleerd` : ''}
          </p>
        </div>
      </div>

      {b?.toegang === 'betaling_nodig' ? (
        <p class="melding warn">
          Je proef is voorbij.{' '}
          {b.magBeheren ? <a href={`${base}/abonnement`}>Betaal om je overzicht te houden.</a> : 'Vraag de eigenaar van het account om te betalen.'}
        </p>
      ) : null}

      <NextStepCard d={d} />

      {d.hasData ? (
        <>
          <Kpis d={d} base={base} />
          <div class="dash-cols">
            <div class="stack-lg">
              <ActionsCard actions={d.actions} base={base} />
              <TrendCard trend={d.trend} />
            </div>
            <div class="stack-lg">
              {d.meldingen.length ? <MeldingenCard d={d} /> : null}
              <ChangesCard d={d} base={base} />
              <ActivityCard d={d} />
            </div>
          </div>
          <AssetsCard d={d} base={base} />
        </>
      ) : (
        <EmptyState base={base} demo={props.demo} meldingen={d.meldingen} />
      )}
      {d.hasData && props.demo ? <DemoForm base={base} again /> : null}
    </Layout>
  );
}

function NextStepCard(props: { d: Dashboard }) {
  const s = props.d.nextStep;
  return (
    <section class="card next-step" aria-labelledby="volgende-stap">
      <p class="eyebrow">Volgende stap</p>
      <div class="next-in">
        <div class="stack-sm">
          <h2 id="volgende-stap">{s.title}</h2>
          <p class="muted">{s.text}</p>
        </div>
        <a class="btn" href={s.href}>
          {s.label}
        </a>
      </div>
    </section>
  );
}

function Delta(props: { now: number; before: number | null }) {
  if (props.before === null) return <span class="small">Nog geen vergelijking</span>;
  const diff = props.now - props.before;
  if (diff === 0) return <span class="small">Gelijk aan 30 dagen geleden</span>;
  // Lager is beter: een daling is groen.
  return (
    <span class={`delta ${diff < 0 ? 'down' : 'up'}`}>
      <span aria-hidden="true">{diff < 0 ? '▼' : '▲'}</span> {Math.abs(diff)} {diff < 0 ? 'lager' : 'hoger'} dan 30 dagen geleden
    </span>
  );
}

function Kpis(props: { d: Dashboard; base: string }) {
  const { d } = props;
  const lvl = bandLevel(d.band.key);
  return (
    <section class="kpis" aria-label="Kerncijfers">
      <div class={`kpi kpi-main lvl-${lvl}`}>
        <p class="kpi-label">Urgentie</p>
        <p class="kpi-value">
          {d.urgency}
          <span class="kpi-unit">/100</span>
        </p>
        <Status kind={lvl}>{d.band.label}</Status>
        <Delta now={d.urgency} before={d.urgencyBefore} />
      </div>
      <a class="kpi" href="#acties">
        <p class="kpi-label">Open acties</p>
        <p class="kpi-value">{d.counts.actions}</p>
        <p class="small">
          {d.counts.actionsZelf ? `${d.counts.actionsZelf} kun je zelf doen` : 'Vooral voor je IT-partner of webbouwer'}
        </p>
      </a>
      <a class="kpi" href={`${props.base}/assets`}>
        <p class="kpi-label">Assets in beeld</p>
        <p class="kpi-value">{d.counts.assets}</p>
        <p class="small">{d.counts.assetsNew ? `${d.counts.assetsNew} nieuw deze maand` : 'Geen nieuwe deze maand'}</p>
      </a>
      <a class="kpi" href="#veranderd">
        <p class="kpi-label">Opgelost</p>
        <p class="kpi-value">{d.counts.resolved}</p>
        <p class="small">
          in 30 dagen · {d.counts.new} nieuw gevonden
        </p>
      </a>
    </section>
  );
}

function ActionRow(props: { a: DashboardAction; i: number; base: string }) {
  const { a } = props;
  return (
    <li class="action">
      <span class={`action-nr lvl-${a.level}`} aria-hidden="true">
        {props.i + 1}
      </span>
      <div class="stack-sm">
        <h3>{a.title}</h3>
        <p class="small">{a.why}</p>
        <div class="row tags">
          <span class="badge">{FOR_WHO_LABELS[a.forWho]}</span>
          {a.assets.slice(0, 3).map((x) => (
            <a class="tag" href={`${props.base}/assets/${x.id}`}>
              {x.label}
            </a>
          ))}
          {a.assets.length > 3 ? <span class="small">en {a.assets.length - 3} meer</span> : null}
        </div>
      </div>
      <Status kind={a.level}>{LEVEL_LABEL[a.level]}</Status>
    </li>
  );
}

function ActionsCard(props: { actions: DashboardAction[]; base: string }) {
  const top = props.actions.slice(0, 5);
  const rest = props.actions.slice(5);
  return (
    <section class="card" id="acties" aria-labelledby="acties-kop">
      <div class="row between">
        <h2 id="acties-kop">Wat je nu kunt doen</h2>
        <span class="small">belangrijkste eerst</span>
      </div>
      {top.length === 0 ? (
        <p class="melding ok">Er staat niets open. We blijven je systemen bewaken.</p>
      ) : (
        <ol class="actions">
          {top.map((a, i) => (
            <ActionRow a={a} i={i} base={props.base} />
          ))}
        </ol>
      )}
      {rest.length ? (
        <details class="more">
          <summary>Nog {rest.length} kleinere {rest.length === 1 ? 'actie' : 'acties'}</summary>
          <ol class="actions" start={6}>
            {rest.map((a, i) => (
              <ActionRow a={a} i={i + 5} base={props.base} />
            ))}
          </ol>
        </details>
      ) : null}
    </section>
  );
}

/** Eén reeks, dus geen legenda; de titel noemt hem. Lijn 2px, banden als rustige hulplijnen. */
function TrendCard(props: { trend: TrendPoint[] }) {
  const t = props.trend;
  const W = 640;
  const H = 180;
  const pad = { l: 34, r: 44, t: 12, b: 26 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const x = (i: number) => pad.l + (t.length <= 1 ? iw : (i / (t.length - 1)) * iw);
  const y = (v: number) => pad.t + ih - (v / 100) * ih;
  const path = t.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.urgency).toFixed(1)}`).join(' ');
  const area = t.length ? `${path} L${x(t.length - 1).toFixed(1)},${y(0)} L${x(0).toFixed(1)},${y(0)} Z` : '';
  const last = t.at(-1);
  const ticks = t.length > 2 ? [0, Math.floor((t.length - 1) / 2), t.length - 1] : t.map((_, i) => i);
  return (
    <section class="card" aria-labelledby="trend-kop">
      <div class="row between">
        <h2 id="trend-kop">Urgentie over tijd</h2>
        <span class="small">laatste 12 weken, lager is beter</span>
      </div>
      {t.length < 2 ? (
        <p class="small">Na de volgende scan zie je hier hoe je urgentie verandert.</p>
      ) : (
        <>
          <svg class="trend" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Urgentie van ${t[0]!.urgency} naar ${last!.urgency}`}>
            {[25, 50, 75].map((v) => (
              <g>
                <line class="trend-grid" x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} />
                <text class="trend-axis" x={pad.l - 6} y={y(v) + 4} text-anchor="end">
                  {v}
                </text>
              </g>
            ))}
            <line class="trend-base" x1={pad.l} x2={W - pad.r} y1={y(0)} y2={y(0)} />
            <path class="trend-area" d={area} />
            <path class="trend-line" d={path} />
            {ticks.map((i) => (
              <text class="trend-axis" x={x(i)} y={H - 6} text-anchor={i === 0 ? 'start' : i === t.length - 1 ? 'end' : 'middle'}>
                {kort(t[i]!.at)}
              </text>
            ))}
            {t.map((p, i) => (
              <g class="trend-pt">
                <circle class="trend-hit" cx={x(i)} cy={y(p.urgency)} r="12">
                  <title>{`${kort(p.at)}: urgentie ${p.urgency}`}</title>
                </circle>
                <circle class="trend-dot" cx={x(i)} cy={y(p.urgency)} r="4" />
              </g>
            ))}
            <circle class="trend-end" cx={x(t.length - 1)} cy={y(last!.urgency)} r="5" />
            <text class="trend-endlabel" x={x(t.length - 1) + 9} y={y(last!.urgency) + 4}>
              {last!.urgency}
            </text>
          </svg>
          <details class="more">
            <summary>Toon als tabel</summary>
            <table class="table">
              <thead>
                <tr>
                  <th>Week</th>
                  <th class="num">Urgentie</th>
                </tr>
              </thead>
              <tbody>
                {t.map((p) => (
                  <tr>
                    <td>{datum(p.at)}</td>
                    <td class="num">{p.urgency}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </>
      )}
    </section>
  );
}

function MeldingenCard(props: { d: Dashboard }) {
  return (
    <section class="card" aria-labelledby="meldingen-kop">
      <h2 id="meldingen-kop">Meldingen</h2>
      <ul class="list">
        {props.d.meldingen.map((m) => (
          <li class="list-item">
            <span class={`dot lvl-${m.level}`} aria-hidden="true"></span>
            <div class="stack-xs">
              <p>{m.text}</p>
              {m.href ? (
                <a class="small" href={m.href}>
                  {m.linkText ?? 'Bekijken'}
                </a>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ChangesCard(props: { d: Dashboard; base: string }) {
  const { d } = props;
  return (
    <section class="card" id="veranderd" aria-labelledby="veranderd-kop">
      <h2 id="veranderd-kop">Sinds vorige maand</h2>
      {d.resolved.length === 0 && d.added.length === 0 ? <p class="small">Geen veranderingen in de afgelopen 30 dagen.</p> : null}
      {d.resolved.length ? (
        <div class="stack-sm">
          <p class="kpi-label">Opgelost ({d.resolved.length})</p>
          <ul class="list">
            {d.resolved.slice(0, 5).map((r) => (
              <li class="list-item">
                <span class="check" aria-hidden="true">✓</span>
                <div class="stack-xs">
                  <p>{r.title}</p>
                  <p class="small">
                    <a href={`${props.base}/assets/${r.asset.id}`}>{r.asset.label}</a> · {wanneer(r.at)}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {d.added.length ? (
        <div class="stack-sm">
          <p class="kpi-label">Nieuw gevonden ({d.added.length})</p>
          <ul class="list">
            {d.added.slice(0, 4).map((r) => (
              <li class="list-item">
                <span class="dot lvl-warn" aria-hidden="true"></span>
                <div class="stack-xs">
                  <p>{r.title}</p>
                  <p class="small">
                    <a href={`${props.base}/assets/${r.asset.id}`}>{r.asset.label}</a> · {wanneer(r.at)}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function ActivityCard(props: { d: Dashboard }) {
  if (!props.d.activity.length) return null;
  return (
    <section class="card" aria-labelledby="activiteit-kop">
      <h2 id="activiteit-kop">Activiteit</h2>
      <ul class="timeline">
        {props.d.activity.map((a) => (
          <li>
            <span class="small">{wanneer(a.at)}</span>
            {a.href ? <a href={a.href}>{a.text}</a> : <span>{a.text}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}

function AssetTable(props: { assets: DashboardAsset[]; base: string }) {
  return (
    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>Asset</th>
            <th>Soort</th>
            <th class="hide-sm">Bereikbaar</th>
            <th class="num">Open</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {props.assets.map((a) => (
            <tr>
              <td>
                <a href={`${props.base}/assets/${a.id}`}>{a.label}</a>
              </td>
              <td>{a.typeLabel}</td>
              <td class="hide-sm">{EXPOSURE_LABEL[a.exposure] ?? a.exposure}</td>
              <td class="num">{a.openFindings}</td>
              <td>
                <Status kind={a.level}>{LEVEL_LABEL[a.level]}</Status>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AssetsCard(props: { d: Dashboard; base: string }) {
  const { d, base } = props;
  return (
    <section class="card" aria-labelledby="assets-kop">
      <div class="row between">
        <h2 id="assets-kop">Alles wat we bewaken</h2>
        <a href={`${base}/assets`}>Alle {d.counts.assets} assets</a>
      </div>
      <p class="small">Niet alleen je website: alles wat aan internet hangt en waar een incident kan beginnen.</p>
      <div class="groups">
        {d.groups.map((g) => (
          <a class={`group${g.count === 0 ? ' empty' : ''}`} href={`${base}/assets?soort=${g.key}`}>
            <span class="group-count">{g.count}</span>
            <span class="group-label">{g.label}</span>
            {g.count === 0 ? (
              <span class="small">Nog niet gekoppeld</span>
            ) : g.withIssues ? (
              <Status kind={g.level}>{g.withIssues} met aandacht</Status>
            ) : (
              <Status kind={g.level === 'unk' ? 'unk' : 'ok'}>{g.level === 'unk' ? 'Deels onbekend' : 'In orde'}</Status>
            )}
          </a>
        ))}
      </div>
      <AssetTable assets={d.assets.slice(0, 6)} base={base} />
    </section>
  );
}

function DemoForm(props: { base: string; again?: boolean }) {
  return (
    <form class={props.again ? 'demo-again' : ''} data-api={`/api/v1/organisaties${props.base.slice(2)}/demodata`}>
      <FormError />
      <button class={props.again ? 'linkbtn small' : 'btn secondary'} type="submit">
        {props.again ? 'Voorbeelddata opnieuw vullen' : 'Vul met voorbeelddata'}
      </button>
    </form>
  );
}

function EmptyState(props: { base: string; demo: boolean; meldingen: Dashboard['meldingen'] }) {
  return (
    <section class="card empty-state">
      <h2>Hier komt je overzicht</h2>
      <p class="muted">
        Zodra je domein is bevestigd, zoeken we alles wat van buitenaf zichtbaar is: domeinen, websites, mail, servers en clouddiensten. Met
        het Business-pakket komen daar je netwerkapparatuur en apparaten bij.
      </p>
      {props.demo ? (
        <div class="stack-sm">
          <p class="small">Testomgeving: vul het dashboard met een voorbeeldbedrijf om te zien hoe het werkt.</p>
          <DemoForm base={props.base} />
        </div>
      ) : null}
    </section>
  );
}

// Alle assets -------------------------------------------------------------------------------

export function AssetsPage(props: Ctx & { d: Dashboard; soort: string | undefined }) {
  const { d, org } = props;
  const base = `/o/${org.id}`;
  const group = ASSET_GROUPS.find((g) => g.key === props.soort);
  const list = group ? d.assets.filter((a) => a.group === group.key) : d.assets;
  return (
    <Layout title="Assets" user={props.user} org={org} active="assets">
      <div class="intro">
        <p class="small">
          <a href={`${base}/overzicht`}>Overzicht</a> / Assets
        </p>
        <h1>{group ? group.label : 'Alle assets'}</h1>
        <p class="lead">{group ? group.uitleg : 'Alles wat we van jullie in beeld hebben, met wat de meeste aandacht vraagt bovenaan.'}</p>
      </div>
      <nav class="filters" aria-label="Soort asset">
        <a href={`${base}/assets`} aria-current={group ? undefined : 'page'}>
          Alles <span>{d.counts.assets}</span>
        </a>
        {d.groups.map((g) => (
          <a href={`${base}/assets?soort=${g.key}`} aria-current={group?.key === g.key ? 'page' : undefined}>
            {g.label} <span>{g.count}</span>
          </a>
        ))}
      </nav>
      <section class="card">
        {list.length ? (
          <AssetTable assets={list} base={base} />
        ) : (
          <p class="small">
            Hier hebben we nog niets van in beeld.{' '}
            {group && (group.key === 'netwerk' || group.key === 'apparaten')
              ? 'Koppel je router of netwerk om ook apparaten te zien.'
              : group?.key === 'cloud'
                ? 'Koppel Microsoft 365 (alleen lezen) om clouddiensten en accounts te zien.'
                : 'Voeg een domein toe om te beginnen.'}
          </p>
        )}
      </section>
    </Layout>
  );
}

// Detail per asset --------------------------------------------------------------------------

function FindingCard(props: { f: AssetFindingDetail }) {
  const { f } = props;
  return (
    <article class={`finding lvl-${f.level}`}>
      <div class="row between">
        <div class="row">
          <Status kind={f.level}>{LEVEL_LABEL[f.level]}</Status>
          <span class="badge" title={CERTAINTY_UITLEG[f.certainty]}>
            {CERTAINTY_LABEL[f.certainty]}
          </span>
        </div>
        <span class="small">Gezien sinds {datum(f.firstSeen)}</span>
      </div>
      <h3>{f.title}</h3>
      <p>{f.detail}</p>
      {f.certainty === 'mogelijk' || f.certainty === 'onbekend' ? <p class="small">{CERTAINTY_UITLEG[f.certainty]}</p> : null}
      {f.action ? (
        <div class="todo">
          <p class="kpi-label">Wat te doen · {FOR_WHO_LABELS[f.action.forWho]}</p>
          <p>
            <b>{f.action.title}</b>
          </p>
          <p class="small">{f.action.why}</p>
        </div>
      ) : null}
      {f.vulns.length ? (
        <ul class="vulns">
          {f.vulns.map((v) => (
            <li>
              <code>{v.cveId}</code>
              {v.cvss !== null ? <span class="small">CVSS {v.cvss.toFixed(1)}</span> : null}
              {v.inKev ? <Status kind="crit">Wordt actief misbruikt</Status> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {f.sources.length ? (
        <div class="sources">
          <span class="small">Bron:</span>
          {f.sources.map((s) => (
            <a href={s.url} rel="noopener noreferrer" target="_blank">
              {s.name}
            </a>
          ))}
        </div>
      ) : null}
    </article>
  );
}

export function AssetPage(props: Ctx & { a: AssetDetail }) {
  const { a, org } = props;
  const base = `/o/${org.id}`;
  const group = ASSET_GROUPS.find((g) => g.key === a.asset.group);
  return (
    <Layout title={a.asset.label} user={props.user} org={org} active="assets">
      <div class="intro">
        <p class="small">
          <a href={`${base}/overzicht`}>Overzicht</a> / <a href={`${base}/assets?soort=${a.asset.group}`}>{group?.label ?? 'Assets'}</a>
        </p>
        <div class="row">
          <h1 class="break">{a.asset.label}</h1>
          <Status kind={a.asset.level}>{a.asset.openFindings ? `${a.asset.openFindings} open` : LEVEL_LABEL[a.asset.level]}</Status>
        </div>
      </div>
      <div class="dash-cols">
        <div class="stack-lg">
          <section class="card" aria-labelledby="bev-kop">
            <h2 id="bev-kop">Bevindingen</h2>
            {a.open.length ? (
              a.open.map((f) => <FindingCard f={f} />)
            ) : (
              <p class="melding ok">Op dit asset staat niets open.</p>
            )}
          </section>
          {a.closed.length ? (
            <section class="card" aria-labelledby="opgelost-kop">
              <h2 id="opgelost-kop">Eerder opgelost</h2>
              <ul class="list">
                {a.closed.map((f) => (
                  <li class="list-item">
                    <span class="check" aria-hidden="true">✓</span>
                    <div class="stack-xs">
                      <p>{f.title}</p>
                      <p class="small">
                        {f.resolvedAt ? `Opgelost ${datum(f.resolvedAt)}` : `Geaccepteerd ${datum(f.acceptedAt)}`}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
        <div class="stack-lg">
          <section class="card" aria-labelledby="gegevens-kop">
            <h2 id="gegevens-kop">Gegevens</h2>
            <dl class="facts">
              <dt>Soort</dt>
              <dd>{a.asset.typeLabel}</dd>
              <dt>Bereikbaar</dt>
              <dd>{EXPOSURE_LABEL[a.asset.exposure] ?? a.asset.exposure}</dd>
              <dt>Eerst gezien</dt>
              <dd>{datum(a.asset.firstSeen)}</dd>
              <dt>Laatst gezien</dt>
              <dd>{datum(a.asset.lastSeen)}</dd>
              <dt>Gevonden via</dt>
              <dd>{a.asset.source === 'demo' ? 'Voorbeelddata' : a.asset.source}</dd>
            </dl>
          </section>
          {a.components.length ? (
            <section class="card" aria-labelledby="software-kop">
              <h2 id="software-kop">Software en firmware</h2>
              <ul class="list">
                {a.components.map((c) => {
                  const eol = c.eolDate && new Date(c.eolDate) < new Date();
                  return (
                    <li class="list-item">
                      <span class={`dot lvl-${eol ? 'crit' : 'ok'}`} aria-hidden="true"></span>
                      <div class="stack-xs">
                        <p>
                          {c.product} {c.version ? <code>{c.version}</code> : null}
                        </p>
                        <p class="small">
                          {c.vendor ?? ''}
                          {c.eolDate ? ` · ${eol ? 'geen updates meer sinds' : 'updates tot'} ${datum(c.eolDate)}` : ''}
                        </p>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : null}
        </div>
      </div>
    </Layout>
  );
}

// Domeinen -------------------------------------------------------------------------------------

export function DomeinenPage(
  props: Ctx & { domains: Domain[]; magBeheren: boolean; sent?: boolean; scans?: { workerActief: boolean; domains: Map<string, DomainScanInfo> }; magScannen?: boolean },
) {
  const { org } = props;
  const api = `/api/v1/organisaties/${org.id}/domeinen`;
  return (
    <Layout title="Domeinen" user={props.user} org={org} active="domeinen">
      <div class="intro">
        <p class="small">
          <a href={`/o/${org.id}/overzicht`}>Overzicht</a> / Domeinen
        </p>
        <h1>Domeinen</h1>
        <p class="lead">
          Vanuit je domein vinden we je websites, mail en servers. We scannen alleen domeinen waarvan je hebt bevestigd dat ze van jullie zijn.
        </p>
      </div>
      {props.sent ? <p class="melding ok">De bevestigingslink is verstuurd. Open de mail en klik op de link.</p> : null}
      {props.domains.map((d) => (
        <section class="card">
          <div class="row between">
            <h2 class="break">{d.name}</h2>
            {d.verified ? <Status kind="ok">Bevestigd</Status> : <Status kind="warn">Nog bevestigen</Status>}
          </div>
          {d.verified ? (
            <>
              <p class="small">Bevestigd op {datum(d.verifiedAt)} via {d.verificationMethod === 'email' ? 'e-mail' : 'DNS'}.</p>
              {props.scans ? (
                <DomeinScanBlok
                  orgId={org.id}
                  domainId={d.id}
                  info={props.scans.domains.get(d.id)}
                  magScannen={Boolean(props.magScannen)}
                  workerActief={props.scans.workerActief}
                />
              ) : null}
            </>
          ) : props.magBeheren ? (
            <div class="grid">
              <div class="stack-sm">
                <h3>Via DNS (aangeraden)</h3>
                <p class="small">Zet deze TXT-regel bij je domeinbeheerder, of stuur hem naar je IT-partner. Het kan een uur duren voor hij zichtbaar is.</p>
                <dl class="facts">
                  <dt>Naam</dt>
                  <dd>
                    <code>{d.instructions.dns.name}</code>
                  </dd>
                  <dt>Waarde</dt>
                  <dd>
                    <code class="break">{d.instructions.dns.value}</code>
                  </dd>
                </dl>
                <form data-api={`${api}/${d.id}/verificatie/dns`}>
                  <FormError />
                  <button class="btn" type="submit">
                    Controleer de DNS-regel
                  </button>
                </form>
              </div>
              <div class="stack-sm">
                <h3>Via e-mail</h3>
                <p class="small">We sturen een bevestigingslink naar een beheeradres van dit domein.</p>
                <form data-api={`${api}/${d.id}/verificatie/email`} data-next={`/o/${org.id}/domeinen?mail=verstuurd`}>
                  <FormError />
                  <label>
                    Adres
                    <select name="address">
                      {d.instructions.emailAddresses.map((e) => (
                        <option value={e}>{e}</option>
                      ))}
                    </select>
                  </label>
                  <button class="btn secondary" type="submit">
                    Stuur bevestigingslink
                  </button>
                </form>
              </div>
            </div>
          ) : (
            <p class="small">Een beheerder of de eigenaar van het account kan dit domein bevestigen.</p>
          )}
        </section>
      ))}
      {props.magBeheren ? (
        <section class="card narrow">
          <h2>Domein toevoegen</h2>
          <form class="stack" data-api={api}>
            <FormError />
            <label>
              Domeinnaam
              <span class="hint">Bijvoorbeeld jouwbedrijf.nl, zonder www of https.</span>
              <input type="text" name="name" required autocomplete="off" inputmode="url" placeholder="jouwbedrijf.nl" />
            </label>
            <button class="btn" type="submit">
              Toevoegen
            </button>
          </form>
        </section>
      ) : null}
    </Layout>
  );
}
