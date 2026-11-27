/** @jsxImportSource hono/jsx */
import {
  CONTACT_KINDS,
  CONTACT_LABELS,
  type Access,
  type BillingDetails,
  type Contact,
  type Invitation,
  type Member,
  type Role,
} from '@qbicle/platform';
import { datum, FormError, Layout, Status, type NavOrg, type PageUser } from '../layout.tsx';
import { AccountNav } from './abonnement-beheer.tsx';

type Ctx = { user: PageUser & { id: string }; org: NavOrg };

export const ROLE_UITLEG: Record<Role, { naam: string; uitleg: string }> = {
  eigenaar: { naam: 'Eigenaar', uitleg: 'Mag alles, ook betalen, het pakket wijzigen en IT-partners toegang geven.' },
  beheerder: { naam: 'Beheerder', uitleg: 'Voegt domeinen toe, start scans en nodigt collega’s uit. Ziet facturen, maar betaalt niet.' },
  lezer: { naam: 'Lezer', uitleg: 'Kan alles bekijken, maar niets wijzigen. Handig voor directie of een adviseur.' },
};

const LANDEN: [string, string][] = [
  ['NL', 'Nederland'],
  ['BE', 'België'],
  ['DE', 'Duitsland'],
  ['LU', 'Luxemburg'],
  ['FR', 'Frankrijk'],
];

export interface AccountData {
  access: Access;
  details: (BillingDetails & { organisatie: string }) | null;
  contacts: Contact[];
  members: Member[];
  invitations: Invitation[] | null;
  /** Gebruikers volgens het pakket, of null zonder abonnement. */
  maxGebruikers: number | null;
  pakketNaam: string | null;
}

/** Wat ontbreekt er nog voor een correcte factuur? */
export function ontbrekend(d: BillingDetails | null): string[] {
  if (!d) return [];
  const m: string[] = [];
  if (!d.naam) m.push('naam op de factuur');
  if (!d.adres || !d.postcode || !d.plaats) m.push('factuuradres');
  if (!d.email) m.push('e-mailadres voor facturen');
  if (!d.kvk && d.land === 'NL') m.push('KvK-nummer');
  return m;
}

function Rij(props: { label: string; value: string | null | undefined }) {
  return (
    <>
      <dt>{props.label}</dt>
      <dd>{props.value ? props.value : <span class="leeg">Nog niet ingevuld</span>}</dd>
    </>
  );
}

function Bedrijfsgegevens(props: Ctx & { a: AccountData; magNaam: boolean; magFactuur: boolean }) {
  const { org, a } = props;
  const d = a.details;
  const mist = ontbrekend(d);
  return (
    <section class="card" id="bedrijf">
      <div class="row between">
        <h2>Bedrijfsgegevens</h2>
        {d ? mist.length ? <Status kind="warn">Nog niet compleet</Status> : <Status kind="ok">Compleet</Status> : null}
      </div>
      {mist.length ? (
        <p class="melding warn">
          Vul nog in: {mist.join(', ')}. Dan klopt je factuur meteen en kan je boekhouding hem verwerken.
        </p>
      ) : null}

      {props.magNaam ? (
        <form class="stack" data-api={`/api/v1/organisaties/${org.id}`} data-method="PATCH">
          <FormError />
          <label>
            Naam van je organisatie in Qbicle
            <span class="hint">Zo heet je account in het menu en in mails.</span>
            <span class="row nowrap">
              <input type="text" name="name" required maxlength={120} value={org.name} />
              <button class="btn secondary" type="submit">
                Opslaan
              </button>
            </span>
          </label>
        </form>
      ) : (
        <dl class="dl">
          <Rij label="Naam in Qbicle" value={org.name} />
        </dl>
      )}

      {d && props.magFactuur ? (
        <form class="stack" data-api={`/api/v1/organisaties/${org.id}/factuurgegevens`} data-method="PUT">
          <FormError />
          <h3>Gegevens op je factuur</h3>
          <div class="grid">
            <label>
              Naam op de factuur
              <span class="hint">De officiële naam, zoals bij de KvK.</span>
              <input type="text" name="naam" maxlength={200} value={d.naam ?? ''} placeholder={d.organisatie} />
            </label>
            <label>
              E-mailadres voor facturen
              <span class="hint">Bijvoorbeeld je administratie of boekhoudpakket.</span>
              <input type="email" name="email" maxlength={254} value={d.email ?? ''} placeholder="facturen@jouwbedrijf.nl" />
            </label>
            <label>
              KvK-nummer
              <span class="hint">8 cijfers.</span>
              <input type="text" name="kvk" inputmode="numeric" maxlength={20} value={d.kvk ?? ''} />
            </label>
            <label>
              Btw-nummer
              <span class="hint">Voorbeeld: NL123456789B01. Nodig voor btw verlegd buiten Nederland.</span>
              <input type="text" name="btwNummer" maxlength={30} value={d.btwNummer ?? ''} />
            </label>
            <label class="span-2">
              Adres
              <input type="text" name="adres" maxlength={400} value={d.adres ?? ''} placeholder="Straat en huisnummer" />
            </label>
            <label>
              Postcode
              <input type="text" name="postcode" maxlength={16} value={d.postcode ?? ''} />
            </label>
            <label>
              Plaats
              <input type="text" name="plaats" maxlength={100} value={d.plaats ?? ''} />
            </label>
            <label>
              Land
              <select name="land">
                {LANDEN.map(([code, naam]) => (
                  <option value={code} selected={d.land === code}>
                    {naam}
                  </option>
                ))}
                {LANDEN.some(([c]) => c === d.land) ? null : (
                  <option value={d.land} selected>
                    {d.land}
                  </option>
                )}
              </select>
            </label>
            <label>
              Jouw referentie op de factuur
              <span class="hint">Optioneel: kenmerk, kostenplaats of inkoopordernummer.</span>
              <input type="text" name="referentie" maxlength={100} value={d.referentie ?? ''} />
            </label>
          </div>
          <div class="row">
            <button class="btn" type="submit">
              Gegevens opslaan
            </button>
            <span class="small">Wijzigingen gelden voor nieuwe facturen. Eerdere facturen blijven zoals ze zijn.</span>
          </div>
        </form>
      ) : d ? (
        <>
          <h3>Gegevens op je factuur</h3>
          <dl class="dl">
            <Rij label="Naam op de factuur" value={d.naam ?? d.organisatie} />
            <Rij label="E-mail voor facturen" value={d.email} />
            <Rij label="KvK-nummer" value={d.kvk} />
            <Rij label="Btw-nummer" value={d.btwNummer} />
            <Rij label="Adres" value={[d.adres, [d.postcode, d.plaats].filter(Boolean).join(' '), d.land !== 'NL' ? d.land : ''].filter(Boolean).join(', ') || null} />
            <Rij label="Referentie" value={d.referentie} />
          </dl>
          <p class="small">Alleen een eigenaar kan de factuurgegevens wijzigen.</p>
        </>
      ) : null}
    </section>
  );
}

function Contactpersonen(props: Ctx & { a: AccountData; magWijzigen: boolean }) {
  const { org, a } = props;
  const byKind = new Map(a.contacts.map((c) => [c.kind, c]));
  return (
    <section class="card" id="contactpersonen">
      <h2>Contactpersonen</h2>
      <p class="small">
        Wie we bereiken als er iets is. Contactpersonen hoeven geen gebruiker te zijn en krijgen geen toegang tot Qbicle.
      </p>
      <div class="grid twee">
        {CONTACT_KINDS.map((kind) => {
          const c = byKind.get(kind);
          const l = CONTACT_LABELS[kind];
          return (
            <div class={`contact${kind === 'security' ? ' urgent' : ''}`}>
              <h3>{l.titel}</h3>
              <p class="small">{l.uitleg}</p>
              {props.magWijzigen ? (
                <>
                  <form class="stack" data-api={`/api/v1/organisaties/${org.id}/contactpersonen/${kind}`} data-method="PUT">
                    <FormError />
                    <label>
                      Naam
                      <input type="text" name="naam" maxlength={120} value={c?.name ?? ''} required />
                    </label>
                    <label>
                      E-mail
                      <input type="email" name="email" maxlength={254} value={c?.email ?? ''} />
                    </label>
                    <label>
                      Telefoon
                      <input type="tel" name="telefoon" maxlength={32} value={c?.phone ?? ''} />
                    </label>
                    <button class="btn secondary" type="submit">
                      {c ? 'Opslaan' : 'Toevoegen'}
                    </button>
                  </form>
                  {c ? (
                    <form
                      data-api={`/api/v1/organisaties/${org.id}/contactpersonen/${kind}`}
                      data-method="DELETE"
                      data-bevestig={`${c.name} weghalen als ${l.titel.toLowerCase()}?`}
                    >
                      <FormError />
                      <button class="linkbtn" type="submit">
                        Weghalen
                      </button>
                    </form>
                  ) : null}
                </>
              ) : c ? (
                <dl class="dl">
                  <Rij label="Naam" value={c.name} />
                  <Rij label="E-mail" value={c.email} />
                  <Rij label="Telefoon" value={c.phone} />
                </dl>
              ) : (
                <p class="leeg">Nog niet ingevuld</p>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function Gebruikers(props: Ctx & { a: AccountData }) {
  const { org, a, user } = props;
  const myRole = a.access.role;
  const viaPartner = a.access.via === 'partner';
  const magBeheren = myRole !== 'lezer';
  const owners = a.members.filter((m) => m.role === 'eigenaar').length;
  const used = a.members.length + (a.invitations?.length ?? 0);
  const vol = a.maxGebruikers !== null && used >= a.maxGebruikers;
  const toewijsbaar = (['lezer', 'beheerder', 'eigenaar'] as Role[]).filter((r) => myRole === 'eigenaar' || r !== 'eigenaar');
  return (
    <section class="card" id="gebruikers">
      <div class="row between">
        <h2>Gebruikers en rollen</h2>
        {a.maxGebruikers !== null ? (
          <span class="small">
            {used} van {a.maxGebruikers} gebruikers in {a.pakketNaam}
          </span>
        ) : null}
      </div>
      <ul class="rollen">
        {(['eigenaar', 'beheerder', 'lezer'] as Role[]).map((r) => (
          <li>
            <b>{ROLE_UITLEG[r].naam}</b> {ROLE_UITLEG[r].uitleg}
          </li>
        ))}
      </ul>
      {viaPartner ? <p class="melding">Je kijkt mee als IT-partner. Gebruikers van de klant beheert de klant zelf.</p> : null}

      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>Gebruiker</th>
              <th>Rol</th>
              <th>Sinds</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {a.members.map((m) => {
              const self = m.userId === user.id;
              const lastOwner = m.role === 'eigenaar' && owners <= 1;
              const magDeze = magBeheren && !viaPartner && !self && (m.role !== 'eigenaar' || myRole === 'eigenaar');
              return (
                <tr>
                  <td>
                    {m.displayName ? (
                      <>
                        {m.displayName}
                        <br />
                        <span class="small">{m.email}</span>
                      </>
                    ) : (
                      m.email
                    )}
                    {self ? <span class="small"> (jij)</span> : null}
                  </td>
                  <td>
                    {magDeze ? (
                      <form class="row nowrap" data-api={`/api/v1/organisaties/${org.id}/leden/${m.userId}`} data-method="PATCH">
                        <FormError />
                        <select name="role" aria-label={`Rol van ${m.email}`}>
                          {toewijsbaar.map((r) => (
                            <option value={r} selected={m.role === r}>
                              {ROLE_UITLEG[r].naam}
                            </option>
                          ))}
                        </select>
                        <button class="btn secondary small-btn" type="submit">
                          Wijzig
                        </button>
                      </form>
                    ) : (
                      ROLE_UITLEG[m.role].naam
                    )}
                  </td>
                  <td>{datum(m.since)}</td>
                  <td class="num">
                    {magDeze && !lastOwner ? (
                      <form
                        data-api={`/api/v1/organisaties/${org.id}/leden/${m.userId}`}
                        data-method="DELETE"
                        data-bevestig={`${m.email} verwijderen? Deze persoon kan daarna niet meer inloggen bij ${org.name}.`}
                      >
                        <FormError />
                        <button class="linkbtn" type="submit">
                          Verwijderen
                        </button>
                      </form>
                    ) : self && !lastOwner && !viaPartner ? (
                      <form
                        data-api={`/api/v1/organisaties/${org.id}/leden/${m.userId}`}
                        data-method="DELETE"
                        data-next="/overzicht"
                        data-bevestig={`Weet je zeker dat je ${org.name} wilt verlaten?`}
                      >
                        <FormError />
                        <button class="linkbtn" type="submit">
                          Verlaten
                        </button>
                      </form>
                    ) : self && lastOwner ? (
                      <span class="small">Enige eigenaar</span>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {a.invitations && a.invitations.length ? (
        <>
          <h3>Uitnodigingen die nog openstaan</h3>
          <div class="table-wrap">
            <table class="table">
              <tbody>
                {a.invitations.map((i) => (
                  <tr>
                    <td>{i.email}</td>
                    <td>{ROLE_UITLEG[i.role].naam}</td>
                    <td class="small">Geldig tot {datum(i.expiresAt)}</td>
                    <td class="num">
                      <form data-api={`/api/v1/organisaties/${org.id}/uitnodigingen/${i.id}`} data-method="DELETE">
                        <FormError />
                        <button class="linkbtn" type="submit">
                          Intrekken
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {a.invitations ? (
        vol ? (
          <p class="melding">
            Je pakket zit vol. <a href={`/o/${org.id}/abonnement`}>Kies een groter pakket</a> of verwijder eerst iemand.
          </p>
        ) : (
          <form class="stack invite" data-api={`/api/v1/organisaties/${org.id}/uitnodigingen`}>
            <FormError />
            <h3>Collega uitnodigen</h3>
            <div class="row">
              <label class="grow">
                E-mailadres
                <input type="email" name="email" required maxlength={254} placeholder="naam@jouwbedrijf.nl" />
              </label>
              <label>
                Rol
                <select name="role">
                  {toewijsbaar.map((r) => (
                    <option value={r} selected={r === 'lezer'}>
                      {ROLE_UITLEG[r].naam}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div class="row">
              <button class="btn" type="submit">
                Uitnodiging sturen
              </button>
              <span class="small">De uitnodiging is een week geldig en werkt alleen voor dit e-mailadres.</span>
            </div>
          </form>
        )
      ) : null}
    </section>
  );
}

export function AccountPage(props: Ctx & { a: AccountData }) {
  const { a } = props;
  const magNaam = a.access.role !== 'lezer';
  const magFactuur = a.access.role === 'eigenaar' && a.access.via === 'lid';
  return (
    <Layout title="Account" user={props.user} org={props.org} active="account">
      <div class="intro">
        <h1>Account</h1>
        <p class="lead">Je bedrijfsgegevens, wie we bereiken en wie er toegang heeft. Alles op één plek.</p>
      </div>
      <AccountNav orgId={props.org.id} active="account" />
      <nav class="subnav anker" aria-label="Op deze pagina">
        <a href="#bedrijf">Bedrijfsgegevens</a>
        <a href="#contactpersonen">Contactpersonen</a>
        <a href="#gebruikers">Gebruikers en rollen</a>
      </nav>
      <Bedrijfsgegevens {...props} magNaam={magNaam} magFactuur={magFactuur} />
      <Contactpersonen {...props} magWijzigen={magNaam} />
      <Gebruikers {...props} />
    </Layout>
  );
}

/** Link uit de uitnodigingsmail. */
export function UitnodigingPage(props: { user?: PageUser | undefined }) {
  return (
    <Layout title="Uitnodiging" user={props.user} minimal>
      <div class="card narrow" data-token-post="/api/v1/uitnodigingen/accepteren" data-next="/overzicht" data-bewaar-token="uitnodiging">
        <h1>Uitnodiging accepteren</h1>
        <p data-status role="status">
          Even geduld…
        </p>
        {props.user ? null : (
          <p class="small">
            Je moet eerst inloggen met het e-mailadres waarop je de uitnodiging kreeg. We sturen je zo door.
          </p>
        )}
        <noscript>
          <p class="form-fout">Zet JavaScript aan om deze link te gebruiken.</p>
        </noscript>
      </div>
    </Layout>
  );
}
