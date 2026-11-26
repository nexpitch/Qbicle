/** @jsxImportSource hono/jsx */
import type { AuditPackage, Catalog, Plan } from '@qbicle/platform';
import { euroKort, FormError, Layout, type PageUser } from '../layout.tsx';

type ProductKey = 'mkb' | 'corporate' | 'audit';

function PlanCard(props: { plan: Plan; checked: boolean }) {
  const { plan } = props;
  const jaar = plan.maandprijsCenten.jaar;
  const maand = plan.maandprijsCenten.maand;
  return (
    <label class={`plan ${plan.product}`}>
      <input type="radio" name="pakket" value={plan.id} checked={props.checked} required />
      <span class="accent" aria-hidden="true"></span>
      {plan.aanbevolen ? <span class="badge aanbevolen">Meest gekozen</span> : null}
      <h3>{plan.naam}</h3>
      <p class="small">{plan.kort} · {plan.voorWie}</p>
      <div class="price bij-jaar">
        <b>{euroKort(jaar)}</b>
        <span>per maand, {euroKort(jaar * 12)} per jaar</span>
      </div>
      <div class="price bij-maand">
        <b>{euroKort(maand)}</b>
        <span>per maand, maandelijks opzegbaar</span>
      </div>
      <ul>
        {plan.functies.map((f) => (
          <li>{f}</li>
        ))}
        <li>
          Tot {plan.limieten.domeinen} domeinen en {plan.limieten.gebruikers} gebruikers
        </li>
      </ul>
    </label>
  );
}

function AuditCard(props: { pkg: AuditPackage; checked: boolean }) {
  const { pkg } = props;
  return (
    <label class={`plan audit${pkg.bestelbaar ? '' : ' disabled'}`}>
      {pkg.bestelbaar ? <input type="radio" name="pakket" value={pkg.id} checked={props.checked} required /> : null}
      <span class="accent" aria-hidden="true"></span>
      {pkg.bestelbaar ? null : <span class="badge">Binnenkort online te bestellen</span>}
      <h3>{pkg.naam}</h3>
      <p class="small">{pkg.kort} · {pkg.voorWie}</p>
      <div class="price">
        <b>{pkg.vanafPrijs ? `vanaf ${euroKort(pkg.prijsCenten)}` : euroKort(pkg.prijsCenten)}</b>
        <span>per overname, eenmalig</span>
      </div>
      <ul>
        {pkg.functies.map((f) => (
          <li>{f}</li>
        ))}
      </ul>
    </label>
  );
}

/** Pakket kiezen en registreren. Werkt zonder JavaScript voor het kiezen (CSS :has). */
export function AanmeldenPage(props: { catalog: Catalog; product: ProductKey; plan?: string | undefined; interval: 'maand' | 'jaar'; user?: PageUser | undefined }) {
  const { catalog } = props;
  const mkb = catalog.plans.filter((p) => p.product === 'mkb');
  const corp = catalog.plans.filter((p) => p.product === 'corporate');
  const defaultPlan =
    props.plan ??
    (props.product === 'audit'
      ? catalog.auditPackages.find((a) => a.bestelbaar)?.id
      : (props.product === 'corporate' ? corp : mkb)[0]?.id);
  const korting = (() => {
    const p = mkb[0];
    if (!p) return 0;
    return Math.round((1 - p.maandprijsCenten.jaar / p.maandprijsCenten.maand) * 100);
  })();

  return (
    <Layout title="Kies je pakket" active="aanmelden" user={props.user} minimal={false}>
      <div class="intro">
        <span class="eyebrow">Aanmelden</span>
        <h1>Weet wat er van jouw bedrijf aan het internet hangt</h1>
        <p class="lead">
          Qbicle brengt al je internetgerichte systemen in kaart: domeinen, websites, e-mail, servers, clouddiensten en netwerkapparaten. Je ziet hoe urgent het is
          om iets op te pakken, in gewone taal.
        </p>
      </div>

      <form
        class="stack"
        data-api="/api/v1/registratie"
        data-next="/aanmelden/check-je-mail"
        method="post"
        action="/aanmelden"
      >
        <div class="row between">
          <div class="tabs" role="radiogroup" aria-label="Product">
            <label class="tab-mkb">
              <input type="radio" name="product" id="prod-mkb" value="mkb" checked={props.product === 'mkb'} />
              MKB
            </label>
            <label class="tab-corp">
              <input type="radio" name="product" id="prod-corporate" value="corporate" checked={props.product === 'corporate'} />
              Corporate
            </label>
            <label class="tab-audit">
              <input type="radio" name="product" id="prod-audit" value="audit" checked={props.product === 'audit'} />
              Qbicle Audit
            </label>
          </div>
          <div class="seg alleen-abonnement" role="radiogroup" aria-label="Betalen per">
            <label>
              <input type="radio" name="interval" id="iv-jaar" value="jaar" checked={props.interval === 'jaar'} />
              Per jaar{korting > 0 ? <span class="korting">−{korting}%</span> : null}
            </label>
            <label>
              <input type="radio" name="interval" id="iv-maand" value="maand" checked={props.interval === 'maand'} />
              Per maand
            </label>
          </div>
        </div>

        <div class="product-panel mkb plans">
          {mkb.map((p) => (
            <PlanCard plan={p} checked={p.id === defaultPlan} />
          ))}
          <div class="card">
            <h3>Groter, of meerdere vestigingen?</h3>
            <p class="small">Met Corporate zie je ook routers en netwerkapparaten, koppel je Microsoft 365 en krijg je een compliance-overzicht.</p>
          </div>
        </div>
        <div class="product-panel corporate plans">
          {corp.map((p) => (
            <PlanCard plan={p} checked={p.id === defaultPlan} />
          ))}
          <div class="card">
            <h3>Een groep of holding?</h3>
            <p class="small">Voor meer dan 10 domeinen of meerdere werkmaatschappijen maken we graag een voorstel op maat.</p>
          </div>
        </div>
        <div class="product-panel audit plans">
          {catalog.auditPackages.map((a) => (
            <AuditCard pkg={a} checked={a.id === defaultPlan} />
          ))}
        </div>

        <div class="card narrow">
          <h2 class="alleen-abonnement">Start {catalog.proefDagen} dagen gratis</h2>
          <h2 class="alleen-audit">Account aanmaken</h2>
          <p class="small alleen-abonnement">Zonder betaalgegevens. Na de proef kies je zelf of je doorgaat.</p>
          <p class="small alleen-audit">Na het aanmaken vul je de gegevens van de overname in en betaal je de opdracht.</p>
          <FormError />
          <label>
            Zakelijk e-mailadres
            <input type="email" name="email" autocomplete="email" required maxlength={254} />
          </label>
          <label>
            Naam van je bedrijf
            <input type="text" name="organisatie" autocomplete="organization" required maxlength={120} />
          </label>
          <button class="btn wide" type="submit">
            Stuur mij de bevestigingslink
          </button>
          <p class="small">
            Prijzen exclusief {catalog.btwPercentage}% btw. Heb je al een account? <a href="/inloggen">Log in</a>.
          </p>
        </div>
      </form>
    </Layout>
  );
}

export function CheckMailPage(props: { title?: string }) {
  return (
    <Layout title={props.title ?? 'Check je mail'} minimal>
      <div class="card narrow">
        <span class="eyebrow">Bijna klaar</span>
        <h1>Check je mail</h1>
        <p>
          We hebben je een link gestuurd. Klik erop om je account te bevestigen en in te loggen. De link werkt 15 minuten en één keer.
        </p>
        <p class="small">
          Niets ontvangen? Kijk in je map met ongewenste mail, of <a href="/inloggen">vraag een nieuwe link aan</a>.
        </p>
      </div>
    </Layout>
  );
}

export function InloggenPage() {
  return (
    <Layout title="Inloggen" active="inloggen">
      <form class="card narrow" data-api="/api/v1/auth/inloglink" data-next="/inloggen/check-je-mail" method="post" action="/inloggen">
        <h1>Inloggen</h1>
        <p class="small">Qbicle werkt zonder wachtwoord. Je krijgt een link per e-mail.</p>
        <FormError />
        <label>
          E-mailadres
          <input type="email" name="email" autocomplete="email" required maxlength={254} />
        </label>
        <button class="btn wide" type="submit">
          Stuur mij een inloglink
        </button>
        <p class="small">
          Nog geen account? <a href="/aanmelden">Kies een pakket</a>.
        </p>
      </form>
    </Layout>
  );
}

export function TokenPage(props: { title: string; api: string; next?: string }) {
  return (
    <Layout title={props.title} minimal>
      <div class="card narrow" data-token-post={props.api} data-next={props.next}>
        <h1>{props.title}</h1>
        <p data-status role="status">
          Even geduld…
        </p>
        <noscript>
          <p class="form-fout">Zet JavaScript aan om deze link te gebruiken.</p>
        </noscript>
      </div>
    </Layout>
  );
}
