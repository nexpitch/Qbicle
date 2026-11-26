import type pg from 'pg';
import type { Mailer } from './mailer.ts';
import type { TxtResolver } from './dns.ts';

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
}

export const DEFAULT_CONFIG: PlatformConfig = {
  appOrigin: 'http://localhost:3000',
  loginTokenMinutes: 15,
  sessionIdleDays: 7,
  sessionMaxDays: 30,
  invitationDays: 7,
  domainMailHours: 24,
  dnsReverifyDays: 30,
};

/** Alles wat de platformlogica van buiten nodig heeft; in tests vervangen. */
export interface Platform {
  pool: pg.Pool;
  mailer: Mailer;
  dns: TxtResolver;
  config: PlatformConfig;
}
