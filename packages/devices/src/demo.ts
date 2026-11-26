import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Source } from '@qbicle/inventory';
import { TableConnector, UpnpIgdConnector, createConnector } from './connectors/index.ts';
import { OuiDb } from './oui.ts';
import { Secret } from './secrets.ts';
import { FixtureTransport } from './transport.ts';
import type { RouterConnector, RouterProduct } from './types.ts';
import { VulnDb, type NcscAdvisory } from './vulns/db.ts';
import { EolDb, type EolCycle, type HardwareEol } from './eol.ts';

/** Fixtures: zie packages/devices/fixtures/README.md. Alleen voor tests en de demo. */
export const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '../fixtures');

const read = (name: string) => readFileSync(join(FIXTURES_DIR, name), 'utf8');

export type DemoProduct = RouterProduct | 'upnp';

export function fixtureTransport(product: DemoProduct): FixtureTransport {
  return new FixtureTransport(JSON.parse(read(`${product}.json`)) as ConstructorParameters<typeof FixtureTransport>[0]);
}

export const DEMO_SOURCES: Record<DemoProduct, Source> = {
  upnp: { id: 'kpn-modem-thuis', kind: 'connector', product: 'upnp', level: '2P', network: 'thuis' },
  unifi: { id: 'unifi-utrecht', kind: 'netwerk', product: 'unifi', level: '1C', network: 'utrecht' },
  fritzbox: { id: 'fritzbox-amersfoort', kind: 'netwerk', product: 'fritzbox', level: '1C', network: 'amersfoort' },
  mikrotik: { id: 'mikrotik-werkplaats', kind: 'netwerk', product: 'mikrotik', level: '1C', network: 'werkplaats' },
  meraki: { id: 'meraki-zwolle', kind: 'netwerk', product: 'meraki', level: '1C', network: 'zwolle' },
};

export function demoConnector(product: DemoProduct, now = new Date('2026-11-26T12:00:00Z')): { connector: RouterConnector; transport: FixtureTransport } {
  const transport = fixtureTransport(product);
  if (product === 'upnp') return { connector: new UpnpIgdConnector(transport, { descriptionPath: '/rootDesc.xml', now: () => now }), transport };
  const credentials =
    product === 'unifi' || product === 'meraki'
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

/** Voorbeelddata, zie fixtures/eol-voorbeeld.json: niet als feit gebruiken. */
export function demoEolDb(): EolDb {
  const raw = JSON.parse(read('eol-voorbeeld.json')) as { hardware: HardwareEol[]; cycles: Record<string, EolCycle[]> };
  const db = new EolDb();
  db.addHardware(raw.hardware);
  for (const [product, cycles] of Object.entries(raw.cycles)) db.addCycles(product, cycles);
  return db;
}

/** Vaste demosleutel voor pseudonimisering. Nooit in productie gebruiken. */
export const DEMO_PSEUDONYM_KEY = Buffer.alloc(32, 7);

/**
 * Wat de lokale connector achter een providermodem ziet (ARP en mDNS), voor de demo:
 * het modem zelf geeft zonder providerlogin geen apparatenlijst.
 */
export function demoBehindModem(now = new Date('2026-11-26T12:00:00Z')): { connector: RouterConnector; source: Source } {
  const connector = new TableConnector(
    [
      { format: 'arp-unix', content: '? (192.168.2.10) at a4:c3:f0:77:88:99 on en0 [ethernet]\n? (192.168.2.40) at c0:56:e3:99:88:77 on en0 [ethernet]\n' },
      { format: 'avahi-browse', content: '=;en0;IPv4;Werkplek;_smb._tcp;local;DESKTOP-4F7K2Q.local;192.168.2.10;445;\n=;en0;IPv4;Camera;_rtsp._tcp;local;camera-voordeur.local;192.168.2.40;554;\n' },
    ],
    { now: () => now },
  );
  return { connector, source: { id: 'connector-thuis', kind: 'connector', product: 'qbicle-connector', level: '2P', network: 'thuis' } };
}
