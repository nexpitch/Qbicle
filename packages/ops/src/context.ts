import type pg from 'pg';
import type { Mailer } from '@qbicle/platform';
import type { UsageConfig } from './config.ts';

/** Alles wat de cockpit-logica van buiten nodig heeft; in tests vervangen. */
export interface OpsContext {
  pool: pg.Pool;
  config: UsageConfig;
  /** Voor mails aan klanten die een medewerker heeft goedgekeurd. */
  mailer: Mailer;
}

/** Rollen van Qbicle-medewerkers (staff_member.role, cockpit-shell). */
export const STAFF_ROLES = ['beheerder', 'financieel', 'support', 'lezer'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

/**
 * Wie doet iets in de cockpit. Een medewerker is al ingelogd (met MFA) via de
 * cockpit-shell, die ook de rol uit staff_member haalt. Een agent heeft geen
 * gebruiker en kan per ontwerp alleen voorstellen doen.
 */
export type OpsActor =
  | { kind: 'medewerker'; userId: string; role: StaffRole; ip?: string | null }
  | { kind: 'agent'; agentKey: string }
  | { kind: 'systeem' };

export function actorLabel(a: OpsActor): string {
  if (a.kind === 'medewerker') return `gebruiker:${a.userId}`;
  if (a.kind === 'agent') return `agent:${a.agentKey}`;
  return 'systeem';
}
