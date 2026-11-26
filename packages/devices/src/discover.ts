import { buildInventory, type InventoryAsset, type Observation, type Source } from '@qbicle/inventory';
import { score, type Outcome, type ScoreResult } from '@qbicle/score';
import { deviceFindings, type DeviceFindingResult } from './findings.ts';
import { readoutToObservations, type ClassifiedClient } from './observations.ts';
import type { OuiDb } from './oui.ts';
import type { PrivacyPolicy } from './privacy.ts';
import { ConnectorError } from './transport.ts';
import type { Readout, RouterConnector } from './types.ts';
import type { VulnDb } from './vulns/db.ts';

export interface DiscoveryInput {
  connectors: Array<{ connector: RouterConnector; source: Source }>;
  /** Waarnemingen uit andere bronnen (Intune, scanner, ...), om mee samen te voegen. */
  otherObservations?: Observation[];
  oui: OuiDb;
  privacy: PrivacyPolicy;
  vulnDb: VulnDb;
  now: Date;
}

export interface DiscoveryResult extends DeviceFindingResult {
  readouts: Readout[];
  /** Per bron: gelukt of de foutcode (nooit met inloggegevens). */
  sources: Array<{ sourceId: string; outcome: Outcome; error?: string }>;
  observations: Observation[];
  clients: ClassifiedClient[];
  assets: InventoryAsset[];
  score: ScoreResult;
}

/**
 * Eén ronde: routers uitlezen, waarnemingen maken, samenvoegen met de rest van de
 * inventaris, componenten aan kwetsbaarheden koppelen en de urgentie berekenen.
 * Een router die niet uit te lezen is, telt als "error" in de dekking: nooit als veilig.
 */
export async function discover(input: DiscoveryInput): Promise<DiscoveryResult> {
  const readouts: Readout[] = [];
  const sources: DiscoveryResult['sources'] = [];
  const observations: Observation[] = [...(input.otherObservations ?? [])];
  const clients: ClassifiedClient[] = [];

  for (const { connector, source } of input.connectors) {
    try {
      const readout = await connector.read();
      readouts.push(readout);
      const r = readoutToObservations(readout, { source, oui: input.oui, privacy: input.privacy });
      observations.push(...r.observations);
      clients.push(...r.clients);
      sources.push({ sourceId: source.id, outcome: 'ok' });
    } catch (err) {
      const msg = err instanceof ConnectorError ? `${err.code}: ${err.message}` : 'interne_fout';
      sources.push({ sourceId: source.id, outcome: 'error', error: msg });
    }
  }

  const assets = buildInventory(observations, { now: input.now });
  const found = deviceFindings(assets, input.vulnDb, input.now);
  const outcomes: Outcome[] = sources.map((s) => (s.outcome === 'ok' && found.findings.length > 0 ? 'finding' : s.outcome));
  return { readouts, sources, observations, clients, assets, ...found, score: score({ findings: found.findings, outcomes }) };
}
