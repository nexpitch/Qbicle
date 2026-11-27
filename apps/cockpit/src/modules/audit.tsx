/** @jsxImportSource hono/jsx */
import { listCockpitAudit } from '../core/overview.ts';
import { datumTijd, Empty } from '../layout.tsx';
import type { CockpitModule } from '../module.ts';

const LABELS: Record<string, string> = {
  'cockpit.inloglink_aangevraagd': 'Inloglink cockpit aangevraagd',
  'cockpit.inloglink_gebruikt': 'Inloglink cockpit gebruikt',
  'cockpit.ingelogd': 'Ingelogd in de cockpit',
  'cockpit.uitgelogd': 'Uitgelogd uit de cockpit',
  'cockpit.mfa_ingesteld': 'Authenticator ingesteld',
  'cockpit.mfa_mislukt': 'Onjuiste MFA-code',
  'cockpit.mfa_gereset': 'Authenticator gereset',
  'cockpit.medewerker_toegevoegd': 'Medewerker toegevoegd',
  'cockpit.medewerker_rol_gewijzigd': 'Rol van medewerker gewijzigd',
  'cockpit.medewerker_ingetrokken': 'Toegang medewerker ingetrokken',
  'cockpit.notitie_toegevoegd': 'Notitie toegevoegd',
  'cockpit.betaalwijze_gewijzigd': 'Betaalwijze gewijzigd',
  'cockpit.incasso_klaargezet': 'Incassobatch klaargezet',
  'cockpit.incasso_regel_uitgesloten': 'Incassoregel uitgesloten',
  'cockpit.incasso_regel_teruggezet': 'Incassoregel teruggezet',
  'cockpit.incasso_regel_aangepast': 'Incassobedrag aangepast',
  'cockpit.incasso_gevalideerd': 'Incassobatch gevalideerd',
  'cockpit.incasso_terug_naar_concept': 'Incassobatch terug naar concept',
  'cockpit.incasso_ingediend': 'Incassobatch ingediend',
  'cockpit.incasso_geannuleerd': 'Incassobatch geannuleerd',
  'cockpit.incasso_mislukt': 'Incasso mislukt',
  'cockpit.gebruiker_geblokkeerd': 'Gebruiker geblokkeerd',
  'cockpit.gebruiker_gedeblokkeerd': 'Gebruiker gedeblokkeerd',
  'cockpit.gebruiker_uitgelogd': 'Gebruiker overal uitgelogd',
  'auth.inloglink_aangevraagd': 'Inloglink aangevraagd',
  'auth.ingelogd': 'Ingelogd',
  'auth.uitgelogd': 'Uitgelogd',
  'auth.account_aangemaakt': 'Account aangemaakt',
  'org.aangemaakt': 'Organisatie aangemaakt',
  'org.gewijzigd': 'Organisatie gewijzigd',
  'lid.rol_gewijzigd': 'Rol van gebruiker gewijzigd',
  'lid.verwijderd': 'Gebruiker verwijderd',
  'uitnodiging.verstuurd': 'Uitnodiging verstuurd',
  'uitnodiging.geaccepteerd': 'Uitnodiging geaccepteerd',
  'domein.toegevoegd': 'Domein toegevoegd',
  'domein.geverifieerd': 'Domein geverifieerd',
  'scan.aangevraagd': 'Scan aangevraagd',
  'registratie.afgerond': 'Registratie afgerond',
  'abonnement.gestart': 'Abonnement gestart',
  'abonnement.gewijzigd': 'Abonnement gewijzigd',
  'abonnement.opgezegd': 'Abonnement opgezegd',
  'abonnement.geactiveerd': 'Abonnement geactiveerd',
  'betaling.aangemaakt': 'Betaling aangemaakt',
  'betaling.status': 'Betaalstatus gewijzigd',
  'factuur.uitgegeven': 'Factuur uitgegeven',
  'factuurgegevens.gewijzigd': 'Factuurgegevens gewijzigd',
};

/** Leesbare naam van een audit-actie (onbekende acties: de technische naam). */
export function actionLabel(action: string): string {
  return LABELS[action] ?? action;
}

function detailText(d: Record<string, unknown> | null): string {
  if (!d) return '';
  return Object.entries(d)
    .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join(' · ')
    .slice(0, 200);
}

export const audit: CockpitModule = {
  key: 'audit',
  nav: [{ key: 'audit', label: 'Audit-log', href: '/audit', icon: 'audit', group: 'beheer', order: 10 }],
  register({ pages }, ctx) {
    pages.get('/audit', async (c) => {
      const alles = c.req.query('alles') === '1';
      const zoek = c.req.query('zoek') ?? '';
      const before = c.req.query('voor');
      const rows = await listCockpitAudit(ctx.cockpit.p.pool, { alles, zoek, before, limit: 50 });
      const qs = (extra: Record<string, string>) => {
        const u = new URLSearchParams({ ...(alles ? { alles: '1' } : {}), ...(zoek ? { zoek } : {}), ...extra });
        const s = u.toString();
        return s ? `/audit?${s}` : '/audit';
      };
      return ctx.page(c, {
        title: 'Audit-log',
        active: 'audit',
        eyebrow: 'Beheer',
        tabs: [
          ['Beheeracties', zoek ? `/audit?zoek=${encodeURIComponent(zoek)}` : '/audit', !alles],
          ['Alles, ook klanten', qs({ alles: '1' }), alles],
        ],
        children: (
          <section class="card">
            <form class="filter" method="get" action="/audit">
              {alles ? <input type="hidden" name="alles" value="1" /> : null}
              <input type="search" name="zoek" value={zoek} placeholder="Zoek op actie, e-mail of bedrijf" aria-label="Zoeken in audit-log" />
              <button class="btn secondary sm" type="submit">
                Zoeken
              </button>
            </form>
            {rows.length === 0 ? (
              <Empty title="Geen regels gevonden" />
            ) : (
              <div class="table-wrap">
                <table class="table">
                  <thead>
                    <tr>
                      <th>Tijd</th>
                      <th>Actie</th>
                      <th>Door</th>
                      <th>Bedrijf</th>
                      <th>Details</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr>
                        <td class="nowrap">{datumTijd(r.at)}</td>
                        <td>{actionLabel(r.action)}</td>
                        <td>
                          {r.actor_email ?? (r.actor === 'systeem' ? 'Systeem' : '')}
                          {r.actor.startsWith('medewerker:') ? <span class="tag">Qbicle</span> : null}
                        </td>
                        <td>{r.organization_name ?? ''}</td>
                        <td class="muted small">{detailText(r.detail)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {rows.length === 50 ? (
              <p>
                <a href={qs({ voor: rows[rows.length - 1]!.id })}>Oudere regels</a>
              </p>
            ) : null}
          </section>
        ),
      });
    });
  },
};
