/** @jsxImportSource hono/jsx */
import { CATEGORIEEN, inPakket, KOPPELINGEN, type Koppeling, type KoppelingStand, type KoppelingStatus, type VoorbeeldBevinding } from '@qbicle/koppelingen';
import { datum, FormError, Layout, Status, type NavOrg, type PageUser } from '../layout.tsx';

type Ctx = { user: PageUser; org: NavOrg };

const tijd = (d: Date | string | null) =>
  d ? new Date(d).toLocaleString('nl-NL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Amsterdam' }) : '';

export function KoppelingStatusBadge(props: { k: Koppeling; s: KoppelingStand | undefined; plan: string | null }) {
  const { k, s } = props;
  const status: KoppelingStatus = s?.status ?? 'niet_gekoppeld';
  if (status === 'actief') return <Status kind="ok">Actief</Status>;
  if (status === 'let_op') return <Status kind="warn">Actief, let op</Status>;
  if (status === 'wacht_op_it') return <Status kind="warn">Wacht op IT</Status>;
  if (status === 'fout') return <Status kind="crit">Werkt niet</Status>;
  if (status === 'ingetrokken') return <Status kind="unk">Ingetrokken</Status>;
  if (k.beschikbaarheid === 'binnenkort') return <Status kind="unk">{s?.interesse ? 'Binnenkort, we laten het weten' : 'Binnenkort'}</Status>;
  if (!inPakket(k, props.plan)) return <Status kind="unk">In Business</Status>;
  return <Status kind="unk">Niet gekoppeld</Status>;
}

function Urgentie(props: { u: VoorbeeldBevinding['urgentie'] }) {
  if (props.u === 'crit') return <Status kind="crit">Nu oppakken</Status>;
  if (props.u === 'warn') return <Status kind="warn">Binnenkort</Status>;
  return <Status kind="ok">In orde</Status>;
}

function Testmodus() {
  return (
    <p class="melding testmodus" role="note">
      <b>Testmodus.</b> Koppelingen worden nog niet echt gemaakt. Je kunt de hele route proberen: er wordt niets met Microsoft, AWS of je
      netwerk verbonden en de uitkomsten zijn voorbeelden.
    </p>
  );
}

export function KoppelingenPage(props: Ctx & { standen: KoppelingStand[]; plan: string | null }) {
  const { org, plan } = props;
  const byId = new Map(props.standen.map((s) => [s.id, s]));
  const actief = props.standen.filter((s) => s.status === 'actief' || s.status === 'let_op').length;
  return (
    <Layout title="Koppelingen" user={props.user} org={org} active="koppelingen">
      <div class="intro">
        <span class="eyebrow">Systemen, opslag en apparaten</span>
        <h1>Koppelingen</h1>
        <p class="lead">
          Van buiten zien we wat iedereen op internet ziet. Met een koppeling kijken we ook naar de instellingen erachter: wie beheerder is, of
          MFA aan staat, of opslag openbaar is. Altijd alleen-lezen, nooit de inhoud van mails of bestanden, en je trekt het met één klik weer in.
        </p>
      </div>
      <Testmodus />

      <section class="niveaus" aria-label="Wat Qbicle ziet">
        <div class="niveau">
          <span class="eyebrow">Altijd</span>
          <h3>Van buiten</h3>
          <p class="small">Domeinen, mail, websites, open poorten en softwareversies. Hier is geen toegang voor nodig.</p>
          <Status kind="ok">Actief</Status>
        </div>
        <div class="niveau">
          <span class="eyebrow">Met toestemming van IT</span>
          <h3>Koppelingen</h3>
          <p class="small">Alleen-lezen toegang tot de instellingen van je clouddiensten en netwerkapparatuur.</p>
          <Status kind={actief > 0 ? 'ok' : 'unk'}>{actief === 1 ? '1 actief' : `${actief} actief`}</Status>
        </div>
        <div class="niveau">
          <span class="eyebrow">In je netwerk</span>
          <h3>Qbicle Connector</h3>
          <p class="small">Een kleine app op kantoor die NAS, printers en camera’s herkent. Zie hieronder bij Netwerk.</p>
        </div>
      </section>

      {CATEGORIEEN.map((cat) => {
        const items = KOPPELINGEN.filter((k) => k.categorie === cat.id);
        return (
          <section class="stack" aria-labelledby={`cat-${cat.id}`}>
            <div class="stack-tight">
              <h2 id={`cat-${cat.id}`}>{cat.naam}</h2>
              <p class="small">{cat.uitleg}</p>
            </div>
            <div class="koppel-grid">
              {items.map((k) => (
                <a class={`card koppel-kaart${k.beschikbaarheid === 'binnenkort' ? ' later' : ''}`} href={`/o/${org.id}/koppelingen/${k.id}`}>
                  <div class="row between">
                    <h3>{k.naam}</h3>
                    <KoppelingStatusBadge k={k} s={byId.get(k.id)} plan={plan} />
                  </div>
                  <p class="small">{k.kort}</p>
                  <p class="meta">
                    {k.methode} · {k.duur}
                    {k.pakket === 'business' ? ' · Business' : ''}
                  </p>
                </a>
              ))}
            </div>
          </section>
        );
      })}

      <section class="card">
        <h2>Hoe we met je gegevens omgaan</h2>
        <ul class="plain">
          <li>We vragen alleen leesrechten. Wijzigen of iets “voor je oplossen” kunnen we niet.</li>
          <li>We lezen instellingen en aantallen, nooit de inhoud van mails, bestanden, chats of databases.</li>
          <li>Sleutels en tokens staan versleuteld en zijn ook voor Qbicle-medewerkers niet in te zien.</li>
          <li>Elke keer dat we gegevens ophalen, staat in het logboek van de koppeling.</li>
          <li>Intrekken kan hier met één klik, en ook bij de dienst zelf. Opgehaalde instellingen wissen we binnen 30 dagen.</li>
        </ul>
      </section>
    </Layout>
  );
}

function Acties(props: { orgId: string; k: Koppeling; s: KoppelingStand; plan: string | null; magWijzigen: boolean }) {
  const { orgId, k, s } = props;
  const base = `/api/v1/organisaties/${orgId}/koppelingen/${k.id}`;
  if (!props.magWijzigen) return <p class="small">Alleen een eigenaar of beheerder van je account kan koppelingen starten of intrekken.</p>;

  if (k.beschikbaarheid === 'binnenkort') {
    return s.interesse ? (
      <p class="melding ok">We laten het je weten zodra {k.naam} beschikbaar is.</p>
    ) : (
      <form data-api={`${base}/interesse`}>
        <FormError />
        <p class="small">Deze koppeling komt na versie 1.0. Laat weten dat je hem wilt gebruiken; dat helpt ons kiezen wat eerst komt.</p>
        <button class="btn secondary" type="submit">
          Laat me weten wanneer het kan
        </button>
      </form>
    );
  }
  if (!inPakket(k, props.plan)) {
    return (
      <div class="stack">
        <p class="small">{k.naam} zit in Qbicle Business, samen met de inventaris van je netwerk en apparaten.</p>
        <a class="btn secondary" href={`/o/${orgId}/abonnement`}>
          Pakket bekijken
        </a>
      </div>
    );
  }
  if (s.status === 'niet_gekoppeld' || s.status === 'ingetrokken') {
    return (
      <form data-api={`${base}/starten`}>
        <FormError />
        <button class="btn" type="submit">
          {s.status === 'ingetrokken' ? 'Opnieuw koppelen' : 'Koppeling starten'}
        </button>
      </form>
    );
  }
  const intrekken = (
    <form
      data-api={`${base}/intrekken`}
      data-bevestig={`${k.naam} intrekken? Qbicle wist de sleutels direct en kan daarna niets meer lezen.`}
    >
      <FormError />
      <button class="btn danger" type="submit">
        Koppeling intrekken
      </button>
    </form>
  );
  if (s.status === 'wacht_op_it' || s.status === 'fout') {
    return (
      <div class="stack">
        <form class="stack" data-api={`${base}/deellink`} data-toon-veld="link" data-toon-in="deellink">
          <FormError />
          <p class="small">Doe je dit niet zelf? Stuur het stappenplan naar je IT-beheerder of IT-partner. De link werkt 7 dagen en toont geen gegevens van je bedrijf.</p>
          <div class="row">
            <button class="btn secondary" type="submit">
              Link voor IT maken
            </button>
          </div>
          <input id="deellink" class="mono" type="text" readonly hidden aria-label="Link voor je IT-beheerder" />
        </form>
        <form class="testbox stack" data-api={`${base}/test-toestemming`}>
          <FormError />
          <p class="small">
            <b>Testmodus:</b> doe alsof IT de stappen heeft doorlopen.
          </p>
          <div class="row">
            <button class="btn" type="submit" name="uitkomst" value="gelukt">
              Toestemming gegeven
            </button>
            <button class="btn secondary" type="submit" name="uitkomst" value="te_veel_rechten">
              Met te veel rechten
            </button>
            <button class="btn secondary" type="submit" name="uitkomst" value="mislukt">
              Mislukt
            </button>
          </div>
        </form>
        {intrekken}
      </div>
    );
  }
  return intrekken;
}

export function KoppelingDetailPage(props: Ctx & { k: Koppeling; s: KoppelingStand; plan: string | null; magWijzigen: boolean }) {
  const { org, k, s } = props;
  const nodig = new Set(k.rechten.map((r) => r.naam));
  const extra = s.verleendeRechten.filter((r) => !nodig.has(r));
  const actief = s.status === 'actief' || s.status === 'let_op';
  return (
    <Layout title={k.naam} user={props.user} org={org} active="koppelingen">
      <a href={`/o/${org.id}/koppelingen`}>← Alle koppelingen</a>
      <div class="intro">
        <div class="row">
          <h1>{k.naam}</h1>
          <KoppelingStatusBadge k={k} s={s} plan={props.plan} />
        </div>
        <p class="lead">{k.kort}</p>
      </div>
      <Testmodus />

      <div class="koppel-detail">
        <div class="stack">
          <section class="card">
            <h2>Status</h2>
            {s.melding ? <p class={`melding ${s.status === 'fout' ? 'crit' : 'warn'}`}>{s.melding}</p> : null}
            <dl class="kv">
              {s.gestartOp ? (
                <>
                  <dt>Gestart</dt>
                  <dd>{tijd(s.gestartOp)}</dd>
                </>
              ) : null}
              {s.gekoppeldOp ? (
                <>
                  <dt>Gekoppeld</dt>
                  <dd>{tijd(s.gekoppeldOp)}</dd>
                </>
              ) : null}
              {s.laatsteRonde ? (
                <>
                  <dt>Laatst gelezen</dt>
                  <dd>{tijd(s.laatsteRonde)} (elke dag opnieuw)</dd>
                </>
              ) : null}
              {s.ingetrokkenOp ? (
                <>
                  <dt>Ingetrokken</dt>
                  <dd>{tijd(s.ingetrokkenOp)}</dd>
                </>
              ) : null}
              <dt>Wie geeft toestemming</dt>
              <dd>{k.wie}</dd>
              <dt>Hoe lang duurt het</dt>
              <dd>{k.duur}</dd>
            </dl>
            <Acties orgId={org.id} k={k} s={s} plan={props.plan} magWijzigen={props.magWijzigen} />
          </section>

          {actief ? (
            <section class="card">
              <h2>Wat we vonden</h2>
              <ul class="bevindingen">
                {s.bevindingen.map((b) => (
                  <li>
                    <Urgentie u={b.urgentie} />
                    <span>
                      <b>{b.titel}</b>
                      {b.actie}
                    </span>
                  </li>
                ))}
              </ul>
              <p class="small">Voorbeelden in testmodus. Straks staan deze bevindingen ook in je overzicht en actielijst.</p>
            </section>
          ) : null}

          <section class="card">
            <h2>Stappenplan voor je IT-beheerder</h2>
            <ol class="steps">
              {k.stappen.map((st) => (
                <li>
                  <span>{st}</span>
                </li>
              ))}
            </ol>
            <p class="small">Intrekken bij de dienst zelf: {k.intrekkenBijDienst}</p>
          </section>
        </div>

        <div class="stack">
          <section class="card">
            <h2>Wat we zien</h2>
            <ul class="check">
              {k.zien.map((z) => (
                <li>{z}</li>
              ))}
            </ul>
            <h3>Wat we niet zien</h3>
            <ul class="kruis">
              {k.nietZien.map((z) => (
                <li>{z}</li>
              ))}
            </ul>
          </section>
          <section class="card">
            <h2>Rechten die we vragen</h2>
            <p class="small">Alleen lezen. Dit is precies de lijst die je IT-beheerder in het toestemmingsscherm ziet.</p>
            <ul class="rechten">
              {k.rechten.map((r) => (
                <li>
                  <code>{r.naam}</code>
                  <span class="small">{r.uitleg}</span>
                  {actief ? (
                    <Status kind={s.verleendeRechten.includes(r.naam) ? 'ok' : 'warn'}>{s.verleendeRechten.includes(r.naam) ? 'Gegeven' : 'Ontbreekt'}</Status>
                  ) : null}
                </li>
              ))}
              {extra.map((r) => (
                <li>
                  <code>{r}</code>
                  <span class="small">Niet nodig voor Qbicle. Haal dit recht weg bij de dienst.</span>
                  <Status kind="warn">Te veel</Status>
                </li>
              ))}
            </ul>
          </section>
          {s.logboek.length ? (
            <section class="card">
              <h2>Logboek</h2>
              <ul class="logboek">
                {s.logboek.map((l) => (
                  <li>
                    <span class="mono small">{tijd(l.tijd)}</span>
                    <span>{l.tekst}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      </div>
    </Layout>
  );
}

/** Openbare pagina voor de IT-beheerder (via deellink). Toont geen gegevens van de klant. */
export function ItStappenplanPage(props: { k: Koppeling; verlooptOp: Date }) {
  const { k } = props;
  return (
    <Layout title={`Stappenplan ${k.naam}`} minimal>
      <div class="intro">
        <span class="eyebrow">Voor de IT-beheerder</span>
        <h1>{k.naam} koppelen aan Qbicle</h1>
        <p class="lead">
          Een klant van je vraagt je om Qbicle alleen-lezen toegang te geven tot {k.naam}. Qbicle leest daarmee instellingen om
          beveiligingsrisico’s te vinden, nooit de inhoud van mails of bestanden.
        </p>
      </div>
      <Testmodus />
      <div class="koppel-detail">
        <div class="stack">
          <section class="card">
            <h2>Zo doe je het</h2>
            <p class="small">
              Nodig: {k.wie}. Duurt {k.duur}.
            </p>
            <ol class="steps">
              {k.stappen.map((st) => (
                <li>
                  <span>{st}</span>
                </li>
              ))}
            </ol>
            <p class="small">Weer intrekken: {k.intrekkenBijDienst}</p>
          </section>
        </div>
        <div class="stack">
          <section class="card">
            <h2>Rechten</h2>
            <ul class="rechten">
              {k.rechten.map((r) => (
                <li>
                  <code>{r.naam}</code>
                  <span class="small">{r.uitleg}</span>
                </li>
              ))}
            </ul>
            <h3>Wat Qbicle niet ziet</h3>
            <ul class="kruis">
              {k.nietZien.map((z) => (
                <li>{z}</li>
              ))}
            </ul>
          </section>
        </div>
      </div>
      <p class="small">Deze link werkt tot en met {datum(props.verlooptOp)}.</p>
    </Layout>
  );
}
