/** @jsxImportSource hono/jsx */
import type { Child } from 'hono/jsx';

const euroFmt = new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' });
const euroHeel = new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });

/** €1.234,56 */
export function euro(cents: number): string {
  return euroFmt.format(cents / 100);
}
/** €49 (zonder centen als het een heel bedrag is) */
export function euroKort(cents: number): string {
  return cents % 100 === 0 ? euroHeel.format(cents / 100) : euroFmt.format(cents / 100);
}
export function datum(d: Date | string | null | undefined): string {
  if (!d) return '';
  return new Date(d).toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Amsterdam' });
}

export interface PageUser {
  email: string;
}

export interface NavOrg {
  id: string;
  name: string;
}

export function Layout(props: {
  title: string;
  children: Child;
  user?: PageUser | undefined;
  org?: NavOrg | undefined;
  active?: string;
  /** Minimale kop (registreren, betalen). */
  minimal?: boolean;
}) {
  const { user, org } = props;
  const link = (href: string, label: string, key: string, cls?: string) => (
    <a href={href} class={cls} aria-current={props.active === key ? 'page' : undefined}>
      {label}
    </a>
  );
  return (
    <html lang="nl">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{`${props.title} · Qbicle`}</title>
        <link rel="icon" href="/static/icoon.png" />
        <link rel="stylesheet" href="/static/app.css" />
        <script src="/static/app.js" defer></script>
      </head>
      <body>
        <header class="top">
          <div class="top-in">
            <a class="logo" href={user ? '/overzicht' : '/aanmelden'} aria-label="Qbicle, naar de start">
              <img src="/static/woordmerk.png" alt="Qbicle" width="104" height="44" />
            </a>
            {props.minimal ? null : user ? (
              <nav aria-label="Hoofdmenu">
                {org ? <span class="org-name hide-sm">{org.name}</span> : null}
                {org ? link(`/o/${org.id}/overzicht`, 'Overzicht', 'overzicht') : null}
                {org ? link(`/o/${org.id}/systemen`, 'Systemen', 'systemen') : null}
                {org ? link(`/o/${org.id}/koppelingen`, 'Koppelingen', 'koppelingen') : null}
                {org ? link(`/o/${org.id}/abonnement`, 'Abonnement', 'abonnement') : null}
                <form data-api="/api/v1/auth/uitloggen" data-next="/inloggen">
                  <button class="linkbtn" type="submit">Uitloggen</button>
                </form>
              </nav>
            ) : (
              <nav aria-label="Hoofdmenu">
                {link('/aanmelden', 'Pakketten', 'aanmelden')}
                {link('/inloggen', 'Inloggen', 'inloggen')}
              </nav>
            )}
          </div>
        </header>
        <main class="wrap">{props.children}</main>
        <footer class="foot">Qbicle · gegevens opgeslagen in de EU · prijzen exclusief btw</footer>
      </body>
    </html>
  );
}

export function FormError() {
  return <p class="form-fout" role="alert" hidden></p>;
}

export function Status(props: { kind: 'ok' | 'warn' | 'crit' | 'unk'; children: Child }) {
  return (
    <span class={`status st-${props.kind}`}>
      <i aria-hidden="true"></i>
      {props.children}
    </span>
  );
}
