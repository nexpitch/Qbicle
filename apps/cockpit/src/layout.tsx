/** @jsxImportSource hono/jsx */
import type { Child } from 'hono/jsx';
import { can, STAFF_ROLE_LABEL } from './core/roles.ts';
import type { StaffSession } from './core/staff.ts';
import { Icon } from './icons.tsx';
import { NAV_GROUP_LABEL, type NavGroup, type NavItem } from './module.ts';

const euroFmt = new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' });
const euroHeel = new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });

export const euro = (cents: number) => euroFmt.format(cents / 100);
export const euroKort = (cents: number) => (cents % 100 === 0 ? euroHeel.format(cents / 100) : euroFmt.format(cents / 100));
export function datum(d: Date | string | null | undefined): string {
  if (!d) return '';
  return new Date(d).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/Amsterdam' });
}
export function datumTijd(d: Date | string | null | undefined): string {
  if (!d) return '';
  return new Date(d).toLocaleString('nl-NL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Amsterdam' });
}

const GROUPS: NavGroup[] = ['start', 'klanten', 'financien', 'techniek', 'beheer'];

export interface ShellProps {
  title: string;
  staff: StaffSession;
  nav: NavItem[];
  active: string;
  /** Kleine regel boven de titel. */
  eyebrow?: string;
  /** Knoppen rechts naast de titel. */
  actions?: Child;
  /** Tabs onder de titel: [label, href, actief]. */
  tabs?: Array<[string, string, boolean]>;
  children: Child;
}

function Doc(props: { title: string; children: Child; bodyClass?: string }) {
  return (
    <html lang="nl">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex, nofollow" />
        <title>{`${props.title} · Qbicle Cockpit`}</title>
        <link rel="icon" href="/static/icoon.png" />
        <link rel="stylesheet" href="/static/cockpit.css" />
        <script src="/static/cockpit.js" defer></script>
      </head>
      <body class={props.bodyClass}>{props.children}</body>
    </html>
  );
}

/** De cockpit met zijbalk, zoekveld en paginakop. */
export function Shell(props: ShellProps) {
  const { staff } = props;
  const visible = props.nav.filter((n) => can(staff.role, n.permission ?? 'cockpit.lezen'));
  const naam = staff.user.displayName || staff.user.email;
  return (
    <Doc title={props.title}>
      <div class="shell">
        <input type="checkbox" id="menu" class="menu-toggle" aria-label="Menu openen of sluiten" />
        <aside class="side" aria-label="Cockpitmenu">
          <a class="brand" href="/">
            <img src="/static/woordmerk.png" alt="Qbicle" width="92" height="39" />
            <span class="intern">Cockpit</span>
          </a>
          <nav>
            {GROUPS.map((g) => {
              const items = visible.filter((n) => n.group === g).sort((a, b) => (a.order ?? 50) - (b.order ?? 50));
              if (items.length === 0) return null;
              return (
                <div class="nav-group">
                  {NAV_GROUP_LABEL[g] ? <p class="nav-label">{NAV_GROUP_LABEL[g]}</p> : null}
                  {items.map((n) => (
                    <a href={n.href} class={n.soon ? 'soon' : undefined} aria-current={props.active === n.key ? 'page' : undefined}>
                      <Icon name={n.icon} />
                      <span>{n.label}</span>
                      {n.soon ? <em>binnenkort</em> : null}
                    </a>
                  ))}
                </div>
              );
            })}
          </nav>
          <div class="me">
            <div class="avatar" aria-hidden="true">{naam.slice(0, 1).toUpperCase()}</div>
            <div class="me-txt">
              <b title={staff.user.email}>{naam}</b>
              <span>{STAFF_ROLE_LABEL[staff.role]}</span>
            </div>
            <form data-api="/api/uitloggen" data-next="/inloggen">
              <button class="icon-btn" type="submit" title="Uitloggen" aria-label="Uitloggen">
                <Icon name="uitloggen" />
              </button>
            </form>
          </div>
        </aside>
        <div class="main">
          <header class="topbar">
            <label for="menu" class="icon-btn menu-btn" aria-hidden="true">☰</label>
            <form class="search" action="/klanten" method="get" role="search">
              <Icon name="zoek" size={16} />
              <input type="search" name="zoek" placeholder="Zoek bedrijf, gebruiker of factuur" aria-label="Zoeken" />
            </form>
            <span class="env" title="Omgeving">Intern · alleen Qbicle</span>
          </header>
          <div class="page">
            <div class="page-head">
              <div>
                {props.eyebrow ? <p class="eyebrow">{props.eyebrow}</p> : null}
                <h1>{props.title}</h1>
              </div>
              {props.actions ? <div class="row">{props.actions}</div> : null}
            </div>
            {props.tabs ? (
              <nav class="tabs" aria-label="Onderdelen">
                {props.tabs.map(([label, href, on]) => (
                  <a href={href} aria-current={on ? 'page' : undefined}>
                    {label}
                  </a>
                ))}
              </nav>
            ) : null}
            {props.children}
          </div>
        </div>
      </div>
    </Doc>
  );
}

/** Kale pagina voor inloggen en MFA. */
export function Bare(props: { title: string; children: Child }) {
  return (
    <Doc title={props.title} bodyClass="bare">
      <main class="login">
        <div class="login-brand">
          <img src="/static/woordmerk.png" alt="Qbicle" width="104" height="44" />
          <span class="intern">Cockpit</span>
        </div>
        {props.children}
        <p class="small center">Alleen voor medewerkers van Qbicle. Elke actie wordt vastgelegd.</p>
      </main>
    </Doc>
  );
}

export function FormError() {
  return <p class="form-fout" role="alert" hidden></p>;
}

export type StatusKind = 'ok' | 'warn' | 'crit' | 'unk' | 'info';

export function Status(props: { kind: StatusKind; children: Child }) {
  return (
    <span class={`status st-${props.kind}`}>
      <i aria-hidden="true"></i>
      {props.children}
    </span>
  );
}

export function Kpi(props: { label: string; value: string; sub?: string; tone?: StatusKind; href?: string }) {
  const inner = (
    <>
      <p class="kpi-label">{props.label}</p>
      <p class="kpi-value">{props.value}</p>
      {props.sub ? <p class={`kpi-sub ${props.tone ? `t-${props.tone}` : ''}`}>{props.sub}</p> : null}
    </>
  );
  return props.href ? (
    <a class="kpi" href={props.href}>
      {inner}
    </a>
  ) : (
    <div class="kpi">{inner}</div>
  );
}

export function Empty(props: { title: string; children?: Child }) {
  return (
    <div class="empty">
      <b>{props.title}</b>
      {props.children ? <p>{props.children}</p> : null}
    </div>
  );
}
