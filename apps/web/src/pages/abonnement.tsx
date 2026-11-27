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

export function FactuurPage(props: Ctx & { inv: Invoice }) {
  const { inv } = props;
  const c = inv.customer;
  return (
    <Layout title={`Factuur ${inv.number}`} user={props.user} org={props.org} active="account">
      <div class="row between no-print">
        <a href={`/o/${props.org.id}/facturen`}>← Terug naar facturen</a>
        <a class="btn secondary small-btn" href={`/o/${props.org.id}/facturen/${inv.id}/pdf`} download>
          Download pdf
        </a>
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
            {inv.customerVatNumber ?? c.btwNummer ? (
              <>
                <dt>Btw-nummer</dt>
                <dd>{inv.customerVatNumber ?? c.btwNummer}</dd>
              </>
            ) : null}
          </dl>
          <dl>
            <dt>Factuurdatum</dt>
            <dd>{datum(inv.issuedAt)}</dd>
            {c.referentie ? (
              <>
                <dt>Uw referentie</dt>
                <dd>{c.referentie}</dd>
              </>
            ) : null}
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
                <td colspan={2}>{inv.reverseCharge ? 'Btw verlegd (0%)' : `Btw ${inv.vatRate.toLocaleString('nl-NL')}%`}</td>
                <td class="num">{euro(inv.vatCents)}</td>
              </tr>
              <tr class="totaal">
                <td colspan={2}>Totaal</td>
                <td class="num">{euro(inv.amountInclCents)}</td>
              </tr>
            </tbody>
          </table>
        </div>
        {inv.reverseCharge ? (
          <p class="melding">
            <b>Btw verlegd</b> (reverse charge, artikel 196 Btw-richtlijn 2006/112/EG). De afnemer voldoet de btw. Btw-nummer afnemer: {inv.customerVatNumber}. Btw-nummer
            Qbicle: {inv.supplierVatNumber ?? 'volgt'}.
          </p>
        ) : null}
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
          {pay.vatCode === 'eu_verlegd' ? `${euro(pay.amountExclCents)} excl. btw, btw verlegd (0%)` : `${euro(pay.amountExclCents)} + ${euro(pay.vatCents)} btw`}
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
