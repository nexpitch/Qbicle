/** @jsxImportSource hono/jsx */
import type {
  AssetDetail,
  AssetFindingDetail,
  BillingOverview,
  Dashboard,
  DashboardAction,
  DashboardAsset,
  DnsHostResult,
  Domain,
  DomainOverview,
  Level,
  SysteemRegister,
  TrendPoint,
} from '@qbicle/platform';
import { ASSET_GROUPS, FOR_WHO_LABELS, TXT_LABEL } from '@qbicle/platform';
import type { Child } from 'hono/jsx';
import { KOPPELINGEN, type KoppelingStand } from '@qbicle/koppelingen';
import { KoppelingStatusBadge } from './koppelingen.tsx';
import { datum, datumTijd, euroKort, FormError, Layout, tijd, Status, type NavOrg, type PageUser } from '../layout.tsx';

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

/** Kalenderdag in Nederlandse tijd, voor "vandaag" en "gisteren". */
function dag(d: Date | string): string {
  return new Date(d).toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
}

function wanneer(d: Date | string, now = new Date()): string {
  const t = tijd(d);
  if (dag(d) === dag(now)) return `vandaag ${t}`;
  if (dag(d) === dag(new Date(now.getTime() - 86400000))) return `gisteren ${t}`;
  return `${kort(d)} ${t}`;
}

// Dashboard ---------------------------------------------------------------------------------

/**
 * Een extra sectie onder "Alles in beeld", naast de assetsoorten: bijvoorbeeld
 * koppelingen of het register bedrijfskritische systemen. De route bouwt hem op,
 * zodat elk onderdeel zijn eigen gegevens aanlevert zonder dat deze pagina ze kent.
 */
export interface DashSection {
  key: string;
  label: string;
  uitleg: string;
  count: number;
  /** null: nog niets om te beoordelen (grijze stip, "nog niet gekoppeld" e.d.). */
  level: Level | null;
  /** Korte status rechts in de kop, bijvoorbeeld "2 met aandacht" of "Nog niet gekoppeld". */
  status: string;
  body: Child;
}

export function DashboardPage(props: Ctx & { d: Dashboard; b: BillingOverview | null; demo: boolean; extra?: DashSection[] }) {
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
            {` · ${scanPlanText(d)}`}
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
          <AandachtCard d={d} base={base} />
        </>
      ) : (
        <EmptyState base={base} demo={props.demo} meldingen={d.meldingen} />
      )}

      <AllesCard d={d} base={base} extra={props.extra ?? []} />

      {d.hasData ? (
        <div class="dash-cols">
          <TrendCard trend={d.trend} />
          <div class="stack-lg">
            <ChangesCard d={d} base={base} />
            <ActivityCard d={d} />
          </div>
        </div>
      ) : null}
      {d.hasData && props.demo ? <DemoForm base={base} again /> : null}
    </Layout>
  );
}

/** "Volgende controle 4 dec 09:30", in de kop en in elke lege sectie. */
function scanPlanText(d: Dashboard): string {
  const p = d.scanPlan;
  if (p.status === 'geen_domein') return 'Voeg een domein toe om te starten';
  if (p.status === 'niet_bevestigd') return 'Eerste scan zodra je domein is bevestigd';
  if (p.status === 'bezig') return 'Scan loopt nu';
  if (p.status === 'eerste') return 'Eerste scan staat in de wachtrij';
  return `Volgende controle ${p.volgende && p.volgende.getTime() > Date.now() ? wanneer(p.volgende) : 'binnenkort'}`;
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

/** Bovenaan: wat nu aandacht nodig heeft (urgent en aandacht), plus meldingen. De rest klapt in. */
function AandachtCard(props: { d: Dashboard; base: string }) {
  const { d } = props;
  const now = d.actions.filter((a) => a.level === 'crit' || a.level === 'warn');
  const top = now.slice(0, 5);
  const rest = d.actions.slice(top.length);
  const meldingen = d.meldingen;
  const assets = d.assets.filter((a) => a.level === 'crit').slice(0, 4);
  return (
    <section class="card attention" id="acties" aria-labelledby="acties-kop">
      <div class="row between">
        <h2 id="acties-kop">Direct aandacht</h2>
        <span class="small">belangrijkste eerst</span>
      </div>
      {top.length === 0 ? (
        <p class="melding ok">Niets dat nu direct aandacht nodig heeft. We blijven alles bewaken.</p>
      ) : (
        <ol class="actions">
          {top.map((a, i) => (
            <ActionRow a={a} i={i} base={props.base} />
          ))}
        </ol>
      )}
      {assets.length ? (
        <p class="small">
          Urgent:{' '}
          {assets.map((a, i) => (
            <>
              {i ? ', ' : ''}
              <a href={`${props.base}/assets/${a.id}`}>{a.label}</a>
            </>
          ))}
        </p>
      ) : null}
      {meldingen.length ? (
        <ul class="list">
          {meldingen.map((m) => (
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
      ) : null}
      {rest.length ? (
        <details class="more">
          <summary>Nog {rest.length} {rest.length === 1 ? 'actie' : 'acties'} voor later</summary>
          <ol class="actions" start={top.length + 1}>
            {rest.map((a, i) => (
              <ActionRow a={a} i={i + top.length} base={props.base} />
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

/** Eén uitklapbare sectie: kop met stip, naam, teller en status; inhoud ingeklapt. */
function Section(props: { id: string; label: string; uitleg: string; count: number; level: Level | null; status: string; children: Child }) {
  return (
    <details class="sect" id={`sectie-${props.id}`}>
      <summary>
        <span class={`dot ${props.level ? `lvl-${props.level}` : 'lvl-none'}`} aria-hidden="true"></span>
        <span class="sect-name">
          <b>{props.label}</b>
          <span class="small">{props.uitleg}</span>
        </span>
        <span class="sect-count" aria-label={`${props.count} stuks`}>
          {props.count}
        </span>
        <span class="sect-status">{props.level ? <Status kind={props.level}>{props.status}</Status> : <span class="small">{props.status}</span>}</span>
      </summary>
      <div class="sect-body">{props.children}</div>
    </details>
  );
}

const NIET_VAN_BUITEN: Record<string, string> = {
  netwerk: 'Routers, firewalls en wifi zien we via een koppeling met je router (Business-pakket).',
  apparaten: 'Apparaten in je netwerk zien we via een koppeling met je router (Business-pakket).',
  cloud: 'Clouddiensten zien we deels van buiten. Met een koppeling met Microsoft 365 of AWS zien we de instellingen erachter.',
};

function AllesCard(props: { d: Dashboard; base: string; extra: DashSection[] }) {
  const { d, base } = props;
  const plan = scanPlanText(d);
  const total = d.counts.assets + props.extra.reduce((n, x) => n + x.count, 0);
  return (
    <section class="card" aria-labelledby="alles-kop">
      <div class="row between">
        <h2 id="alles-kop">Alles in beeld</h2>
        {d.counts.assets ? <a href={`${base}/assets`}>Alle {d.counts.assets} assets</a> : <span class="small">{total ? `${total} gevonden` : 'Nog niets gevonden'}</span>}
      </div>
      <p class="small">Niet alleen je website: alles wat aan internet hangt en waar een incident kan beginnen. Klik een onderdeel open.</p>
      <div class="sects">
        {d.groups.map((g) => {
          const list = d.assets.filter((a) => a.group === g.key);
          const status =
            g.count === 0 ? (g.key === 'netwerk' || g.key === 'apparaten' ? 'Nog niet gekoppeld' : d.lastScanAt ? 'Niets gevonden' : 'Nog niet gescand') : g.withIssues ? `${g.withIssues} met aandacht` : g.level === 'unk' ? 'Deels onbekend' : 'In orde';
          return (
            <Section id={g.key} label={g.label} uitleg={g.uitleg} count={g.count} level={g.count ? (g.withIssues ? g.level : g.level === 'unk' ? 'unk' : 'ok') : null} status={status}>
              {list.length ? (
                <>
                  <AssetTable assets={list.slice(0, 10)} base={base} />
                  {list.length > 10 ? (
                    <a class="small" href={`${base}/assets?soort=${g.key}`}>
                      Alle {list.length} bekijken
                    </a>
                  ) : null}
                </>
              ) : (
                <div class="stack-xs">
                  <p class="small">{d.lastScanAt ? 'Bij de laatste scan niets van deze soort gevonden.' : `Nog niet gescand. ${plan}.`}</p>
                  {NIET_VAN_BUITEN[g.key] ? (
                    <p class="small">
                      {NIET_VAN_BUITEN[g.key]} <a href={`${base}/koppelingen`}>Naar koppelingen</a>
                    </p>
                  ) : null}
                </div>
              )}
            </Section>
          );
        })}
        {props.extra.map((x) => (
          <Section id={x.key} label={x.label} uitleg={x.uitleg} count={x.count} level={x.level} status={x.status}>
            {x.body}
          </Section>
        ))}
      </div>
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
        het Business-pakket komen daar je netwerkapparatuur en apparaten bij. Hieronder zie je al welke onderdelen we gaan bewaken.
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
        <span class="small">Gezien sinds {datumTijd(f.firstSeen)}</span>
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
                        {f.resolvedAt ? `Opgelost ${datumTijd(f.resolvedAt)}` : `Geaccepteerd ${datumTijd(f.acceptedAt)}`}
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
              <dd>{datumTijd(a.asset.firstSeen)}</dd>
              <dt>Laatst gezien</dt>
              <dd>{datumTijd(a.asset.lastSeen)}</dd>
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


// Kopiëren ----------------------------------------------------------------------------------------

/** Waarde met een kopieerknop erachter; app.js zet hem op het klembord en meldt "Gekopieerd". */
export function Copy(props: { value: string; label: string }) {
  return (
    <span class="copy">
      <code class="break">{props.value}</code>
      <button type="button" class="copy-btn" data-kopieer={props.value} aria-label={`Kopieer ${props.label}`} title={`Kopieer ${props.label}`}>
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
          <rect x="9" y="9" width="11" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="2" />
          <path d="M5 15V5a2 2 0 0 1 2-2h8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
        </svg>
        <span class="copy-ok" aria-hidden="true">Gekopieerd</span>
      </button>
    </span>
  );
}

/** De TXT-regel, met kopieerknoppen en de korte naam voor partijen die het domein zelf aanvullen. */
function DnsRecord(props: { name: string; value: string; withType?: boolean; providerNaam?: string | null }) {
  return (
    <dl class="facts">
      {props.withType ? (
        <>
          <dt>Type</dt>
          <dd>
            <Copy value="TXT" label="type" />
          </dd>
        </>
      ) : null}
      <dt>Naam</dt>
      <dd class="stack-xs">
        <Copy value={props.name} label="naam" />
        <span class="small">
          {props.providerNaam ? `Bij ${props.providerNaam} vul` : 'Vult je provider het domein zelf aan (zoals Wix, Strato of TransIP)? Vul'} je alleen in:{' '}
        </span>
        <Copy value={TXT_LABEL} label="korte naam" />
      </dd>
      <dt>Waarde</dt>
      <dd>
        <Copy value={props.value} label="waarde" />
      </dd>
    </dl>
  );
}

// Domeinen -------------------------------------------------------------------------------------

export function DomeinenPage(props: Ctx & { domains: Domain[]; magBeheren: boolean; sent?: boolean; overview: DomainOverview; added?: { aantal: number; bestaatAl: number; ongeldig: string } }) {
  const ov = props.overview;
  const over = ov.gebruikt > ov.limiet;
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
      {props.added ? (
        <p class={`melding ${props.added.ongeldig ? 'warn' : 'ok'}`}>
          {props.added.aantal === 1 ? '1 domein toegevoegd' : `${props.added.aantal} domeinen toegevoegd`}
          {props.added.bestaatAl ? `, ${props.added.bestaatAl} stond${props.added.bestaatAl === 1 ? '' : 'en'} er al` : ''}
          {props.added.ongeldig ? `. Niet herkend als domein: ${props.added.ongeldig}` : ''}.
        </p>
      ) : null}
      <div class="row between">
        <p class="small">
          {ov.gebruikt} van {ov.limiet} domeinen in je pakket{ov.plan ? '' : ' (zonder abonnement)'} · extra domein {euroKort(ov.extraDomeinCenten)} per maand
        </p>
      </div>
      {over ? (
        <p class="melding warn">
          Je hebt {ov.extra} {ov.extra === 1 ? 'domein' : 'domeinen'} meer dan in je pakket zit. Elk extra domein kost {euroKort(ov.extraDomeinCenten)} per maand (excl. btw) en wordt gewoon bewaakt.
        </p>
      ) : null}
      {props.domains.map((d) => (
        <section class="card">
          <div class="row between">
            <h2 class="break">{d.name}</h2>
            {d.verified ? <Status kind="ok">Bevestigd</Status> : <Status kind="warn">Nog bevestigen</Status>}
          </div>
          {d.verified ? (
            <>
              <p class="small">Bevestigd op {datumTijd(d.verifiedAt)} via {d.verificationMethod === 'email' ? 'e-mail' : 'DNS'}.</p>
              {(() => {
                const sm = ov.summaries.get(d.id);
                return sm ? (
                  <div class="row domain-stats">
                    <span>
                      <b>{sm.assets}</b> assets
                    </span>
                    <span>
                      <b>{sm.openFindings}</b> open bevindingen
                    </span>
                    <span class="small">{sm.lastScanAt ? `Laatste scan ${datumTijd(sm.lastScanAt)}` : 'Nog niet gescand'}</span>
                  </div>
                ) : null;
              })()}
            </>
          ) : props.magBeheren ? (
            <div class="grid">
              <div class="stack-sm">
                <h3>Via DNS (aangeraden)</h3>
                <p class="small">Zet deze TXT-regel bij je domeinbeheerder, of stuur hem naar je IT-partner. Het kan een uur duren voor hij zichtbaar is.</p>
                <p class="small">
                  <a href={`/o/${org.id}/domeinen/${d.id}/waar`}>Weet je niet waar je domein staat? Wij zoeken het op.</a>
                </p>
                <DnsRecord name={d.instructions.dns.name} value={d.instructions.dns.value} withType />
                <form data-api={`${api}/${d.id}/verificatie/dns`}>
                  <FormError />
                  <button class="btn" type="submit">
                    Controleer de DNS-regel
                  </button>
                </form>
              </div>
              <div class="stack-sm">
                <h3>Via e-mail</h3>
                <p class="small">We sturen een bevestigingslink naar een adres op @{d.name}. Kies een beheeradres of vul je eigen adres in.</p>
                <form class="stack mail-verif" data-api={`${api}/${d.id}/verificatie/email`} data-next={`/o/${org.id}/domeinen?mail=verstuurd`}>
                  <FormError />
                  <label>
                    Adres
                    <select name="address">
                      {d.instructions.emailAddresses.map((e) => (
                        <option value={e}>{e}</option>
                      ))}
                      <option value="ander">Ander adres op @{d.name}…</option>
                    </select>
                  </label>
                  <label class="eigen-adres">
                    Jouw adres
                    <span class="hint">Moet eindigen op @{d.name}.</span>
                    <input type="email" name="eigenAdres" autocomplete="email" placeholder={`naam@${d.name}`} />
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
      {props.magBeheren && ov.suggesties.length ? (
        <section class="card">
          <h2>Hoort dit ook bij jullie?</h2>
          <p class="small">Deze domeinen zagen we bij je websites, servers of certificaten. Voeg ze toe als ze van jullie zijn.</p>
          <div class="row">
            {ov.suggesties.map((sug) => (
              <form data-api={`${api}/lijst`} data-next={`/o/${org.id}/domeinen?toegevoegd={aantal}&bestaat={bestaatAl}`}>
                <input type="hidden" name="domeinen" value={sug} />
                <button class="btn secondary" type="submit">
                  + {sug}
                </button>
              </form>
            ))}
          </div>
        </section>
      ) : null}
      {props.magBeheren ? (
        <section class="card narrow">
          <h2>{props.domains.length ? 'Meer domeinen toevoegen' : 'Domein toevoegen'}</h2>
          <form class="stack" data-api={`${api}/lijst`} data-next={`/o/${org.id}/domeinen?toegevoegd={aantal}&bestaat={bestaatAl}&ongeldig={ongeldigTekst}`}>
            <FormError />
            <label>
              Domeinnamen
              <span class="hint">Eén of meer, bijvoorbeeld jouwbedrijf.nl en jouwwebshop.nl. Je kunt een hele lijst plakken; scheid met een komma of nieuwe regel.</span>
              <textarea name="domeinen" rows={4} required autocomplete="off" placeholder={'jouwbedrijf.nl\njouwwebshop.nl'}></textarea>
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

// Waar staat mijn domein? ----------------------------------------------------------------------

const ZEKERHEID_KIND: Record<string, Level> = { waarschijnlijk: 'ok', mogelijk: 'warn', onbekend: 'unk' };
const ZEKERHEID_LABEL: Record<string, string> = { waarschijnlijk: 'Waarschijnlijk', mogelijk: 'Mogelijk', onbekend: 'Niet gevonden' };

function doorstuurMail(r: DnsHostResult, orgName: string): string {
  const subject = `Graag een DNS-regel toevoegen voor ${r.domain}`;
  const body = [
    'Hoi,',
    '',
    `Wil je voor ${r.domain} deze TXT-regel toevoegen in de DNS${r.dnsBeheer.naam ? ` (die lijkt bij ${r.dnsBeheer.naam} te staan)` : ''}?`,
    '',
    `Type: TXT`,
    `Naam: ${r.instructions.dns.name}`,
    `Waarde: ${r.instructions.dns.value}`,
    '',
    `Hiermee bevestigen we bij Qbicle dat ${r.domain} van ${orgName} is, zodat Qbicle de beveiliging van onze internetsystemen kan bewaken. De regel verandert niets aan de website of de mail.`,
    '',
    'Dank je wel!',
  ].join('\n');
  return `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

export function WaarStaatDomeinPage(props: Ctx & { domainId: string; r: DnsHostResult }) {
  const { r, org } = props;
  const p = r.dnsBeheer.provider;
  return (
    <Layout title={`Waar staat ${r.domain}?`} user={props.user} org={org} active="domeinen">
      <div class="intro">
        <p class="small">
          <a href={`/o/${org.id}/overzicht`}>Overzicht</a> / <a href={`/o/${org.id}/domeinen`}>Domeinen</a>
        </p>
        <h1 class="break">Waar staat {r.domain}?</h1>
        <p class="lead">We hebben openbare gegevens opgezocht: de naamservers, de registratie van de domeinnaam en de mailservers. We hebben niets bij je domein veranderd.</p>
      </div>
      <section class="card next-step">
        <div class="row between">
          <p class="eyebrow">DNS-beheer</p>
          <Status kind={ZEKERHEID_KIND[r.dnsBeheer.zekerheid]!}>{ZEKERHEID_LABEL[r.dnsBeheer.zekerheid]}</Status>
        </div>
        <h2>{r.dnsBeheer.naam ? `Je DNS staat ${r.dnsBeheer.zekerheid === 'waarschijnlijk' ? 'waarschijnlijk' : 'mogelijk'} bij ${r.dnsBeheer.naam}` : 'We weten niet zeker waar je DNS staat'}</h2>
        <p class="muted">{r.dnsBeheer.reden}</p>
        {p ? (
          <div class="stack-sm">
            <h3>Zo zet je de regel erin bij {p.naam}</h3>
            <ol class="steps-plain">
              {p.stappen.map((st) => (
                <li>{st}</li>
              ))}
            </ol>
            <p class="small">Menunamen kunnen iets anders heten. Kom je er niet uit, stuur de regel dan door.</p>
          </div>
        ) : null}
        <DnsRecord name={r.instructions.dns.name} value={r.instructions.dns.value} withType providerNaam={p?.naam ?? null} />
        <div class="row">
          {p ? (
            <a class="btn" href={p.inlog} rel="noopener noreferrer" target="_blank">
              Inloggen bij {p.naam}
            </a>
          ) : null}
          <a class={p ? 'btn secondary' : 'btn'} href={doorstuurMail(r, org.name)}>
            Stuur de regel naar je IT-partner of webbouwer
          </a>
          <a class="btn secondary" href={`/o/${org.id}/domeinen`}>
            Terug naar domeinen
          </a>
        </div>
      </section>
      <section class="card">
        <h2>Wat we vonden</h2>
        <dl class="facts">
          <dt>Naamservers</dt>
          <dd>{r.nameservers.length ? r.nameservers.join(', ') : 'Niet gevonden'}</dd>
          <dt>Domeinnaam geregistreerd via</dt>
          <dd>
            {r.registrar.naam ?? 'Niet gevonden'}
            {r.registrar.naam ? <span class="small"> · hier betaal je meestal voor de domeinnaam</span> : null}
          </dd>
          <dt>Mail loopt via</dt>
          <dd>{r.mail.provider ? r.mail.provider.naam : r.mail.servers.length ? r.mail.servers.join(', ') : 'Geen mailservers gevonden'}</dd>
        </dl>
        <p class="small">Registratie en DNS-beheer kunnen bij verschillende partijen liggen. De DNS pas je aan bij de partij van de naamservers.</p>
      </section>
    </Layout>
  );
}

// Secties naast de assets ------------------------------------------------------------------

/** Koppelingen als sectie op het overzicht: wat gekoppeld is, met status en bevindingen. */
export function koppelingenSectie(standen: KoppelingStand[], plan: string | null, base: string): DashSection {
  const byId = new Map(standen.map((s) => [s.id, s]));
  const inGebruik = standen.filter((s) => s.status !== 'niet_gekoppeld' && s.status !== 'ingetrokken');
  const worst = (s: KoppelingStand): Level =>
    s.status === 'fout' || s.bevindingen.some((b) => b.urgentie === 'crit')
      ? 'crit'
      : s.status === 'let_op' || s.status === 'wacht_op_it' || s.bevindingen.some((b) => b.urgentie === 'warn')
        ? 'warn'
        : 'ok';
  const levels = inGebruik.map(worst);
  const aandacht = levels.filter((l) => l !== 'ok').length;
  const level: Level | null = !inGebruik.length ? null : levels.includes('crit') ? 'crit' : levels.includes('warn') ? 'warn' : 'ok';
  return {
    key: 'koppelingen',
    label: 'Koppelingen',
    uitleg: 'Microsoft 365, cloud en router: de instellingen achter je systemen',
    count: inGebruik.length,
    level,
    status: !inGebruik.length ? 'Nog niet gekoppeld' : aandacht ? `${aandacht} met aandacht` : 'In orde',
    body: inGebruik.length ? (
      <div class="stack-sm">
        <ul class="list">
          {inGebruik.map((s) => {
            const k = KOPPELINGEN.find((x) => x.id === s.id);
            if (!k) return null;
            const open = s.bevindingen.filter((b) => b.urgentie !== 'ok').length;
            return (
              <li class="list-item">
                <span class={`dot lvl-${worst(s)}`} aria-hidden="true"></span>
                <div class="stack-xs">
                  <a href={`${base}/koppelingen/${k.id}`}>{k.naam}</a>
                  <span class="small">{s.melding ?? (open ? `${open} ${open === 1 ? 'punt' : 'punten'} om op te pakken` : 'Geen bijzonderheden')}</span>
                </div>
                <KoppelingStatusBadge k={k} s={byId.get(k.id)} plan={plan} />
              </li>
            );
          })}
        </ul>
        <a class="small" href={`${base}/koppelingen`}>
          Alle koppelingen
        </a>
      </div>
    ) : (
      <p class="small">
        Van buiten zien we wat iedereen op internet ziet. Met een alleen-lezen koppeling kijken we ook naar MFA, beheerders en openbare opslag.{' '}
        <a href={`${base}/koppelingen`}>Koppeling kiezen</a>
      </p>
    ),
  };
}

/** Sectie "Systemen" in Alles in beeld: register van bedrijfskritische systemen. */
export function systemenSectie(reg: SysteemRegister, base: string): DashSection {
  const worst = (s: SysteemRegister['systemen'][number]): Level =>
    s.beoordeling.acties.some((a) => a.urgentie === 'crit') ? 'crit' : s.beoordeling.acties.length ? 'warn' : 'ok';
  const levels = reg.systemen.map(worst);
  const aandacht = levels.filter((l) => l !== 'ok').length;
  const level: Level | null = !reg.systemen.length ? null : levels.includes('crit') ? 'crit' : levels.includes('warn') ? 'warn' : 'ok';
  return {
    key: 'systemen',
    label: 'Systemen',
    uitleg: 'Software waar je bedrijf op draait: ERP, CRM, boekhouding, webshop',
    count: reg.systemen.length,
    level,
    status: !reg.systemen.length ? 'Nog niets vastgelegd' : aandacht ? `${aandacht} met aandacht` : 'In orde',
    body: reg.systemen.length ? (
      <div class="stack-sm">
        <ul class="list">
          {reg.systemen.map((s) => {
            const eerste = s.beoordeling.acties[0];
            return (
              <li class="list-item">
                <span class={`dot lvl-${worst(s)}`} aria-hidden="true"></span>
                <div class="stack-xs">
                  <a href={`${base}/systemen/${s.id}`}>{s.naam}</a>
                  <span class="small">{eerste ? eerste.tekst : 'Geen bijzonderheden'}</span>
                </div>
                <span class="small">Impact {s.beoordeling.impact}</span>
              </li>
            );
          })}
        </ul>
        <a class="small" href={`${base}/systemen`}>
          Alle systemen
        </a>
      </div>
    ) : (
      <p class="small">
        Leg vast welke software onmisbaar is, wie de eigenaar is en wat er gebeurt bij uitval. Dan zie je hier wat er nog mist.{' '}
        <a href={`${base}/systemen/nieuw`}>Systeem toevoegen</a>
      </p>
    ),
  };
}
