/** @jsxImportSource hono/jsx */
import type { BillingInterval, BillingOverview, Catalog, HistoryRow, Invoice, Plan, PlanChangePreview } from '@qbicle/platform';
import { datum, euro, euroKort, FormError, Layout, Status, type NavOrg, type PageUser } from '../layout.tsx';

type Ctx = { user: PageUser; org: NavOrg };

/** Navigatie tussen Account, Abonnement en Facturen. */
export function AccountNav(props: { orgId: string; active: 'account' | 'abonnement' | 'facturen' }) {
  const item = (key: typeof props.active, href: string, label: string) => (
    <a href={href} aria-current={props.active === key ? 'page' : undefined}>
      {label}
    </a>
  );
  return (
    <nav class="subnav" aria-label="Account">
      {item('account', `/o/${props.orgId}/account`, 'Gegevens en gebruikers')}
      {item('abonnement', `/o/${props.orgId}/abonnement`, 'Abonnement en betalen')}
      {item('facturen', `/o/${props.orgId}/facturen`, 'Facturen')}
    </nav>
  );
}

const per = (iv: BillingInterval) => (iv === 'jaar' ? 'per jaar' : 'per maand');
const termijn = (iv: BillingInterval) => (iv === 'jaar' ? 'jaarlijks' : 'maandelijks');
/** Laatste dag van een periode die op `end` eindigt (exclusief). */
const totEnMet = (end: Date | string | null | undefined) => (end ? datum(new Date(new Date(end).getTime() - 86_400_000)) : '');

export function StatusBadge(props: { b: BillingOverview }) {
  const { b } = props;
  if (b.toegang === 'proef') return <Status kind="ok">Proef, nog {b.dagenOver} dagen</Status>;
  if (b.toegang === 'actief') {
    return b.abonnement?.cancelAtPeriodEnd ? <Status kind="warn">Opgezegd</Status> : <Status kind="ok">Actief</Status>;
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

function Meter(props: { label: string; used: number; max: number }) {
  const pct = Math.min(100, Math.round((props.used / Math.max(1, props.max)) * 100));
  const over = props.used > props.max;
  return (
    <div class="meter">
      <div class="row between">
        <span>{props.label}</span>
        <span class={over ? 'st-text-crit' : 'small'}>
          {props.used} van {props.max}
        </span>
      </div>
      <div class="meter-bar" role="img" aria-label={`${props.used} van ${props.max} ${props.label.toLowerCase()}`}>
        <i class={`w${Math.round(pct / 5) * 5}${over ? ' over' : ''}`}></i>
      </div>
    </div>
  );
}

function MijnPakket(props: Ctx & { b: BillingOverview }) {
  const { b, org } = props;
  const sub = b.abonnement;
  const pk = sub?.pakket;
  const bw = b.betaalwijze;
  return (
    <section class="card">
      <div class="row between">
        <div class="stack tight">
          <span class="eyebrow">Je pakket</span>
          <h2>{pk?.naam ?? 'Geen pakket'}</h2>
          <StatusBadge b={b} />
        </div>
        {sub ? (
          <div class="price">
            <b>{euroKort(sub.monthlyPriceCents)}</b>
            <span>per maand excl. btw, {termijn(sub.interval)} betaald</span>
          </div>
        ) : null}
      </div>

      {sub && b.toegang === 'proef' ? (
        <p>Je proef loopt tot en met {datum(sub.trialEndsAt)}. Betaal je eerder, dan begint de betaalde periode pas daarna. Je verliest dus geen proefdagen.</p>
      ) : null}
      {sub && b.toegang === 'actief' && !sub.cancelAtPeriodEnd ? <p>Betaald tot en met {totEnMet(sub.currentPeriodEnd)}.</p> : null}
      {sub && b.toegang === 'actief' && sub.cancelAtPeriodEnd ? (
        <div class="melding warn stack tight">
          <span>
            Je hebt opgezegd. Je houdt alles tot en met {totEnMet(sub.currentPeriodEnd)}; daarna stoppen de wekelijkse controles en de meldingen.
          </span>
          {b.magBeheren ? (
            <form data-api={`/api/v1/organisaties/${org.id}/abonnement/heractiveren`}>
              <FormError />
              <button class="btn secondary small-btn" type="submit">
                Opzegging intrekken
              </button>
            </form>
          ) : null}
        </div>
      ) : null}
      {b.toegang === 'betaling_nodig' ? (
        <p class="melding warn">Je proef of betaalde periode is voorbij. Betaal om je overzicht en de wekelijkse controle te houden.</p>
      ) : null}

      {b.gepland ? (
        <div class="melding stack tight">
          <span>
            Gepland: vanaf {datum(b.gepland.per)} wordt je pakket <b>{b.gepland.pakket?.naam ?? 'onbekend'}</b>, {termijn(b.gepland.interval)} betaald. Tot die tijd houd je wat je
            nu hebt.
          </span>
          {b.magBeheren ? (
            <form data-api={`/api/v1/organisaties/${org.id}/abonnement/geplande-wijziging`} data-method="DELETE">
              <FormError />
              <button class="linkbtn" type="submit">
                Toch niet wijzigen
              </button>
            </form>
          ) : null}
        </div>
      ) : null}

      {b.openBetaling ? (
        <p class="melding">
          Er staat een betaling open van {euro(b.openBetaling.amountInclCents)} ({b.openBetaling.description}).{' '}
          {b.openBetaling.checkoutUrl && b.magBeheren ? <a href={b.openBetaling.checkoutUrl}>Ga verder met betalen</a> : null}
        </p>
      ) : null}

      {b.volgendeBetaling ? (
        <dl class="dl">
          <dt>Volgende betaling</dt>
          <dd>
            <b>{euro(b.volgendeBetaling.inclCents)}</b> incl. btw op {datum(b.volgendeBetaling.datum)}
            <span class="small">
              {' '}
              ({euro(b.volgendeBetaling.exclCents)} excl. btw, {b.volgendeBetaling.pakket?.naam ?? ''} {per(b.volgendeBetaling.interval)})
            </span>
          </dd>
          <dt>Hoe</dt>
          <dd>
            {bw.methode === 'factuur'
              ? `Je krijgt een factuur met ${bw.betaaltermijnDagen} dagen betaaltermijn.`
              : bw.mandaat
                ? 'Automatisch via incasso. Je hoeft niets te doen.'
                : b.toegang === 'proef'
                  ? 'Je betaalt zelf voor het einde van je proef (iDEAL, kaart of SEPA). Daarna gaat het automatisch.'
                  : 'Je betaalt zelf via een betaallink.'}
          </dd>
        </dl>
      ) : null}

      {pk ? (
        <div class="grid">
          <Meter label="Gebruikers" used={b.gebruik.gebruikers} max={pk.limieten.gebruikers} />
          <Meter label="Domeinen" used={b.gebruik.domeinen} max={pk.limieten.domeinen} />
        </div>
      ) : null}

      {b.magBeheren && sub ? (
        <div class="row">
          {b.toegang !== 'actief' ? <PayButton orgId={org.id} label={b.toegang === 'proef' ? 'Nu betalen' : 'Betalen'} /> : null}
          {b.toegang === 'actief' && !sub.cancelAtPeriodEnd && !b.openBetaling ? <PayButton orgId={org.id} label="Volgende periode vooruitbetalen" secondary /> : null}
        </div>
      ) : null}
      {!b.magBeheren ? <p class="small">Alleen de eigenaar van het account kan betalen of het pakket wijzigen.</p> : null}
    </section>
  );
}

function PakketKiezen(props: Ctx & { b: BillingOverview; catalog: Catalog }) {
  const { b, org, catalog } = props;
  const sub = b.abonnement;
  return (
    <section class="card" id="wijzigen">
      <h2>Pakket wijzigen</h2>
      <p class="small">
        Kies een pakket en betaaltermijn. Je ziet eerst wat het kost en wanneer het ingaat, pas daarna bevestig je. Groter pakket: meteen, je betaalt alleen het verschil voor
        de resterende tijd. Kleiner pakket of andere termijn: gaat in na je betaalde periode.
      </p>
      <div class="plans">
        {catalog.plans.map((pl: Plan) => {
          const huidig = sub?.plan === pl.id && b.toegang !== 'geen_abonnement';
          return (
            <div class={`plan ${pl.product === 'corporate' ? 'corporate' : ''}${huidig ? ' huidig' : ''}`}>
              <span class="accent"></span>
              <div class="row between">
                <h3>{pl.naam}</h3>
                {huidig ? <span class="badge">Je huidige pakket</span> : pl.aanbevolen ? <span class="badge aanbevolen">Aanbevolen</span> : null}
              </div>
              <p class="small">{pl.kort}</p>
              <ul>
                {pl.functies.slice(0, 4).map((f) => (
                  <li>{f}</li>
                ))}
                <li>
                  Tot {pl.limieten.gebruikers} gebruikers en {pl.limieten.domeinen} domeinen
                </li>
              </ul>
              {b.magBeheren ? (
                <div class="stack tight">
                  {(['jaar', 'maand'] as BillingInterval[]).map((iv) => {
                    const isNow = huidig && sub?.interval === iv;
                    return isNow ? (
                      <span class="keuze huidig">
                        {euroKort(pl.maandprijsCenten[iv])} p/m, {termijn(iv)} <span class="small">(nu)</span>
                      </span>
                    ) : (
                      <a class="keuze" href={`/o/${org.id}/abonnement/wijzigen?pakket=${pl.id}&interval=${iv}`}>
                        {euroKort(pl.maandprijsCenten[iv])} p/m, {termijn(iv)}
                        {iv === 'jaar' ? <span class="korting"> 2 maanden voordeliger</span> : null}
                        <span aria-hidden="true">→</span>
                      </a>
                    );
                  })}
                </div>
              ) : (
                <p class="small">
                  {euroKort(pl.maandprijsCenten.jaar)} p/m bij jaarbetaling, {euroKort(pl.maandprijsCenten.maand)} bij maandbetaling
                </p>
              )}
            </div>
          );
        })}
      </div>
      <p class="small">Alle prijzen exclusief {catalog.btwPercentage}% btw.</p>
    </section>
  );
}

function Betaalwijze(props: Ctx & { b: BillingOverview }) {
  const { b, org } = props;
  const bw = b.betaalwijze;
  return (
    <section class="card" id="betaalwijze">
      <h2>Betaalwijze</h2>
      {bw.methode === 'factuur' ? (
        <>
          <p>
            <b>Op factuur.</b> Je krijgt per periode een factuur op het e-mailadres voor facturen en betaalt binnen {bw.betaaltermijnDagen} dagen. Dit is op afspraak met Qbicle
            ingesteld.
          </p>
          <p class="small">
            Wil je toch automatische incasso? Mail ons, dan zetten we het om. <a href={`/o/${org.id}/account#bedrijf`}>Factuurgegevens controleren</a>
          </p>
        </>
      ) : (
        <>
          <p>
            <b>Automatische incasso.</b> Je betaalt één keer zelf (iDEAL, kaart of SEPA). Daarmee geef je toestemming voor automatische incasso van de volgende betalingen. Datum en
            bedrag van de volgende incasso zie je hierboven altijd vooraf, en je kunt een incasso binnen 8 weken terugboeken bij je bank.
          </p>
          {bw.mandaat ? (
            <div class="mandaat row between">
              <div>
                <b>{bw.mandaat.method === 'creditcard' ? 'Creditcard' : 'SEPA-machtiging'}</b>
                <span class="small">
                  {' '}
                  {bw.mandaat.accountHolder ?? ''} {bw.mandaat.accountLast4 ? `· rekening eindigt op ${bw.mandaat.accountLast4}` : ''} · sinds {datum(bw.mandaat.createdAt)}
                </span>
              </div>
              {b.magBeheren ? (
                <form
                  data-api={`/api/v1/organisaties/${org.id}/machtiging`}
                  data-method="DELETE"
                  data-bevestig="Machtiging intrekken? Je volgende betaling doe je dan zelf via een betaallink. Je abonnement loopt gewoon door."
                >
                  <FormError />
                  <button class="linkbtn" type="submit">
                    Machtiging intrekken
                  </button>
                </form>
              ) : null}
            </div>
          ) : (
            <p class="melding">Er is nog geen machtiging. Die ontstaat bij je eerste betaling.</p>
          )}
          {b.magBeheren ? (
            bw.factuurAangevraagdOp ? (
              <p class="melding ok">Je aanvraag om op factuur te betalen is binnen ({datum(bw.factuurAangevraagdOp)}). We nemen binnen twee werkdagen contact op.</p>
            ) : (
              <details class="uitklap">
                <summary>Liever op factuur betalen?</summary>
                <form class="stack" data-api={`/api/v1/organisaties/${org.id}/betaalwijze/factuur-aanvragen`}>
                  <FormError />
                  <p class="small">Kan op afspraak, bijvoorbeeld als je organisatie met inkoopordernummers werkt of jaarlijks vooraf wil betalen op factuur.</p>
                  <label>
                    Waarom wil je op factuur betalen?
                    <textarea name="toelichting" required minlength={5} maxlength={600} placeholder="Bijvoorbeeld: wij werken met inkoopordernummers"></textarea>
                  </label>
                  <button class="btn secondary" type="submit">
                    Aanvragen
                  </button>
                </form>
              </details>
            )
          ) : null}
        </>
      )}
    </section>
  );
}

function LaatsteFacturen(props: Ctx & { invoices: Invoice[] }) {
  const { org, invoices } = props;
  return (
    <section class="card">
      <div class="row between">
        <h2>Laatste facturen</h2>
        <a href={`/o/${org.id}/facturen`}>Alle facturen en betalingen</a>
      </div>
      {invoices.length === 0 ? (
        <p class="small">Nog geen facturen. Je eerste factuur komt na je eerste betaling.</p>
      ) : (
        <div class="table-wrap">
          <table class="table">
            <tbody>
              {invoices.slice(0, 3).map((i) => (
                <tr>
                  <td>
                    <a href={`/o/${org.id}/facturen/${i.id}`}>{i.number}</a>
                  </td>
                  <td>{datum(i.issuedAt)}</td>
                  <td>{i.lines[0]?.omschrijving}</td>
                  <td class="num">{euro(i.amountInclCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function AbonnementPage(props: Ctx & { b: BillingOverview; catalog: Catalog; invoices: Invoice[]; actieNodig?: HistoryRow[] }) {
  const { b, org } = props;
  const sub = b.abonnement;
  return (
    <Layout title="Abonnement" user={props.user} org={org} active="account">
      <div class="intro">
        <h1>Abonnement en betalen</h1>
        <p class="lead">Je pakket, wat je volgende betaling is en hoe je betaalt. Prijzen zijn exclusief {props.catalog.btwPercentage}% btw.</p>
      </div>
      <AccountNav orgId={org.id} active="abonnement" />
      {props.actieNodig?.length ? (
        <p class="melding warn" role="alert">
          Een betaling van {euro(props.actieNodig[0]!.payment.amountInclCents)} is niet gelukt. <a href={`/o/${org.id}/facturen`}>Bekijk en betaal opnieuw</a>
        </p>
      ) : null}
      <MijnPakket {...props} />
      <PakketKiezen {...props} />
      {b.magBeheren || b.betaalwijze.mandaat ? <Betaalwijze {...props} /> : null}
      <LaatsteFacturen org={org} user={props.user} invoices={props.invoices} />
      {b.magBeheren && sub && !sub.cancelAtPeriodEnd && b.toegang !== 'geen_abonnement' ? (
        <p class="small">
          Wil je stoppen? <a href={`/o/${org.id}/abonnement/opzeggen`}>Abonnement opzeggen</a>
        </p>
      ) : null}
    </Layout>
  );
}

// Bevestigen van een wissel -----------------------------------------------------------------

function Uitleg(props: { w: PlanChangePreview; proefTot: Date | null }) {
  const { w } = props;
  const naam = w.naar.plan.naam;
  const nb = w.volgendeBetaling;
  const volgende = (
    <li>
      Daarna betaal je {euro(nb.exclCents)} excl. btw {per(nb.interval)} ({euro(nb.inclCents)} incl. btw){nb.datum ? <>, voor het eerst op {datum(nb.datum)}</> : null}.
    </li>
  );
  switch (w.soort) {
    case 'gelijk':
      return (
        <ul class="uitleg">
          <li>Dit is al je pakket. Staat er een wijziging of opzegging gepland, dan vervalt die en blijft alles zoals het nu is.</li>
        </ul>
      );
    case 'nieuw':
      return (
        <ul class="uitleg">
          <li>Je kiest {naam}, {termijn(w.naar.interval)} betaald.</li>
          {volgende}
        </ul>
      );
    case 'direct':
      return (
        <ul class="uitleg">
          <li>{naam} geldt meteen. Je betaalt nu niets extra.</li>
          {props.proefTot ? <li>Je proef loopt gewoon door tot en met {datum(props.proefTot)}.</li> : null}
          {volgende}
        </ul>
      );
    case 'upgrade':
      return (
        <ul class="uitleg">
          <li>Je krijgt meteen alles uit {naam}.</li>
          {w.bijbetalingExclCents > 0 ? (
            <li>
              Voor de resterende {w.restDagen} dagen van je betaalde periode betaal je nu alleen het verschil: <b>{euro(w.bijbetalingExclCents)}</b> excl. btw (
              {euro(w.bijbetalingInclCents)} incl. btw). Het nieuwe pakket gaat in zodra die betaling binnen is.
            </li>
          ) : (
            <li>Je betaalt nu niets extra.</li>
          )}
          {w.van && w.naar.interval !== w.van.interval ? <li>De nieuwe betaaltermijn ({termijn(w.naar.interval)}) gaat in bij je volgende periode.</li> : null}
          {volgende}
        </ul>
      );
    case 'downgrade':
    case 'termijn':
      return (
        <ul class="uitleg">
          <li>
            Je houdt {w.van?.plan?.naam ?? 'je huidige pakket'} tot en met {totEnMet(w.ingangsdatum)}. Daarvoor heb je al betaald, dus je krijgt niets terug en betaalt niets extra.
          </li>
          <li>
            Vanaf {datum(w.ingangsdatum)} geldt {naam}, {termijn(w.naar.interval)} betaald.
          </li>
          {volgende}
          <li>Je kunt dit tot die datum terugdraaien.</li>
        </ul>
      );
  }
}

export function WijzigenPage(props: Ctx & { w: PlanChangePreview; magBeheren: boolean; proefTot: Date | null }) {
  const { w, org } = props;
  const titel =
    w.soort === 'upgrade' ? `Upgraden naar ${w.naar.plan.naam}` : w.soort === 'downgrade' ? `Overstappen naar ${w.naar.plan.naam}` : w.soort === 'termijn' ? 'Betaaltermijn wijzigen' : `${w.naar.plan.naam} kiezen`;
  const knop =
    w.soort === 'upgrade' && w.bijbetalingExclCents > 0
      ? `Bevestigen en ${euro(w.bijbetalingInclCents)} betalen`
      : w.soort === 'downgrade' || w.soort === 'termijn'
        ? `Bevestigen, gaat in op ${datum(w.ingangsdatum)}`
        : 'Bevestigen';
  return (
    <Layout title={titel} user={props.user} org={org} active="account">
      <a href={`/o/${org.id}/abonnement#wijzigen`}>← Terug naar abonnement</a>
      <section class="card narrow-wide">
        <span class="eyebrow">Controleer je wijziging</span>
        <h1>{titel}</h1>
        {w.van ? (
          <div class="vannaar">
            <div>
              <span class="small">Nu</span>
              <b>{w.van.plan?.naam ?? '–'}</b>
              <span class="small">
                {euroKort(w.van.maandprijsCenten)} p/m, {termijn(w.van.interval)}
              </span>
            </div>
            <span aria-hidden="true" class="pijl">
              →
            </span>
            <div>
              <span class="small">Straks</span>
              <b>{w.naar.plan.naam}</b>
              <span class="small">
                {euroKort(w.naar.maandprijsCenten)} p/m, {termijn(w.naar.interval)}
              </span>
            </div>
          </div>
        ) : null}
        <Uitleg w={w} proefTot={props.proefTot} />
        {w.waarschuwingen.map((t) => (
          <p class="melding warn">{t}</p>
        ))}
        {props.magBeheren ? (
          <form
            class="row"
            data-api={`/api/v1/organisaties/${org.id}/abonnement`}
            data-method="PUT"
            data-next-veld="betaalpagina"
            data-next={`/o/${org.id}/abonnement`}
          >
            <FormError />
            <input type="hidden" name="pakket" value={w.naar.plan.id} />
            <input type="hidden" name="interval" value={w.naar.interval} />
            <button class="btn" type="submit">
              {knop}
            </button>
            <a class="btn secondary" href={`/o/${org.id}/abonnement`}>
              Annuleren
            </a>
          </form>
        ) : (
          <p class="melding">Alleen de eigenaar van het account kan het pakket wijzigen.</p>
        )}
      </section>
    </Layout>
  );
}

// Opzeggen ------------------------------------------------------------------------------------

const REDENEN: [string, string][] = [
  ['te_duur', 'Het is te duur'],
  ['niet_gebruikt', 'We gebruiken het te weinig'],
  ['mist_functie', 'Er mist iets wat we nodig hebben'],
  ['ander_product', 'We stappen over naar iets anders'],
  ['tijdelijk', 'Tijdelijk niet nodig'],
  ['anders', 'Anders'],
];

export function OpzeggenPage(props: Ctx & { b: BillingOverview; catalog: Catalog }) {
  const { b, org } = props;
  const sub = b.abonnement;
  const proef = b.toegang === 'proef';
  const kleiner = props.catalog.plans.filter((x) => sub && x.id !== sub.plan && x.maandprijsCenten.jaar < (sub.pakket?.maandprijsCenten.jaar ?? 0));
  return (
    <Layout title="Abonnement opzeggen" user={props.user} org={org} active="account">
      <a href={`/o/${org.id}/abonnement`}>← Terug naar abonnement</a>
      <section class="card narrow-wide">
        <h1>Abonnement opzeggen</h1>
        {!sub || !b.magBeheren || sub.cancelAtPeriodEnd ? (
          <p class="melding">{!b.magBeheren ? 'Alleen de eigenaar kan het abonnement opzeggen.' : 'Er is geen lopend abonnement om op te zeggen.'}</p>
        ) : (
          <>
            <h3>Wat er gebeurt</h3>
            <ul class="uitleg">
              {proef ? (
                <li>Je proef stopt direct. Je hebt niets betaald en betaalt ook niets.</li>
              ) : (
                <>
                  <li>Je houdt alles tot en met {totEnMet(sub.currentPeriodEnd)}. Daarvoor heb je al betaald; er komt geen nieuwe betaling of incasso meer.</li>
                  <li>Daarna stoppen de wekelijkse controles en meldingen over nieuwe lekken.</li>
                  <li>Tot die datum kun je de opzegging met één klik intrekken.</li>
                </>
              )}
              <li>Je facturen blijven beschikbaar onder Facturen.</li>
            </ul>
            {kleiner.length && !proef ? (
              <p class="melding">
                Liever goedkoper?{' '}
                {kleiner.map((k) => (
                  <a href={`/o/${org.id}/abonnement/wijzigen?pakket=${k.id}&interval=${sub.interval}`}>
                    Stap over naar {k.naam} ({euroKort(k.maandprijsCenten[sub.interval])} p/m)
                  </a>
                ))}
              </p>
            ) : null}
            <form
              class="stack"
              data-api={`/api/v1/organisaties/${org.id}/abonnement/opzeggen`}
              data-next={`/o/${org.id}/abonnement`}
              data-bevestig={proef ? 'Je proef stopt direct. Doorgaan?' : 'Weet je het zeker?'}
            >
              <FormError />
              <fieldset class="redenen">
                <legend>Waarom stop je? Dit helpt ons Qbicle beter te maken.</legend>
                {REDENEN.map(([v, l]) => (
                  <label class="radio">
                    <input type="radio" name="reden" value={v} /> {l}
                  </label>
                ))}
              </fieldset>
              <label>
                Toelichting <span class="hint">Optioneel</span>
                <textarea name="toelichting" maxlength={1000}></textarea>
              </label>
              <div class="row">
                <button class="btn danger" type="submit">
                  {proef ? 'Proef stoppen' : `Opzeggen per ${totEnMet(sub.currentPeriodEnd)}`}
                </button>
                <a class="btn secondary" href={`/o/${org.id}/abonnement`}>
                  Toch niet
                </a>
              </div>
            </form>
          </>
        )}
      </section>
    </Layout>
  );
}
