/** @jsxImportSource hono/jsx */
import { INGREPEN, isDnsIngreep, type FindingOplossing, type Ingreep, type OplosGids } from '@qbicle/platform';
import { Copy } from './dashboard.tsx';

/**
 * "Zo los je het op" bij een bevinding: een icoon dat laat zien wát je doet
 * (regel toevoegen, aanpassen, instelling, bijwerken, bestand, aanvragen), de
 * stappen, de exacte waarden met kopieerknop en de knop "Ik heb het gedaan,
 * controleer nu". De inhoud komt uit packages/platform/src/oplossen.ts.
 */

const S = { fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' } as const;

/** Iconen per soort ingreep: eenvoudig, herkenbaar en zonder tekst. */
export function IngreepIcoon(props: { soort: Ingreep }) {
  const body = (() => {
    switch (props.soort) {
      case 'dns-toevoegen':
        return (
          <>
            <rect x="3" y="4" width="13" height="4" rx="1" {...S} />
            <rect x="3" y="10" width="13" height="4" rx="1" {...S} />
            <path d="M3 17h7" {...S} />
            <circle cx="18" cy="17" r="4.2" {...S} />
            <path d="M18 15v4M16 17h4" {...S} />
          </>
        );
      case 'dns-aanpassen':
        return (
          <>
            <rect x="3" y="4" width="13" height="4" rx="1" {...S} />
            <rect x="3" y="10" width="9" height="4" rx="1" {...S} />
            <path d="M3 17h5" {...S} />
            <path d="M14.5 19.5l.6-3 5.2-5.2a1.6 1.6 0 0 1 2.3 2.3l-5.2 5.2z" {...S} />
          </>
        );
      case 'instelling':
        return (
          <>
            <rect x="2.5" y="7" width="19" height="10" rx="5" {...S} />
            <circle cx="16.5" cy="12" r="3" fill="currentColor" />
          </>
        );
      case 'bijwerken':
        return (
          <>
            <path d="M20 11a8 8 0 0 0-14.3-4.5L4 8.5" {...S} />
            <path d="M4 4v4.5h4.5" {...S} />
            <path d="M4 13a8 8 0 0 0 14.3 4.5L20 15.5" {...S} />
            <path d="M20 20v-4.5h-4.5" {...S} />
          </>
        );
      case 'bestand':
        return (
          <>
            <path d="M6 2.5h8l4.5 4.5v14.5H6z" {...S} />
            <path d="M14 2.5V7h4.5M9 12h6M9 15.5h6" {...S} />
          </>
        );
      case 'aanvragen':
        return (
          <>
            <path d="M21.5 2.5L10 14" {...S} />
            <path d="M21.5 2.5l-7 19-4.5-7.5-7.5-4.5z" {...S} />
          </>
        );
    }
  })();
  return (
    <span class={`ingreep-icoon ingreep-${props.soort}`} aria-hidden="true">
      <svg viewBox="0 0 24 24" width="26" height="26" focusable="false">
        {body}
      </svg>
    </span>
  );
}

function Waarden(props: { g: OplosGids }) {
  const { g } = props;
  return (
    <div class="stack-sm">
      {g.regels.map((r) => (
        <div class={`dns-regel${r.voorbeeld ? ' voorbeeld' : ''}`}>
          {r.voorbeeld ? <p class="kpi-label">Voorbeeld, laat de waarde nagaan</p> : <p class="kpi-label">Deze regel voeg je toe</p>}
          <div class="dns-rij" role="table" aria-label="DNS-regel">
            <div role="row" class="dns-kop">
              <span role="columnheader">Type</span>
              <span role="columnheader">Naam</span>
              <span role="columnheader">Waarde</span>
            </div>
            <div role="row" class="dns-data">
              <span role="cell" data-label="Type">
                <Copy value={r.type} label="type" />
              </span>
              <span role="cell" data-label="Naam">
                <Copy value={r.kort} label="naam" />
              </span>
              <span role="cell" data-label="Waarde">
                <Copy value={r.waarde} label="waarde" />
              </span>
            </div>
          </div>
          <p class="small">
            {r.kort === '@' ? 'Naam @ betekent: het domein zelf. Laat het veld leeg als je partij geen @ accepteert.' : 'De meeste partijen vullen het domein zelf aan.'}{' '}
            Vraagt je partij de volledige naam, gebruik dan <Copy value={r.naam} label="volledige naam" />
          </p>
        </div>
      ))}
      {g.wijzigingen.map((w) => (
        <div class="dns-regel">
          <p class="kpi-label">Dit verander je in {w.waar}</p>
          <p class="wijziging">
            <code class="van">{w.van}</code>
            <span aria-hidden="true">→</span>
            <span class="sr-only">wordt</span>
            <Copy value={w.naar} label="nieuwe waarde" />
          </p>
        </div>
      ))}
      {g.headers.map((h) => (
        <div class="dns-regel">
          <p class="kpi-label">Header voor je webbouwer</p>
          <Copy value={`${h.naam}: ${h.waarde}`} label="header" />
          <p class="small">{h.uitleg}</p>
        </div>
      ))}
      {g.bestand ? (
        <div class="dns-regel">
          <p class="kpi-label">Bestand {g.bestand.pad}</p>
          <pre class="bestand">{g.bestand.inhoud}</pre>
          <button type="button" class="btn secondary klein" data-kopieer={g.bestand.inhoud}>
            Kopieer de inhoud
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function OplosBlok(props: {
  f: { id: string; action: { title: string; why: string } };
  o: FindingOplossing;
  orgId: string;
  assetId: string;
  open?: boolean;
  domainId?: string | null;
}) {
  const { f, o } = props;
  const g = o.gids!;
  const heeftWaarden = g.regels.length || g.wijzigingen.length || g.headers.length || g.bestand;
  const h = o.hercontrole;
  const loopt = h && (h.status === 'wachtrij' || h.status === 'bezig');
  const dns = isDnsIngreep(g.ingreep);
  return (
    <div class="todo oplos" id={`f-${f.id}`}>
      <div class="oplos-kop">
        <IngreepIcoon soort={g.ingreep} />
        <div class="stack-xs">
          <p class="kpi-label">
            {INGREPEN[g.ingreep].label} · {g.duur}
          </p>
          <p>
            <b>{f.action.title}</b>
          </p>
          <p class="small">{f.action.why}</p>
        </div>
      </div>
      <p class="small wie">{g.wieTekst}</p>
      <details class="oplos-stappen" open={props.open}>
        <summary class="oplos-knop">Zo los je het op, stap voor stap</summary>
        <div class="stack-sm">
          <p class="small">{INGREPEN[g.ingreep].uitleg}</p>
          {g.inlog ? (
            <p>
              <a class="btn secondary klein" href={g.inlog.url} rel="noopener noreferrer" target="_blank">
                Inloggen bij {g.inlog.naam} ↗
              </a>
            </p>
          ) : dns && props.domainId ? (
            <p class="small">
              Weet je niet waar je domein staat?{' '}
              <a href={`/o/${props.orgId}/domeinen/${props.domainId}/waar`}>Zo zoek je uit bij welke partij je moet inloggen</a>
            </p>
          ) : null}
          <ol class="stappen">
            {g.stappen.map((s) => (
              <li>{s}</li>
            ))}
          </ol>
          {heeftWaarden ? (
            g.voorwaarde ? (
              <details class="voorwaarde">
                <summary>
                  <span class="melding warn">
                    <b>Eerst controleren:</b> {g.voorwaarde}
                  </span>
                  <span class="voorwaarde-knop">Ik heb dit gecontroleerd, toon de waarde</span>
                </summary>
                <Waarden g={g} />
              </details>
            ) : (
              <Waarden g={g} />
            )
          ) : g.voorwaarde ? (
            <p class="melding warn">
              <b>Eerst controleren:</b> {g.voorwaarde}
            </p>
          ) : null}
          {g.waarschuwingen.length ? (
            <ul class="let-op">
              {g.waarschuwingen.map((w) => (
                <li>{w}</li>
              ))}
            </ul>
          ) : null}
          <p class="small">{g.wachten}</p>
          {dns ? (
            <p class="binnenkort small">
              <b>In ontwikkeling:</b> straks log je hier in bij je DNS-partij en zetten wij deze regel voor je klaar. Je keurt hem dan zelf
              goed. Tot die tijd volg je de stappen hierboven.
            </p>
          ) : null}
        </div>
      </details>
      {h ? (
        <p
          class={`melding hercontrole ${loopt ? '' : h.uitkomst === 'opgelost' ? 'ok' : h.uitkomst === 'nog-open' ? 'warn' : ''}`}
          role="status"
          data-hercontrole={loopt ? `/api/v1/organisaties/${props.orgId}/hercontroles/${h.scanId}` : undefined}
        >
          {loopt ? <span class="spinner" aria-hidden="true"></span> : null}
          <span data-hercontrole-tekst>{h.tekst}</span>
        </p>
      ) : null}
      <div class="oplos-acties">
        {o.kanHercontrole ? (
          <form
            data-api={`/api/v1/organisaties/${props.orgId}/bevindingen/${f.id}/hercontrole`}
            data-next={`/o/${props.orgId}/assets/${props.assetId}?controle={scanId}#f-${f.id}`}
          >
            <button class="btn klein" type="submit" disabled={Boolean(loopt)}>
              ✓ Ik heb het gedaan, controleer nu
            </button>
          </form>
        ) : null}
        <details class="doorsturen">
          <summary>Uitleg doorsturen</summary>
          <div class="stack-xs">
            <pre class="bestand">{g.doorsturen}</pre>
            <button type="button" class="btn secondary klein" data-kopieer={g.doorsturen}>
              Kopieer de uitleg
            </button>
          </div>
        </details>
      </div>
    </div>
  );
}
