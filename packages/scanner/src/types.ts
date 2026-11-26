import type { Asset, Finding, Outcome } from '@qbicle/score';
import type { Net } from './net.ts';

/**
 * Niveau van een check (zie technisch ontwerp):
 * 0 = leest alleen gegevens die al openbaar bij derden staan (DNS, CT-logs)
 * 1 = doet wat een gewone browser of mailserver ook doet (één TLS-verbinding, één GET)
 * Niveau 2 (actief testen) bestaat bewust niet in deze scanner.
 */
export type Level = 0 | 1;

export type CheckGroup = 'domein' | 'e-mail' | 'certificaat' | 'website';

export interface CheckContext {
  /** Het opgegeven domein, genormaliseerd (kleine letters, punycode). */
  domain: string;
  /** Het asset waarop deze check draait. */
  asset: Asset;
  net: Net;
  now: Date;
  /** Gedeelde cache binnen één scan, zodat we elke host maar één keer opvragen. */
  memo<T>(key: string, fn: () => Promise<T>): Promise<T>;
}

/** Bevinding zoals een check die aanlevert; de runner vult asset en vingerafdruk aan. */
export type FindingDraft = Omit<Finding, 'fingerprint' | 'checkKey' | 'asset'> & {
  /** Maakt de vingerafdruk uniek per onderdeel, bijvoorbeeld per cookienaam. */
  discriminator?: string;
};

/** Wat een check teruggeeft; de runner vult de rest aan. */
export interface CheckOutput {
  outcome: Outcome;
  findings?: FindingDraft[];
  /** Ruw bewijs: wat we precies zagen. Gaat later naar objectopslag. */
  evidence?: Record<string, unknown>;
  /** Uitleg in gewone taal, vooral bij unknown, error en not_applicable. */
  message?: string;
}

export interface Check {
  key: string;
  level: Level;
  group: CheckGroup;
  /** Op welk type asset deze check draait. */
  appliesTo: 'domein' | 'website';
  title: string;
  run(ctx: CheckContext): Promise<CheckOutput>;
}

export interface CheckResult {
  checkKey: string;
  level: Level;
  group: CheckGroup;
  title: string;
  asset: Asset;
  outcome: Outcome;
  findings: Finding[];
  evidence: Record<string, unknown>;
  message?: string;
  durationMs: number;
}
