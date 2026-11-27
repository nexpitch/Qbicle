/** @jsxImportSource hono/jsx */
import type { Systeem, SysteemBeoordeling, SysteemRegister } from '@qbicle/platform';
import { FormError, Layout, Status, type NavOrg, type PageUser } from '../layout.tsx';

type Ctx = { user: PageUser; org: NavOrg };

const SOORT: Record<Systeem['soort'], string> = {
  erp: 'ERP (bedrijfsvoering)',
  crm: 'CRM (klanten en verkoop)',
  boekhouding: 'Boekhouding en facturatie',
  webshop: 'Webshop',
  kassa: 'Kassa',
  planning: 'Planning en roosters',
  klantportaal: 'Klantportaal of app',
  'hr-salaris': 'HR en salaris',
  maatwerk: 'Maatwerksoftware',
  overig: 'Overig',
};
const HOSTING: Record<Systeem['hosting'], string> = {
  saas: 'Online dienst van de leverancier (SaaS)',
  cloud: 'In onze eigen cloudomgeving',
  'eigen-server': 'Op een eigen server',
  onbekend: 'Weet ik niet',
};
const IMPACT: Record<Systeem['impactUitval'], string> = {
  laag: 'Weinig: we kunnen een paar dagen zonder',
  merkbaar: 'Merkbaar: klanten of medewerkers hebben er last van',
  stil: 'Groot: het bedrijf ligt (deels) stil',
};
const GEGEVENS: Record<Systeem['gegevens'][number], string> = {
  medewerkers: 'Gegevens van medewerkers',
  klanten: 'Gegevens van klanten',
  betaalgegevens: 'Betaalgegevens (bankrekening, creditcard)',
  bijzonder: 'Bijzondere gegevens (gezondheid, BSN, strafrecht)',
};
const INLOGGEN: Record<Systeem['inloggen'], string> = {
  sso: 'Via Microsoft of Google (één inlog)',
  mfa: 'Eigen wachtwoord plus tweestapsverificatie',
  wachtwoord: 'Alleen een wachtwoord',
  onbekend: 'Weet ik niet',
};
const UPDATES: Record<Systeem['updates'], string> = {
  leverancier: 'De leverancier (automatisch)',
  wij: 'Wij of onze IT-partner',
  niemand: 'Niemand vast',
  onbekend: 'Weet ik niet',
};
const JANEE: Record<Systeem['verwerkersovereenkomst'], string> = { ja: 'Ja', nee: 'Nee', onbekend: 'Weet ik niet' };
const LOCATIE: Record<Systeem['datalocatie'], string> = { eu: 'In de EU', 'buiten-eu': 'Buiten de EU', onbekend: 'Weet ik niet' };
const TERUGVAL: Record<Systeem['terugval'], string> = {
  getest: 'Ja, en we hebben het getest',
  'niet-getest': 'Ja, maar nooit getest',
  geen: 'Nee',
  onbekend: 'Weet ik niet',
};

/** Veelgebruikte pakketten in Nederland, als suggestie bij het typen. */
const SUGGESTIES = [
  'Exact Online', 'AFAS Profit', 'Twinfield', 'Moneybird', 'e-Boekhouden.nl', 'SnelStart', 'Visma', 'Nmbrs', 'Loket.nl',
  'Shopify', 'WooCommerce', 'Lightspeed', 'Magento', 'Salesforce', 'HubSpot', 'Teamleader', 'Microsoft Dynamics 365',
  'SAP Business One', 'Odoo', 'Simplicate', 'Planbition', 'Mollie',
];

function ImpactBadge(props: { b: SysteemBeoordeling }) {
  if (props.b.impact === 'hoog') return <Status kind="crit">Hoge impact</Status>;
  if (props.b.impact === 'middel') return <Status kind="warn">Middel</Status>;
  return <Status kind="ok">Laag</Status>;
}

function Acties(props: { b: SysteemBeoordeling; max?: number }) {
  const lijst = props.max ? props.b.acties.slice(0, props.max) : props.b.acties;
  if (!props.b.acties.length) return <p class="small">Geen acties: dit systeem lijkt goed geregeld.</p>;
  return (
    <ul class="bevindingen compact">
      {lijst.map((a) => (
        <li>
          <Status kind={a.urgentie}>{a.urgentie === 'crit' ? 'Nu oppakken' : 'Binnenkort'}</Status>
          <span>{a.tekst}</span>
        </li>
      ))}
      {props.max && props.b.acties.length > props.max ? <li class="small">en nog {props.b.acties.length - props.max}</li> : null}
    </ul>
  );
}

export function SystemenPage(props: Ctx & { reg: SysteemRegister }) {
  const { org, reg } = props;
  const vol = reg.limiet !== null && reg.systemen.length >= reg.limiet;
  const hoog = reg.systemen.filter((s) => s.beoordeling.impact === 'hoog').length;
  const acties = reg.systemen.reduce((n, s) => n + s.beoordeling.acties.length, 0);
  return (
    <Layout title="Systemen" user={props.user} org={org} active="systemen">
      <div class="intro">
        <span class="eyebrow">Bedrijfskritische systemen</span>
        <h1>Systemen waar je bedrijf op draait</h1>
        <p class="lead">
          Boekhouding, webshop, planning, CRM of maatwerk: leg vast wat er gebeurt als een systeem uitvalt of lekt. Dan weegt Qbicle bevindingen
          zwaarder waar het ertoe doet, en zie je wat je zelf nog kunt regelen.
        </p>
      </div>

      <div class="row between">
        <p class="small">
          {reg.systemen.length} {reg.systemen.length === 1 ? 'systeem' : 'systemen'}
          {reg.limiet !== null ? ` van ${reg.limiet} in Qbicle MKB` : ''}
          {reg.systemen.length ? ` · ${hoog} met hoge impact · ${acties} ${acties === 1 ? 'actie' : 'acties'}` : ''}
        </p>
        {reg.magWijzigen ? (
          vol ? (
            <a class="btn secondary" href={`/o/${org.id}/abonnement`}>
              Meer systemen met Business
            </a>
          ) : (
            <a class="btn" href={`/o/${org.id}/systemen/nieuw`}>
              Systeem toevoegen
            </a>
          )
        ) : null}
      </div>

      {reg.systemen.length === 0 ? (
        <section class="card leeg">
          <h2>Nog geen systemen</h2>
          <p class="small">
            Begin met het systeem waar je het minst zonder kunt. Vijf minuten per systeem; je IT-partner kan helpen met de vragen die je niet weet.
          </p>
          {reg.magWijzigen ? (
            <a class="btn" href={`/o/${org.id}/systemen/nieuw`}>
              Eerste systeem toevoegen
            </a>
          ) : null}
        </section>
      ) : (
        <div class="koppel-grid">
          {reg.systemen.map((s) => (
            <a class="card systeem-kaart" href={`/o/${org.id}/systemen/${s.id}`}>
              <div class="row between">
                <h3>{s.naam}</h3>
                <ImpactBadge b={s.beoordeling} />
              </div>
              <p class="meta">
                {SOORT[s.soort]}
                {s.leverancier ? ` · ${s.leverancier}` : ''}
                {s.eigenaar ? ` · eigenaar ${s.eigenaar}` : ''}
              </p>
              <p class="small">{s.beoordeling.waarom}</p>
              <Acties b={s.beoordeling} max={2} />
            </a>
          ))}
        </div>
      )}

      <p class="small">Qbicle beoordeelt op basis van wat je invult. Het is een waarneming, geen juridisch oordeel.</p>
    </Layout>
  );
}

function Keuze<K extends string>(props: { name: string; label: string; opties: Record<K, string>; waarde?: K | undefined; hint?: string }) {
  return (
    <label>
      {props.label}
      {props.hint ? <span class="hint">{props.hint}</span> : null}
      <select name={props.name}>
        {(Object.keys(props.opties) as K[]).map((k) => (
          <option value={k} selected={props.waarde === k}>
            {props.opties[k]}
          </option>
        ))}
      </select>
    </label>
  );
}

export function SysteemFormPage(props: Ctx & { s?: (Systeem & { beoordeling: SysteemBeoordeling }) | undefined; magWijzigen: boolean }) {
  const { org, s } = props;
  const api = s ? `/api/v1/organisaties/${org.id}/systemen/${s.id}` : `/api/v1/organisaties/${org.id}/systemen`;
  const ro = !props.magWijzigen;
  return (
    <Layout title={s ? s.naam : 'Systeem toevoegen'} user={props.user} org={org} active="systemen">
      <a href={`/o/${org.id}/systemen`}>← Alle systemen</a>
      <div class="intro">
        <div class="row">
          <h1>{s ? s.naam : 'Systeem toevoegen'}</h1>
          {s ? <ImpactBadge b={s.beoordeling} /> : null}
        </div>
        {s ? <p class="lead">{s.beoordeling.waarom}</p> : <p class="lead">Vul in wat je weet. “Weet ik niet” is ook een antwoord: dan zetten we het op je actielijst.</p>}
      </div>

      <div class="koppel-detail">
        <form class="stack" data-api={api} data-method={s ? 'PUT' : 'POST'} data-next={`/o/${org.id}/systemen`}>
          <FormError />
          <fieldset class="card" disabled={ro}>
            <h2>Wat is het?</h2>
            <label>
              Naam
              <input type="text" name="naam" required maxlength={120} list="suggesties" value={s?.naam ?? ''} placeholder="Bijvoorbeeld Exact Online" />
            </label>
            <datalist id="suggesties">
              {SUGGESTIES.map((n) => (
                <option value={n} />
              ))}
            </datalist>
            <div class="grid">
              <Keuze name="soort" label="Soort" opties={SOORT} waarde={s?.soort} />
              <label>
                Leverancier
                <input type="text" name="leverancier" maxlength={120} value={s?.leverancier ?? ''} />
              </label>
            </div>
            <div class="grid">
              <Keuze name="hosting" label="Waar draait het?" opties={HOSTING} waarde={s?.hosting ?? 'onbekend'} />
              <label>
                Webadres <span class="hint">Waar medewerkers of klanten inloggen. Dan kijkt Qbicle er ook van buiten naar.</span>
                <input type="text" name="adres" maxlength={300} value={s?.adres ?? ''} placeholder="bijv. shop.jouwbedrijf.nl" />
              </label>
            </div>
            <label>
              Eigenaar binnen het bedrijf <span class="hint">Wie beslist erover en is aanspreekpunt.</span>
              <input type="text" name="eigenaar" maxlength={120} value={s?.eigenaar ?? ''} placeholder="Naam of functie" />
            </label>
          </fieldset>

          <fieldset class="card" disabled={ro}>
            <h2>Wat als het misgaat?</h2>
            <Keuze name="impactUitval" label="Wat gebeurt er als het een dag niet werkt?" opties={IMPACT} waarde={s?.impactUitval ?? 'merkbaar'} />
            <div class="stack-tight">
              <span class="veldlabel">Welke gegevens staan erin?</span>
              {(Object.keys(GEGEVENS) as (keyof typeof GEGEVENS)[]).map((g) => (
                <label class="vink">
                  <input type="checkbox" name="gegevens" value={g} data-meerdere checked={s?.gegevens.includes(g)} />
                  {GEGEVENS[g]}
                </label>
              ))}
            </div>
            <Keuze name="terugval" label="Is er een back-up of export waarmee je verder kunt?" opties={TERUGVAL} waarde={s?.terugval ?? 'onbekend'} />
          </fieldset>

          <fieldset class="card" disabled={ro}>
            <h2>Beveiliging en leverancier</h2>
            <div class="grid">
              <Keuze name="inloggen" label="Hoe loggen mensen in?" opties={INLOGGEN} waarde={s?.inloggen ?? 'onbekend'} />
              <Keuze name="updates" label="Wie installeert updates?" opties={UPDATES} waarde={s?.updates ?? 'onbekend'} />
            </div>
            <div class="grid">
              <Keuze name="verwerkersovereenkomst" label="Verwerkersovereenkomst met de leverancier?" opties={JANEE} waarde={s?.verwerkersovereenkomst ?? 'onbekend'} />
              <Keuze name="datalocatie" label="Waar staan de gegevens?" opties={LOCATIE} waarde={s?.datalocatie ?? 'onbekend'} />
            </div>
            <label>
              Notities
              <textarea name="notities" maxlength={1000}>
                {s?.notities ?? ''}
              </textarea>
            </label>
          </fieldset>

          {ro ? (
            <p class="small">Alleen een eigenaar of beheerder van je account kan systemen wijzigen.</p>
          ) : (
            <div class="row">
              <button class="btn" type="submit">
                {s ? 'Opslaan' : 'Toevoegen'}
              </button>
              <a href={`/o/${org.id}/systemen`}>Annuleren</a>
            </div>
          )}
        </form>

        <div class="stack">
          {s ? (
            <section class="card">
              <h2>Wat je kunt doen</h2>
              <Acties b={s.beoordeling} />
            </section>
          ) : null}
          <section class="card">
            <h2>Waarom dit register?</h2>
            <ul class="plain">
              <li>Een lek in je webshop met betaalgegevens weegt zwaarder dan een lek in een intern rooster. Qbicle rekent daarmee.</li>
              <li>Je ziet welke leveranciers je gegevens hebben en of daar afspraken over zijn.</li>
              <li>Je IT-partner of verzekeraar ziet in één keer waar het bedrijf op draait.</li>
            </ul>
          </section>
          {s && !ro ? (
            <form class="card" data-api={`/api/v1/organisaties/${org.id}/systemen/${s.id}`} data-method="DELETE" data-next={`/o/${org.id}/systemen`} data-bevestig={`${s.naam} uit het register verwijderen?`}>
              <FormError />
              <button class="btn danger" type="submit">
                Verwijderen uit het register
              </button>
            </form>
          ) : null}
        </div>
      </div>
    </Layout>
  );
}
