import type pg from 'pg';
import type { Mailer } from './mailer.ts';
import type { TxtResolver } from './dns.ts';
import type { Catalog } from './catalog.ts';
import type { PaymentProvider } from './payments.ts';
import type { ViesClient } from './btw.ts';

export interface PlatformConfig {
  /** Basisadres van de web-app, bijv. https://app.qbicle.nl (voor links in e-mails). */
  appOrigin: string;
  loginTokenMinutes: number;
  sessionIdleDays: number;
  sessionMaxDays: number;
  invitationDays: number;
  domainMailHours: number;
  /** Na zoveel dagen zonder geslaagde hercontrole vervalt een DNS-verificatie. */
  dnsReverifyDays: number;
  /** Zo lang blijft een registratie geldig als de inloglink nog niet gebruikt is. */
  signupHours: number;
  /** Btw-nummer van Qbicle zelf (komt op facturen en gaat mee naar VIES voor een consultatienummer). Null tot de BV er is. */
  supplierVatNumber: string | null;
  /** Zo lang (dagen) telt een geldige VIES-controle voor btw verleggen; daarna eerst opnieuw controleren. */
  vatCheckMaxDays: number;
}

export const DEFAULT_CONFIG: PlatformConfig = {
  appOrigin: 'http://localhost:3000',
  loginTokenMinutes: 15,
  sessionIdleDays: 7,
  sessionMaxDays: 30,
  invitationDays: 7,
  domainMailHours: 24,
  dnsReverifyDays: 30,
  signupHours: 24,
  supplierVatNumber: null,
  vatCheckMaxDays: 31,
};

/** Alles wat de platformlogica van buiten nodig heeft; in tests vervangen. */
export interface Platform {
  pool: pg.Pool;
  mailer: Mailer;
  dns: TxtResolver;
  config: PlatformConfig;
  /** Prijzen en pakketten (config/abonnementen.json). */
  catalog: Catalog;
  /** Betaalprovider: nu testbetaling, later Mollie. */
  payments: PaymentProvider;
  /** VIES-btw-nummercheck van de EU. Zonder: elke controle telt als storing (dus geen 0%). */
  vies?: ViesClient;
}
