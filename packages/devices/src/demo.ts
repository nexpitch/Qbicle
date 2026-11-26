import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Source } from '@qbicle/inventory';
import { createConnector } from './connectors/index.ts';
import { OuiDb } from './oui.ts';
import { Secret } from './secrets.ts';
import { FixtureTransport } from './transport.ts';
import type { RouterConnector, RouterProduct } from './types.ts';
import { VulnDb, type NcscAdvisory } from './vulns/db.ts';

/** Fixtures: zie packages/devices/fixtures/README.md. Alleen voor tests en de demo. */
export const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '../fixtures');

const read = (name: string) => readFileSync(join(FIXTURES_DIR, name), 'utf8');

export function fixtureTransport(product: RouterProduct): FixtureTransport {
  return new FixtureTransport(JSON.parse(read(`${product}.json`)) as Record<string, string>);
}

export const DEMO_SOURCES: Record<RouterProduct, Source> = {
  unifi: { id: 'unifi-utrecht', kind: 'netwerk', product: 'unifi', level: '1C', network: 'utrecht' },
  fritzbox: { id: 'fritzbox-amersfoort', kind: 'netwerk', product: 'fritzbox', level: '1C', network: 'amersfoort' },
  mikrotik: { id: 'mikrotik-werkplaats', kind: 'netwerk', product: 'mikrotik', level: '1C', network: 'werkplaats' },
};

export function demoConnector(product: RouterProduct, now = new Date('2026-11-26T12:00:00Z')): { connector: RouterConnector; transport: FixtureTransport } {
  const transport = fixtureTransport(product);
  const credentials =
    product === 'unifi'
      ? ({ kind: 'api-key', apiKey: new Secret('demo-sleutel') } as const)
      : ({ kind: 'wachtwoord', username: 'qbicle', password: new Secret('demo-wachtwoord') } as const);
  // Vaste tijd, zodat tests en demo voorspelbaar zijn.
  const connector = createConnector({ product, baseUrl: 'https://192.0.2.1', credentials, tls: { mode: 'systeem' } }, transport, { now: () => now });
  return { connector, transport };
}

export function demoOui(): OuiDb {
  return OuiDb.fromCsv(read('oui-voorbeeld.csv'));
}

export function demoVulnDb(): VulnDb {
  const db = new VulnDb();
  db.addNvd(JSON.parse(read('nvd-voorbeeld.json')));
  db.addKev(JSON.parse(read('kev-voorbeeld.json')));
  db.addNcsc(JSON.parse(read('ncsc-voorbeeld.json')) as NcscAdvisory[]);
  return db;
}

/** Vaste demosleutel voor pseudonimisering. Nooit in productie gebruiken. */
export const DEMO_PSEUDONYM_KEY = Buffer.alloc(32, 7);
