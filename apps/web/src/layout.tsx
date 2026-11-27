/** @jsxImportSource hono/jsx */
import type { Child } from 'hono/jsx';
import { STATIC_VERSION } from './static-version.ts';

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

/** 27 november 2026 om 14:02 (Nederlandse tijd) */
export function datumTijd(d: Date | string | null | undefined): string {
  if (!d) return '';
  return `${datum(d)} om ${tijd(d)}`;
}
/** 14:02 (Nederlandse tijd) */
export function tijd(d: Date | string): string {
  return new Date(d).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Amsterdam' });
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
  /** Zonder JavaScript de pagina elke zoveel seconden verversen (bijvoorbeeld tijdens een scan). */
  refreshSeconds?: number;
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
        <link rel="stylesheet" href={`/static/app.css?v=${STATIC_VERSION}`} />
        <script src={`/static/app.js?v=${STATIC_VERSION}`} defer></script>
        {props.refreshSeconds ? (
          <noscript>
            <meta http-equiv="refresh" content={String(props.refreshSeconds)} />
          </noscript>
        ) : null}
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
                {org ? link(`/o/${org.id}/assets`, 'Assets', 'assets') : null}
                {org ? link(`/o/${org.id}/domeinen`, 'Domeinen', 'domeinen') : null}
                {org ? link(`/o/${org.id}/systemen`, 'Systemen', 'systemen') : null}
                {org ? link(`/o/${org.id}/koppelingen`, 'Koppelingen', 'koppelingen') : null}
                {org ? link(`/o/${org.id}/account`, 'Account', 'account') : null}
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

export function Status(props: { kind: 'ok' | 'warn' | 'crit' | 'unk' | 'info'; children: Child }) {
  return (
    <span class={`status st-${props.kind}`}>
      <i aria-hidden="true"></i>
      {props.children}
    </span>
  );
}
