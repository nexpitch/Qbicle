#!/usr/bin/env node
/**
 * Apparaten uitlezen via een router, of de demo met fixtures.
 *
 *   npm run apparaten -- --demo                 # alle drie de fixtures (UniFi, FRITZ!Box, MikroTik)
 *   npm run apparaten -- --demo fritzbox --json
 *
 *   # Echte router (alleen-lezen gebruiker; wachtwoord of sleutel via omgevingsvariabele, nooit als argument):
 *   QBICLE_ROUTER_WACHTWOORD=... npm run apparaten -- --product mikrotik --url https://192.168.88.1 --gebruiker qbicle --cert router.pem
 *   QBICLE_ROUTER_SLEUTEL=... npm run apparaten -- --product unifi --url https://192.168.1.1 --cert console.pem
 *
 *   # Eerste test op je eigen netwerk (providermodem via UPnP + ARP-tabel van je computer).
 *   # Op een Mac doet scripts/mijn-netwerk.sh dit allemaal voor je, via Docker.
 *   npm run apparaten -- --lokaal --gateway 192.168.2.254 --arp arp.txt --uit netwerk
 *
 * Bij --product en --demo wordt niets opgeslagen; de uitvoer gaat alleen naar je terminal.
 * Bij --lokaal komen een overzicht (rapport.html) en de inventaris (JSON) in de map van --uit.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { Source } from '@qbicle/inventory';
import { createConnector } from './connectors/index.ts';
import { type DemoProduct, DEMO_PSEUDONYM_KEY, DEMO_SOURCES, demoBehindModem, demoConnector, demoEolDb, demoOui, demoVulnDb } from './demo.ts';
import type { EolDb } from './eol.ts';
import { discover, type DiscoveryResult } from './discover.ts';
import { OuiDb } from './oui.ts';
import { DEFAULT_PRIVACY } from './privacy.ts';
import { Secret, orgPseudonymKey } from './secrets.ts';
import type { RouterConnector, RouterProduct } from './types.ts';
import { VulnDb } from './vulns/db.ts';
import { runLocal } from './lokaal.ts';
import { renderReport } from './rapport.ts';

const PRODUCTS: RouterProduct[] = ['unifi', 'fritzbox', 'mikrotik', 'meraki'];

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      demo: { type: 'boolean' },
      json: { type: 'boolean' },
      product: { type: 'string' },
      url: { type: 'string' },
      gebruiker: { type: 'string' },
      cert: { type: 'string' },
      site: { type: 'string' },
      lokaal: { type: 'boolean' },
      gateway: { type: 'string' },
      arp: { type: 'string' },
      uit: { type: 'string' },
      ping: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0]!.replace(/^#!.*\n\/\*\*?/, '').replace(/^ \* ?/gm, ''));
    return 0;
  }

  if (values.lokaal) return local(values);

  const now = new Date(values.demo ? '2026-11-26T12:00:00Z' : Date.now());
  let connectors: Array<{ connector: RouterConnector; source: Source }>;
  let oui: OuiDb;
  let vulnDb: VulnDb;
  let pseudonymKey: Buffer;
  let eolDb: EolDb | undefined;

  if (values.demo) {
    const demoProducts: DemoProduct[] = [...PRODUCTS, 'upnp'];
    const wanted = (positionals[0] ? [positionals[0]] : demoProducts) as DemoProduct[];
    for (const p of wanted) if (!demoProducts.includes(p)) throw new Error(`Onbekend product ${p}`);
    connectors = wanted.map((p) => ({ connector: demoConnector(p, now).connector, source: DEMO_SOURCES[p] }));
    if (wanted.includes('upnp')) connectors.push(demoBehindModem(now));
    oui = demoOui();
    vulnDb = demoVulnDb();
    eolDb = demoEolDb();
    pseudonymKey = DEMO_PSEUDONYM_KEY;
  } else {
    const product = values.product as RouterProduct;
    if (!PRODUCTS.includes(product) || !values.url) throw new Error('Geef --product (unifi, fritzbox, mikrotik, meraki) en --url, of gebruik --demo');
    const certPem = values.cert ? readFileSync(values.cert, 'utf8') : undefined;
    const credentials =
      product === 'unifi' || product === 'meraki'
        ? { kind: 'api-key' as const, apiKey: new Secret(env('QBICLE_ROUTER_SLEUTEL')) }
        : { kind: 'wachtwoord' as const, username: values.gebruiker ?? 'qbicle', password: new Secret(env('QBICLE_ROUTER_WACHTWOORD')) };
    const connector = createConnector({
      product,
      baseUrl: values.url,
      credentials,
      tls: certPem ? { mode: 'vastgepind', certPem } : { mode: 'systeem' },
      site: values.site,
    });
    connectors = [{ connector, source: { id: `${product}-cli`, kind: 'netwerk', product, level: '1C', network: 'cli' } }];
    oui = process.env.QBICLE_OUI_FILE ? OuiDb.fromFile(process.env.QBICLE_OUI_FILE) : OuiDb.empty();
    vulnDb = new VulnDb();
    for (const [envName, add] of [
      ['QBICLE_NVD_FILE', (s: string) => vulnDb.addNvd(JSON.parse(s))],
      ['QBICLE_KEV_FILE', (s: string) => vulnDb.addKev(JSON.parse(s))],
      ['QBICLE_EPSS_FILE', (s: string) => vulnDb.addEpssCsv(s)],
    ] as const) {
      const f = process.env[envName];
      if (f) add(readFileSync(f, 'utf8'));
    }
    pseudonymKey = process.env.QBICLE_PSEUDONYM_KEY ? orgPseudonymKey('cli') : DEMO_PSEUDONYM_KEY;
    if (oui.size === 0) console.error('Let op: geen MAC-prefixregister (QBICLE_OUI_FILE); fabrikant uit MAC valt weg.');
  }

  const result = await discover({ connectors, oui, vulnDb, eolDb, now, privacy: { ...DEFAULT_PRIVACY, pseudonymKey } });
  if (values.json) {
    console.log(JSON.stringify({ sources: result.sources, readouts: result.readouts.map((r) => ({ ...r, clients: r.clients.length })), clients: result.clients, assets: result.assets, components: result.components, vulns: result.vulns.map((v) => ({ asset: v.component.assetKey, cve: v.cve.id, certainty: v.certainty, kev: Boolean(v.kev), ncsc: v.ncsc?.id })), findings: result.findings, score: result.score }, null, 2));
  } else print(result);
  return result.sources.some((s) => s.outcome === 'error') ? 2 : 0;
}

async function local(values: { gateway?: string; arp?: string; uit?: string; ping?: boolean; json?: boolean }): Promise<number> {
  if (!values.gateway || !values.arp) throw new Error('Geef --gateway (adres van je modem) en --arp (bestand met de uitvoer van arp -a)');
  const ouiFile = process.env.QBICLE_OUI_FILE;
  const oui = ouiFile && existsSync(ouiFile) ? OuiDb.fromFile(ouiFile) : OuiDb.empty();
  const now = new Date();
  const result = await runLocal({ gateway: values.gateway, tables: [{ format: 'arp-unix', content: readFileSync(values.arp, 'utf8') }], oui, now });
  const out = values.uit ?? '.';
  mkdirSync(out, { recursive: true });
  const stamp = now.toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
  // De inventaris van deze test, om later te vergelijken of in de database te laden.
  const inventory = {
    gemaakt: now.toISOString(),
    gateway: result.gateway,
    upnp: result.upnpLocation ?? null,
    bronnen: result.sources,
    meldingen: [...result.notes, ...result.readouts.flatMap((r) => r.warnings)],
    assets: result.assets,
    bevindingen: result.findings,
    urgentie: { score: result.score.urgency, band: result.score.band.label },
  };
  writeFileSync(join(out, `inventaris-${stamp}.json`), JSON.stringify(inventory, null, 2));
  writeFileSync(join(out, 'rapport.html'), renderReport(result, { generatedAt: now, pingSweep: Boolean(values.ping) }));
  if (values.json) console.log(JSON.stringify(inventory, null, 2));
  else {
    print(result);
    for (const n of result.notes) console.log(`! ${n}`);
    console.log(`\nOverzicht opgeslagen in ${join(out, 'rapport.html')}`);
  }
  return 0;
}

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Zet ${name}`);
  return v;
}

function print(r: DiscoveryResult): void {
  for (const s of r.sources) console.log(`${s.outcome === 'error' ? '✗' : '✓'} ${s.sourceId}${s.error ? `: ${s.error}` : ''}`);
  for (const ro of r.readouts) for (const w of ro.warnings) console.log(`  ! ${ro.product}: ${w}`);
  console.log('');
  const rows = r.assets
    .filter((a) => a.kind === 'apparaat' || a.kind === 'netwerkapparaat' || a.kind === 'ip-adres')
    .map((a) => ({
      categorie: a.category + (a.attributes.category?.certainty === 'mogelijk' ? '?' : ''),
      naam: a.attributes.name?.value ?? '',
      fabrikant: a.attributes.vendor?.value ?? '',
      firmware: [a.attributes.os?.value, a.attributes.firmware?.value].filter(Boolean).join(' '),
      sleutel: a.key.length > 40 ? a.key.slice(0, 37) + '...' : a.key,
    }));
  console.table(rows);
  console.log('? = afgeleid (mogelijk)\n');
  for (const f of r.findings) console.log(`• [${f.certainty}] ${f.title}\n    ${f.detail}`);
  console.log(`\nUrgentie ${r.score.urgency}/100 (${r.score.band.label})${r.score.bandRaisedByKev ? ', verhoogd door actief misbruikt lek' : ''}`);
  for (const a of r.score.topActions) console.log(`  → ${a.title}`);
}

main().then(
  (code) => process.exit(code),
  (err) => {
    // Alleen de melding, nooit de stack met argumenten of omgeving.
    console.error(`Fout: ${err instanceof Error ? err.message : 'onbekend'}`);
    process.exit(1);
  },
);
