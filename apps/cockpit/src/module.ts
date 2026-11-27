import type { Actor } from '@qbicle/platform';
import type { Context, Hono } from 'hono';
import type { z } from 'zod';
import type { Cockpit, StaffSession } from './core/staff.ts';
import type { Permission } from './core/roles.ts';
import type { IconName } from './icons.tsx';
import type { ShellProps } from './layout.tsx';

/**
 * Uitbreidpunt van de cockpit. Elk onderdeel (Bedrijven, Incasso's, Gebruik,
 * Support, Agents, ...) is één bestand in src/modules/ dat een CockpitModule
 * exporteert, en één regel in src/modules/index.ts.
 *
 * De shell regelt inloggen, MFA, rechten op de navigatie, de lay-out, CSRF en
 * beveiligingsheaders. Een module hoeft alleen pagina's en API-routes te leveren.
 */

export type NavGroup = 'start' | 'klanten' | 'financien' | 'techniek' | 'beheer';

export const NAV_GROUP_LABEL: Record<NavGroup, string> = {
  start: '',
  klanten: 'Klanten',
  financien: 'Financiën',
  techniek: 'Techniek en support',
  beheer: 'Beheer',
};

export interface NavItem {
  key: string;
  label: string;
  href: string;
  icon: IconName;
  group: NavGroup;
  /** Wie het menu-item ziet (standaard iedereen met cockpit.lezen). */
  permission?: Permission;
  /** Volgorde binnen de groep (laag eerst). */
  order?: number;
  /** Nog niet gebouwd: grijs label "binnenkort". */
  soon?: boolean;
}

export type CockpitVars = {
  /** Altijd gezet in modules: de shell laat alleen medewerkers met MFA door. */
  staff: StaffSession;
  /** Voor het audit-log; kind is 'medewerker'. */
  actor: Actor;
};
export type CockpitEnv = { Variables: CockpitVars };
export type CockpitContext = Context<CockpitEnv>;

export type PageProps = Omit<ShellProps, 'staff' | 'nav'>;

export interface ModuleContext {
  cockpit: Cockpit;
  /** Rendert een pagina in de cockpit-lay-out (zijbalk, kop, tabs). */
  page(c: CockpitContext, props: PageProps): Response | Promise<Response>;
  /** Gooit geen_toegang als de medewerker deze permissie niet heeft. */
  require(c: CockpitContext, permission: Permission): void;
  /** Valideert een JSON-body (zod) en geeft nette foutmeldingen. */
  body<T extends z.ZodType>(c: CockpitContext, schema: T): Promise<z.infer<T>>;
}

export interface CockpitModule {
  key: string;
  nav: NavItem[];
  /**
   * Routes van deze module. `pages` voor HTML (GET), `api` voor wijzigingen
   * (POST/PATCH/DELETE als JSON, onder /api; Origin wordt al gecontroleerd).
   */
  register(routes: { pages: Hono<CockpitEnv>; api: Hono<CockpitEnv> }, ctx: ModuleContext): void;
}
