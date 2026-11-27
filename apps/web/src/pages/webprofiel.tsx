import type { AssetDetail } from '@qbicle/platform';
import { datum, datumTijd, Status } from '../layout.tsx';

/**
 * Sectie "Software en server" op de detailpagina van een website: wat draait er,
 * krijgt het nog updates, wie moet het bijwerken, en welke standaard
 * beveiligingsmaatregelen staan aan. Plus een uitklapblok voor de IT-partner.
 */

type Profiel = NonNullable<AssetDetail['webProfiel']>;
type Onderdeel = Profiel['onderdelen'][number];
type Kind = 'ok' | 'warn' | 'crit' | 'unk';

const SERVER = new Set(['webserver', 'taal', 'besturingssysteem', 'tls-bibliotheek', 'cdn']);

const CATEGORIE_LABEL: Record<string, string> = {
  cms: 'CMS',
  webwinkel: 'Webwinkel',
  platform: 'Platform',
  taal: 'Programmeertaal',
  webserver: 'Webserver',
  besturingssysteem: 'Besturingssysteem',
  'tls-bibliotheek': 'Versleuteling',
  cdn: 'Beschermlaag (CDN)',
  plugin: 'Plug-in',
  thema: 'Thema',
  'js-bibliotheek': 'Script in de browser',
};

const HOSTING_SOORT: Record<string, string> = {
  platform: 'websiteplatform: de partij werkt alles bij',
  'beheerde-wordpress': 'hosting speciaal voor WordPress',
  hosting: 'hostingpartij',
  cloud: 'eigen server in de cloud: updates regel je zelf',
  statisch: 'websitelevering',
  cdn: 'beschermlaag',
};

const WIE_LABEL: Record<string, string> = { hosting: 'Hostingpartij', webbouwer: 'Webbouwer', leverancier: 'Leverancier' };

const STATUS: Record<Onderdeel['status'], { label: string; kind: Kind }> = {
  einde: { label: 'Geen updates meer', kind: 'crit' },
  binnenkort: { label: 'Updates stoppen binnenkort', kind: 'warn' },
  achter: { label: 'Updates beschikbaar', kind: 'warn' },
  'nieuwere-reeks': { label: 'Ondersteund', kind: 'ok' },
  actueel: { label: 'Actueel', kind: 'ok' },
  onbekend: { label: 'Niet te beoordelen', kind: 'unk' },
  beheerd: { label: 'Bijgewerkt door leverancier', kind: 'ok' },
};

export function onderdeelKind(o: Onderdeel): Kind {
  const s = STATUS[o.status]?.kind ?? 'unk';
  const kev = o.lekken.some((l) => l.inKev && !l.voorwaarde);
  // Een distributie zet fixes vaak terug: dan is "geen updates" hooguit een aandachtspunt.
  if (o.distributie && s === 'crit') return 'warn';
  if (kev && !o.distributie && o.versieZekerheid === 'zeker') return 'crit';
  if (o.lekken.length && s !== 'crit') return 'warn';
  return s;
}

function Zekerheid(props: { o: Onderdeel }) {
  const { o } = props;
  if (!o.versie) return <span class="badge" title="De website laat de versie niet zien. Dat is goed: aanvallers zien hem ook niet.">Versie verborgen</span>;
  if (o.versieZekerheid === 'waarschijnlijk' || o.productZekerheid === 'waarschijnlijk')
    return <span class="badge" title={`Afgeleid uit: ${o.bron}. Niet door de website zelf gemeld.`}>Waarschijnlijk</span>;
  return <span class="badge" title={`De website meldt dit zelf (${o.bron}).`}>Zeker</span>;
}

function Regel(props: { o: Onderdeel; eigenServer?: boolean }) {
  const { o } = props;
  const kind = onderdeelKind(o);
  return (
    <li class="list-item">
      <span class={`dot lvl-${kind}`} aria-hidden="true"></span>
      <div class="stack-xs">
        <div class="row">
          <p>
            <b>{o.naam}</b> {o.versie ? <code>{o.versie}</code> : null}
          </p>
          <Zekerheid o={o} />
          <Status kind={kind}>{STATUS[o.status]?.label ?? o.status}</Status>
        </div>
        <p class="small">{o.uitleg}</p>
        <p class="small">
          {CATEGORIE_LABEL[o.categorie] ?? o.categorie} · {o.status === 'beheerd' || o.status === 'actueel' ? 'Beheer' : 'Bijwerken door'}: {o.wie === 'hosting' && props.eigenServer ? 'IT-partner of webbouwer' : (WIE_LABEL[o.wie] ?? o.wie)}
          {o.ondersteundTot && o.status !== 'einde' ? ` · updates tot ${datum(o.ondersteundTot)}` : ''}
        </p>
      </div>
    </li>
  );
}

function Groep(props: { titel: string; items: Onderdeel[]; eigenServer?: boolean }) {
  if (!props.items.length) return null;
  const order: Record<Kind, number> = { crit: 0, warn: 1, unk: 3, ok: 2 };
  const items = [...props.items].sort((a, b) => order[onderdeelKind(a)] - order[onderdeelKind(b)]);
  return (
    <div class="stack-sm">
      <h3>{props.titel}</h3>
      <ul class="list">
        {items.map((o) => (
          <Regel o={o} eigenServer={props.eigenServer} />
        ))}
      </ul>
    </div>
  );
}

export function WebProfielSectie(props: { p: Profiel }) {
  const { p } = props;
  const server = p.onderdelen.filter((o) => SERVER.has(o.categorie));
  const site = p.onderdelen.filter((o) => !SERVER.has(o.categorie));
  const host = (() => {
    try {
      return new URL(p.website).hostname;
    } catch {
      return p.website;
    }
  })();
  return (
    <section class="card stack" aria-labelledby="sw-kop">
      <div class="stack-xs">
        <h2 id="sw-kop">Software en server</h2>
        <p class="small">
          Wat iedere bezoeker van {host} kan zien, laatst bekeken {datumTijd(p.gezienOp)}.
          {p.kennisStand ? ` Gegevens over updates: endoflife.date, stand ${datum(p.kennisStand)}.` : ''}
        </p>
      </div>
      {p.hosting ? (
        <div class="todo">
          <p class="kpi-label">
            {p.hosting.soort === 'cdn' ? 'Beschermlaag' : 'Draait bij'} · {p.hosting.zekerheid === 'zeker' ? 'zeker' : 'waarschijnlijk'}
          </p>
          <p>
            <b>{p.hosting.naam}</b>
            {p.hosting.achter ? <span class="small"> (achter {p.hosting.achter})</span> : null}
            <span class="small"> · {HOSTING_SOORT[p.hosting.soort] ?? p.hosting.soort}</span>
          </p>
          <p class="small">{p.hosting.uitleg}</p>
          <p class="small">Gezien aan: {p.hosting.bron}.</p>
        </div>
      ) : (
        <p class="small">We konden niet herkennen bij welke partij de website draait. Vraag het na bij je webbouwer; dan weet je ook wie de server bijwerkt.</p>
      )}
      {p.onderdelen.length === 0 ? (
        <p class="melding ok">De website laat niet zien welke software hij gebruikt. Dat is goed, maar daardoor kunnen we van buitenaf ook niet zeggen of alles is bijgewerkt. Vraag dat na bij je webbouwer of hostingpartij.</p>
      ) : null}
      {p.achterCdn && p.hosting?.soort !== 'cdn' && !p.hosting?.achter ? (
        <p class="melding">
          Er zit een beschermlaag (CDN) voor je website. Die verbergt vaak de software van de server erachter. Dat is goed, maar het zegt niets over of die server is bijgewerkt.
        </p>
      ) : null}
      <Groep
        titel={p.hosting?.soort === 'cloud' ? 'Server · bij een eigen server je IT-partner of webbouwer' : 'Server · meestal je hostingpartij'}
        items={server}
        eigenServer={p.hosting?.soort === 'cloud'}
      />
      <Groep titel="Website · meestal je webbouwer" items={site} />

      {p.maatregelen.length ? (
        <div class="stack-sm">
          <h3>Beveiligingsmaatregelen</h3>
          <ul class="list">
            {p.maatregelen.map((m) => (
              <li class="list-item">
                <span class={`dot lvl-${m.ok === true ? 'ok' : m.ok === false ? 'warn' : 'unk'}`} aria-hidden="true"></span>
                <div class="stack-xs">
                  <p>
                    {m.label}{' '}
                    <span class="small">{m.ok === true ? '· staat aan' : m.ok === false ? '· staat niet aan' : '· niet vastgesteld'}</span>
                  </p>
                  {m.uitleg ? <p class="small">{m.uitleg}</p> : null}
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {p.onderdelen.length ? (
        <details class="uitklap">
          <summary>Uitleg voor je IT-partner of webbouwer</summary>
          <div class="stack-sm">
            <p class="small">
              Passieve waarneming: één bezoek aan de voorpagina zoals een browser dat doet (headers, cookienamen, generator-tag en de adressen van
              scripts en stylesheets). We vragen geen verborgen bestanden op en proberen geen lekken uit. "Waarschijnlijk" betekent afgeleid uit een
              pad of ?ver=-nummer; "zeker" betekent dat de website het zelf meldt. Bij een Linux-distributie (Ubuntu, Debian, Red Hat) kan een oud
              versienummer toch bijgewerkt zijn: controleer dan de pakketversie.
            </p>
            <ul class="list">
              {p.onderdelen.map((o) => (
                <li class="list-item">
                  <span class={`dot lvl-${onderdeelKind(o)}`} aria-hidden="true"></span>
                  <div class="stack-xs">
                    <p>
                      <b>{o.naam}</b> {o.versie ? <code>{o.versie}</code> : null}
                      {o.ruw ? <span class="small"> · gezien: <code>{o.ruw}</code></span> : null}
                    </p>
                    <p class="small">{o.itUitleg}</p>
                    {o.lekken.some((l) => l.voorwaarde) ? (
                      <p class="small">{[...new Set(o.lekken.map((l) => l.voorwaarde).filter(Boolean))].join(' ')}</p>
                    ) : null}
                    {o.bronnen.length ? (
                      <div class="sources">
                        <span class="small">Bron:</span>
                        {o.bronnen.map((s) => (
                          <a href={s.url} rel="noopener noreferrer" target="_blank">
                            {s.name}
                          </a>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </details>
      ) : null}
    </section>
  );
}
