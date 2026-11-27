/** @jsxImportSource hono/jsx */
import type { AuditPackage, BillingOverview, Catalog, Invoice, Payment } from '@qbicle/platform';
import { datum, euro, euroKort, FormError, Layout, Status, type NavOrg, type PageUser } from '../layout.tsx';

type Ctx = { user: PageUser; org: NavOrg };

function StatusBadge(props: { b: BillingOverview }) {
  const { b } = props;
  if (b.toegang === 'proef') return <Status kind="ok">Proef, nog {b.dagenOver} dagen</Status>;
  if (b.toegang === 'actief') {
    return b.abonnement?.cancelAtPeriodEnd ? <Status kind="warn">Opgezegd, loopt tot {datum(b.abonnement.currentPeriodEnd)}</Status> : <Status kind="ok">Actief</Status>;
  }
  if (b.toegang === 'betaling_nodig') return <Status kind="crit">Betaling nodig</Status>;
  return <Status kind="unk">Geen abonnement</Status>;
}

function PayButton(props: { orgId: string; label: string; secondary?: boolean }) {
  return (
    <form data-api={`/api/v1/organisaties/${props.orgId}/abonnement/betalen`} data-next-veld="betaalpagina">
      <FormError />
      <button class={`btn${props.secondary ? ' secondary' : ''}`} type="submit">
        {props.label}
      </button>
    </form>
  );
}

export function WelkomPage(props: Ctx & { b: BillingOverview; catalog: Catalog }) {
  const { b, org } = props;
  const sub = b.abonnement;
  return (
    <Layout title="Welkom" user={props.user} org={org}>
      <div class="intro">
        <span class="eyebrow">Account aangemaakt</span>
        <h1>Welkom bij Qbicle, {org.name}</h1>
        {sub && b.toegang === 'proef' ? (
          <p class="lead">
            Je proef van {sub.pakket?.naam ?? sub.plan} loopt tot en met {datum(sub.trialEndsAt)}. Je hoeft nu niets te betalen.
          </p>
        ) : null}
      </div>
      <div class="grid">
        <section class="card">
          <h2>Zo ga je verder</h2>
          <ol class="steps">
            <li>
              <span>
                <b>Voeg je domeinnaam toe</b>
                Bijvoorbeeld jouwbedrijf.nl. Vanaf daar vinden we je websites, mail, servers en clouddiensten.
              </span>
            </li>
            <li>
              <span>
                <b>Laat zien dat het domein van jou is</b>
                Met een DNS-record of een mail naar admin@ of postmaster@ op je domein. Je IT-partner kan dit ook doen.
              </span>
            </li>
            <li>
              <span>
                <b>Bekijk je eerste overzicht</b>
                Met urgentie, een korte actielijst en waar elke bevinding vandaan komt.
              </span>
            </li>
          </ol>
          <a class="btn" href={`/o/${org.id}/overzicht`}>
            Naar mijn overzicht
          </a>
        </section>
        {sub && b.magBeheren && b.toegang === 'proef' ? (
          <section class="card">
            <h2>Liever meteen regelen?</h2>
            <p class="small">
              Je kunt nu al betalen. Je proefdagen blijven gewoon staan: de betaalde periode begint op {datum(sub.trialEndsAt)}.
            </p>
            <PayButton orgId={org.id} label="Nu betalen" secondary />
          </section>
        ) : null}
      </div>
    </Layout>
  );
}

function PaymentStatus(props: { p: Payment }) {
  const s = props.p.status;
  if (s === 'betaald') return <Status kind="ok">Betaald</Status>;
  if (s === 'open') return <Status kind="warn">Open</Status>;
  if (s === 'mislukt') return <Status kind="crit">Mislukt</Status>;
  return <Status kind="unk">{s === 'verlopen' ? 'Verlopen' : 'Geannuleerd'}</Status>;
}

export function AbonnementPage(props: Ctx & { b: BillingOverview; catalog: Catalog; invoices: Invoice[] }) {
  const { b, org, catalog } = props;
  const sub = b.abonnement;
  const invByPayment = new Map(props.invoices.map((i) => [i.paymentId, i]));
  return (
    <Layout title="Abonnement" user={props.user} org={org} active="abonnement">
      <div class="intro">
        <h1>Abonnement</h1>
        <p class="lead">Je pakket, betalingen en facturen. Prijzen zijn exclusief {catalog.btwPercentage}% btw.</p>
      </div>

      <section class="card">
        <div class="row between">
          <div class="stack">
            <h2>{sub?.pakket?.naam ?? 'Geen pakket'}</h2>
            <StatusBadge b={b} />
          </div>
          {sub ? (
            <div class="price">
              <b>{euroKort(sub.monthlyPriceCents)}</b>
              <span>per maand, {sub.interval === 'jaar' ? 'jaarlijks betaald' : 'maandelijks betaald'}</span>
            </div>
          ) : null}
        </div>
        {sub && b.toegang === 'proef' ? (
          <p>
            Je proef loopt tot en met {datum(sub.trialEndsAt)}. Betaal je eerder, dan begint de betaalde periode pas daarna.
          </p>
        ) : null}
        {sub && b.toegang === 'actief' && !sub.cancelAtPeriodEnd ? (
          <p>
            Betaald tot en met {datum(sub.currentPeriodEnd && new Date(new Date(sub.currentPeriodEnd).getTime() - 86_400_000))}.
          </p>
        ) : null}
        {b.toegang === 'betaling_nodig' ? (
          <p class="melding warn">Je proef of betaalde periode is voorbij. Betaal om je overzicht en de wekelijkse controle te houden.</p>
        ) : null}
        {b.openBetaling ? (
          <p class="melding">
            Er staat een betaling open van {euro(b.openBetaling.amountInclCents)}.{' '}
            {b.openBetaling.checkoutUrl ? <a href={b.openBetaling.checkoutUrl}>Ga verder met betalen</a> : null}
          </p>
        ) : null}
        {b.magBeheren && sub ? (
          <div class="row">
            {b.toegang !== 'actief' || sub.cancelAtPeriodEnd ? <PayButton orgId={org.id} label={b.toegang === 'proef' ? 'Nu betalen' : 'Betalen'} /> : null}
            {b.toegang === 'actief' && !sub.cancelAtPeriodEnd ? <PayButton orgId={org.id} label="Volgende periode vooruitbetalen" secondary /> : null}
          </div>
        ) : null}
        {!b.magBeheren ? <p class="small">Alleen de eigenaar van het account kan betalen of het pakket wijzigen.</p> : null}
      </section>

      {b.magBeheren ? (
        <section class="card">
          <h2>Pakket wijzigen</h2>
          <p class="small">Een nieuw pakket geldt meteen. De nieuwe prijs gaat in bij de volgende betaling.</p>
          <form class="stack" data-api={`/api/v1/organisaties/${org.id}/abonnement`} data-method="PUT">
            <FormError />
            <div class="grid">
              <label>
                Pakket
                <select name="pakket">
                  {catalog.plans.map((p) => (
                    <option value={p.id} selected={sub?.plan === p.id}>
                      {p.naam} ({euroKort(p.maandprijsCenten.jaar)} p/m bij jaarbetaling, {euroKort(p.maandprijsCenten.maand)} bij maandbetaling)
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Betalen per
                <select name="interval">
                  <option value="jaar" selected={sub?.interval !== 'maand'}>
                    Jaar
                  </option>
                  <option value="maand" selected={sub?.interval === 'maand'}>
                    Maand
                  </option>
                </select>
              </label>
            </div>
            <div class="row">
              <button class="btn secondary" type="submit">
                {sub ? 'Wijzigen' : 'Pakket kiezen'}
              </button>
            </div>
          </form>
          {sub && !sub.cancelAtPeriodEnd ? (
            <form
              data-api={`/api/v1/organisaties/${org.id}/abonnement/opzeggen`}
              data-bevestig={
                b.toegang === 'actief'
                  ? 'Weet je het zeker? Je abonnement loopt door tot het einde van de betaalde periode en stopt dan.'
                  : 'Weet je het zeker? Je proef stopt direct.'
              }
            >
              <FormError />
              <button class="linkbtn" type="submit">
                Abonnement opzeggen
              </button>
            </form>
          ) : null}
        </section>
      ) : null}

      <section class="card">
        <h2>Betalingen en facturen</h2>
        {b.betalingen.length === 0 ? (
          <p class="small">Nog geen betalingen.</p>
        ) : (
          <div class="table-wrap">
            <table class="table">
              <thead>
                <tr>
                  <th>Datum</th>
                  <th>Omschrijving</th>
                  <th>Status</th>
                  <th class="num">Bedrag incl. btw</th>
                  <th>Factuur</th>
                </tr>
              </thead>
              <tbody>
                {b.betalingen.map((p) => {
                  const inv = invByPayment.get(p.id);
                  return (
                    <tr>
                      <td>{datum(p.createdAt)}</td>
                      <td>{p.description}</td>
                      <td>
                        <PaymentStatus p={p} />
                      </td>
                      <td class="num">{euro(p.amountInclCents)}</td>
                      <td>{inv ? <a href={`/o/${org.id}/facturen/${inv.id}`}>{inv.number}</a> : null}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </Layout>
  );
}

export function FactuurPage(props: Ctx & { inv: Invoice }) {
  const { inv } = props;
  const c = inv.customer;
  return (
    <Layout title={`Factuur ${inv.number}`} user={props.user} org={props.org} active="abonnement">
      <div class="row between no-print">
        <a href={`/o/${props.org.id}/abonnement`}>← Terug naar abonnement</a>
        <span class="small">Opslaan als pdf: gebruik Afdrukken in je browser.</span>
      </div>
      <article class="factuur">
        <div class="kop">
          <img src="/static/woordmerk.png" alt="Qbicle" width="110" height="47" />
          <div>
            <h1>Factuur</h1>
            <p class="mono">{inv.number}</p>
          </div>
        </div>
        <div class="grid">
          <dl>
            <dt>Aan</dt>
            <dd>{c.naam ?? c.organisatie}</dd>
            {c.adres ? (
              <>
                <dt></dt>
                <dd>{c.adres}</dd>
              </>
            ) : null}
            {c.postcode || c.plaats ? (
              <>
                <dt></dt>
                <dd>
                  {c.postcode} {c.plaats} {c.land !== 'NL' ? c.land : ''}
                </dd>
              </>
            ) : null}
            {c.kvk ? (
              <>
                <dt>KvK</dt>
                <dd>{c.kvk}</dd>
              </>
            ) : null}
            {c.btwNummer ? (
              <>
                <dt>Btw-nummer</dt>
                <dd>{c.btwNummer}</dd>
              </>
            ) : null}
          </dl>
          <dl>
            <dt>Factuurdatum</dt>
            <dd>{datum(inv.issuedAt)}</dd>
            <dt>Status</dt>
            <dd>Betaald</dd>
          </dl>
        </div>
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>Omschrijving</th>
                <th class="num">Aantal</th>
                <th class="num">Bedrag</th>
              </tr>
            </thead>
            <tbody>
              {inv.lines.map((l) => (
                <tr>
                  <td>{l.omschrijving}</td>
                  <td class="num">{l.aantal}</td>
                  <td class="num">{euro(l.totaalExclCenten)}</td>
                </tr>
              ))}
              <tr>
                <td colspan={2}>Subtotaal</td>
                <td class="num">{euro(inv.amountExclCents)}</td>
              </tr>
              <tr>
                <td colspan={2}>Btw {inv.vatRate.toLocaleString('nl-NL')}%</td>
                <td class="num">{euro(inv.vatCents)}</td>
              </tr>
              <tr class="totaal">
                <td colspan={2}>Totaal</td>
                <td class="num">{euro(inv.amountInclCents)}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p class="small">
          Gegevens van Qbicle als leverancier (bedrijfsnaam, adres, KvK en btw-nummer) volgen zodra de BV is opgericht. Tot die tijd is dit een testfactuur.
        </p>
      </article>
    </Layout>
  );
}

export function AuditBestellenPage(props: Ctx & { packages: AuditPackage[]; catalog: Catalog; magBestellen: boolean }) {
  const bestelbaar = props.packages.filter((p) => p.bestelbaar);
  return (
    <Layout title="Qbicle Audit bestellen" user={props.user} org={props.org}>
      <div class="intro">
        <span class="eyebrow">Qbicle Audit</span>
        <h1>Welke onderneming wil je laten doorlichten?</h1>
        <p class="lead">
          We kijken alleen van buitenaf, zonder iets te proberen of in te loggen. Voor meer dan dat is schriftelijke toestemming van de verkoper nodig.
        </p>
      </div>
      {props.magBestellen ? (
        <form
          class="card narrow"
          data-api={`/api/v1/organisaties/${props.org.id}/audit-opdrachten`}
          data-next-veld="betaalpagina"
        >
          <FormError />
          <label>
            Pakket
            <select name="pakket">
              {bestelbaar.map((p) => (
                <option value={p.id}>
                  {p.naam}: {euroKort(p.prijsCenten)} excl. btw, tot {p.maxDomeinen} domeinen
                </option>
              ))}
            </select>
          </label>
          <label>
            Naam van de doelonderneming
            <input type="text" name="doelbedrijf" required maxlength={120} />
          </label>
          <label>
            Domeinnamen
            <span class="hint">Eén per regel, bijvoorbeeld doelbedrijf.nl</span>
            <textarea name="domeinen" data-lijst required></textarea>
          </label>
          <button class="btn wide" type="submit">
            Naar betalen
          </button>
          <p class="small">Na betaling ontvang je binnen 5 werkdagen het rapport.</p>
        </form>
      ) : (
        <p class="melding">Alleen de eigenaar van het account kan een Audit bestellen.</p>
      )}
    </Layout>
  );
}

export function TestBetaalPage(props: Ctx & { pay: Payment }) {
  const { pay } = props;
  return (
    <Layout title="Testbetaling" user={props.user} minimal>
      <section class="card narrow testbank">
        <span class="eyebrow">Testbetaling</span>
        <h1>Betalen</h1>
        <p class="melding warn">Dit is een testomgeving. Er wordt geen geld afgeschreven. Straks staat hier de betaalpagina van Mollie (iDEAL, creditcard, SEPA).</p>
        <p>{pay.description}</p>
        <p class="bedrag">{euro(pay.amountInclCents)}</p>
        <p class="small">
          {euro(pay.amountExclCents)} + {euro(pay.vatCents)} btw
        </p>
        {pay.status === 'open' ? (
          <form class="stack" data-api={`/api/v1/betalingen/${pay.id}/test-uitkomst`} data-next={`/betaling/${pay.id}`}>
            <FormError />
            <button class="btn wide" type="submit" name="uitkomst" value="betaald">
              Betaling geslaagd
            </button>
            <button class="btn secondary wide" type="submit" name="uitkomst" value="mislukt">
              Betaling mislukt
            </button>
            <button class="linkbtn" type="submit" name="uitkomst" value="geannuleerd">
              Annuleren
            </button>
          </form>
        ) : (
          <p>
            Deze betaling is al afgehandeld. <a href={`/betaling/${pay.id}`}>Bekijk de status</a>.
          </p>
        )}
      </section>
    </Layout>
  );
}

export function BetalingPage(props: Ctx & { pay: Payment; invoice?: Invoice | undefined }) {
  const { pay, org } = props;
  return (
    <Layout title="Betaling" user={props.user} org={org}>
      <section class="card narrow">
        {pay.status === 'betaald' ? (
          <>
            <Status kind="ok">Betaald</Status>
            <h1>Bedankt, je betaling is gelukt</h1>
            <p>
              We hebben {euro(pay.amountInclCents)} ontvangen voor: {pay.description}.
            </p>
            {props.invoice ? (
              <p>
                Je factuur <a href={`/o/${org.id}/facturen/${props.invoice.id}`}>{props.invoice.number}</a> staat bij Abonnement.
              </p>
            ) : null}
            <a class="btn" href={pay.auditOrderId ? `/o/${org.id}/overzicht` : `/o/${org.id}/overzicht`}>
              Naar mijn overzicht
            </a>
          </>
        ) : pay.status === 'open' ? (
          <>
            <Status kind="warn">Wacht op bevestiging</Status>
            <h1>We wachten op je bank</h1>
            <p>Dit duurt meestal een paar seconden. Ververs de pagina zo.</p>
            {pay.checkoutUrl ? (
              <a class="btn secondary" href={pay.checkoutUrl}>
                Terug naar de betaalpagina
              </a>
            ) : null}
          </>
        ) : (
          <>
            <Status kind="crit">{pay.status === 'mislukt' ? 'Mislukt' : 'Niet betaald'}</Status>
            <h1>De betaling is niet gelukt</h1>
            <p>Er is niets afgeschreven. Je kunt het opnieuw proberen.</p>
            <a class="btn" href={`/o/${org.id}/abonnement`}>
              Opnieuw proberen
            </a>
          </>
        )}
      </section>
    </Layout>
  );
}

export function KiesOrganisatiePage(props: { user: PageUser; orgs: NavOrg[] }) {
  return (
    <Layout title="Kies een organisatie" user={props.user}>
      <section class="card narrow">
        <h1>Kies een organisatie</h1>
        {props.orgs.length === 0 ? (
          <p>
            Je hebt nog geen organisatie. <a href="/aanmelden">Kies een pakket</a> om te beginnen.
          </p>
        ) : (
          <ul class="stack">
            {props.orgs.map((o) => (
              <li>
                <a href={`/o/${o.id}/overzicht`}>{o.name}</a>
              </li>
            ))}
          </ul>
        )}
      </section>
    </Layout>
  );
}
