import { createHash } from 'node:crypto';
import { exposureFactor, inventoryFindings, type InventoryAsset, type InventoryFinding } from '@qbicle/inventory';
import type { Asset as ScoreAsset, Finding, LinkedVuln } from '@qbicle/score';
import { shortVendor } from './classify.ts';
import { componentsFor, type Component } from './vulns/cpe.ts';
import type { ComponentVuln, VulnDb } from './vulns/db.ts';
import type { EolDb } from './eol.ts';
import type { PortForward, Readout } from './types.ts';

/** Zelfde vorm als de vingerafdruk van de scanner: zelfde fout op hetzelfde asset = zelfde waarde. */
export function fingerprint(assetType: string, assetValue: string, key: string, discriminator = ''): string {
  return createHash('sha256').update([assetType, assetValue.toLowerCase(), key, discriminator].join('\u0000')).digest('hex').slice(0, 32);
}

const EDGE = new Set(['router', 'firewall']);

const CATEGORY_LABEL: Record<string, string> = {
  laptop: 'laptop',
  desktop: 'computer',
  telefoon: 'telefoon',
  tablet: 'tablet',
  server: 'server',
  router: 'router',
  firewall: 'firewall',
  accesspoint: 'wifi-accesspoint',
  switch: 'switch',
  camera: 'camera',
  printer: 'printer',
  nas: 'NAS',
  'slimme-speaker': 'slimme speaker',
  alarmsysteem: 'alarmsysteem',
  zonnepanelen: 'omvormer van je zonnepanelen',
  laadpaal: 'laadpaal',
  iot: 'slim apparaat',
  'tv-media': 'tv of mediaspeler',
};

/**
 * Factor z voor een inventaris-asset. Een router of firewall staat per definitie
 * aan de rand van het netwerk: een lek daarin telt als "internet".
 */
export function zFor(asset: InventoryAsset): number {
  if (EDGE.has(asset.category)) return exposureFactor('internet', asset.managed);
  return exposureFactor(asset.exposure, asset.managed);
}

function scoreAsset(asset: InventoryAsset): ScoreAsset {
  return {
    type: asset.kind === 'netwerkapparaat' ? 'netwerkapparaat' : 'apparaat',
    value: asset.key,
    source: `inventaris:${asset.sourceIds.join('+')}`,
    // Niet gebruikt voor inventaris-assets: z komt uit zFor.
    visibility: 'primair',
  };
}

function label(asset: InventoryAsset): string {
  const provider = asset.attributes.provider?.value;
  const what = provider ? `modem van ${provider}` : (CATEGORY_LABEL[asset.category] ?? 'apparaat');
  const vendor = asset.attributes.vendor?.value;
  const model = [vendor ? shortVendor(vendor) : undefined, asset.attributes.model?.value].filter(Boolean).join(' ');
  return model ? `${what} (${model})` : what;
}

export interface DeviceFindingResult {
  components: Component[];
  vulns: ComponentVuln[];
  findings: Finding[];
}

/**
 * Bevindingen voor het scoremodel uit de apparateninventaris:
 * - bekende kwetsbaarheden in firmware (CVE, met KEV/EPSS/NCSC als factor m),
 * - een firmware-update die volgens het apparaat zelf klaarstaat,
 * - apparaten of firmware zonder updates meer (end-of-life),
 * - de bevindingen uit de inventaris zelf (onbeheerd, updates achter, MFA).
 */
export function deviceFindings(assets: InventoryAsset[], vulnDb: VulnDb, now: Date, eolDb?: EolDb): DeviceFindingResult {
  const active = assets.filter((a) => a.status === 'actief');
  const components = active.flatMap(componentsFor);
  const vulns = vulnDb.match(components);
  const findings: Finding[] = [];

  const byAsset = new Map<string, ComponentVuln[]>();
  for (const v of vulns) byAsset.set(v.component.assetKey, [...(byAsset.get(v.component.assetKey) ?? []), v]);

  for (const asset of active) {
    const sa = scoreAsset(asset);
    const z = zFor(asset);
    const list = byAsset.get(asset.key) ?? [];
    if (list.length > 0) {
      const key = asset.kind === 'netwerkapparaat' ? 'netwerkapparaat.kwetsbaarheid' : 'apparaat.kwetsbaarheid';
      const certain = list.some((v) => v.certainty === 'vastgesteld');
      const kev = list.filter((v) => v.kev);
      const linked: LinkedVuln[] = list.map((v) => v.linked);
      const c = list[0]!.component;
      const what = label(asset);
      findings.push({
        key,
        checkKey: 'inventaris.kwetsbaarheden',
        asset: sa,
        certainty: certain ? 'vastgesteld' : 'mogelijk',
        title: kev.length
          ? `Je ${what} heeft een lek dat aanvallers nu actief misbruiken`
          : `Je ${what} heeft ${list.length === 1 ? 'een bekend beveiligingslek' : `${list.length} bekende beveiligingslekken`}`,
        detail:
          `${c.product} ${c.version ?? '(versie onbekend)'}: ${list.map((v) => v.cve.id + (v.kev ? ' (KEV)' : '') + (v.ncsc ? ` (${v.ncsc.id})` : '')).join(', ')}.` +
          (certain ? '' : ' De exacte versie of het precieze product is niet zeker; laat het controleren.'),
        fingerprint: fingerprint(sa.type, sa.value, key),
        vulns: linked,
        z,
      });
    }
    for (const eol of eolDb?.check(asset, now) ?? []) {
      if (eol.status !== 'buiten-ondersteuning' && eol.status !== 'binnenkort') continue;
      const key = `${asset.kind === 'netwerkapparaat' ? 'netwerkapparaat' : 'apparaat'}.${eol.status === 'binnenkort' ? 'einde_ondersteuning_binnenkort' : 'einde_ondersteuning'}`;
      const what = label(asset);
      const sub = eol.what === 'hardware' ? `Je ${what}` : `De firmware van je ${what}`;
      findings.push({
        key,
        checkKey: 'inventaris.eol',
        asset: sa,
        certainty: eol.certainty,
        title: eol.status === 'binnenkort' ? `${sub} krijgt binnenkort geen updates meer` : `${sub} krijgt geen beveiligingsupdates meer`,
        detail:
          `${eol.what === 'hardware' ? 'Model' : 'Firmware'} ${eol.what === 'hardware' ? asset.attributes.model?.value : asset.attributes.firmware?.value}: ` +
          `ondersteuning ${eol.status === 'binnenkort' ? 'stopt' : 'gestopt'} op ${eol.date ?? 'onbekende datum'}${eol.source ? ` (bron: ${eol.source})` : ''}. ` +
          (eol.what === 'hardware' ? 'Nieuwe lekken worden niet meer gedicht; plan vervanging.' : 'Werk bij naar een ondersteunde versie.'),
        fingerprint: fingerprint(sa.type, sa.value, key, eol.what),
        z,
      });
    }
    if (asset.attributes.updateAvailable?.value === true) {
      const key = 'netwerkapparaat.update_beschikbaar';
      findings.push({
        key,
        checkKey: 'inventaris.firmware',
        asset: sa,
        certainty: 'vastgesteld',
        title: `Voor je ${label(asset)} staat een update klaar`,
        detail: `Volgens ${asset.attributes.updateAvailable.sourceId} is er nieuwere firmware dan ${asset.attributes.firmware?.value ?? 'de huidige'}.`,
        fingerprint: fingerprint(sa.type, sa.value, key),
        z,
      });
    }
  }

  for (const f of inventoryFindings(assets, { now })) findings.push(fromInventoryFinding(f, assets));
  return { components, vulns, findings };
}

function fromInventoryFinding(f: InventoryFinding, assets: InventoryAsset[]): Finding {
  const asset = assets.find((a) => a.key === f.assetKey)!;
  const sa = scoreAsset(asset);
  return {
    key: f.key,
    checkKey: 'inventaris',
    asset: sa,
    certainty: f.certainty,
    title: f.title,
    detail: f.detail,
    fingerprint: fingerprint(sa.type, sa.value, f.key),
    z: zFor(asset),
  };
}

/** Poorten die je nooit rechtstreeks open naar internet wilt hebben (ontwerp: "beheerpoort open naar internet"). */
export const RISKY_PORTS: Record<number, string> = {
  21: 'FTP',
  22: 'SSH',
  23: 'Telnet',
  139: 'Windows-bestandsdeling (NetBIOS)',
  445: 'Windows-bestandsdeling (SMB)',
  554: 'camerabeelden (RTSP)',
  1433: 'SQL Server',
  1723: 'verouderde VPN (PPTP)',
  2049: 'bestandsdeling (NFS)',
  3306: 'MySQL',
  3389: 'Extern bureaublad (RDP)',
  5000: 'NAS-beheer (Synology DSM)',
  5001: 'NAS-beheer (Synology DSM)',
  5432: 'PostgreSQL',
  5900: 'VNC',
  6379: 'Redis-database',
  8000: 'camerasysteem (Hikvision)',
  8291: 'MikroTik Winbox',
  9200: 'Elasticsearch-database',
  27017: 'MongoDB-database',
  37777: 'camerasysteem (Dahua)',
};
const WEB_ADMIN = new Set([80, 443, 8080, 8443]);
const SENSITIVE = new Set(['router', 'firewall', 'camera', 'nas', 'alarmsysteem', 'zonnepanelen', 'laadpaal', 'iot', 'printer']);

/** Waar je een doorgezette poort uitzet, per router. Gewone taal, menunamen zoals de fabrikant ze noemt. */
const CLOSE_STEPS: Record<Readout['product'], string> = {
  upnp: 'Open de beheerpagina van je modem, zoek "Port forwarding" (of "Poorten doorsturen") en verwijder de regel.',
  fritzbox: 'Open de FRITZ!Box (fritz.box), ga naar Internet > Freigaben > Portfreigaben (Engels: Internet > Permit Access > Port Sharing) en verwijder de regel.',
  unifi: 'Open UniFi Network, zoek in de instellingen "Port Forwarding" en zet de regel uit.',
  meraki: 'Open het Meraki-dashboard, ga naar Security & SD-WAN > Configure > Firewall en verwijder de regel onder "Port forwarding" of "1:1 NAT".',
  mikrotik: 'Open Winbox of WebFig, ga naar IP > Firewall > NAT en schakel de regel met actie "dst-nat" uit.',
  snmp: 'Zet de regel uit in de beheeromgeving van je router.',
  tabel: 'Zet de regel uit in de beheeromgeving van je router.',
};

function closeSteps(product: Readout['product'], f: PortForward): string {
  const steps = [
    f.origin === 'upnp'
      ? 'Het apparaat opende deze poort zelf via UPnP. Zet in het apparaat "toegang op afstand" of "P2P" uit, of zet UPnP uit in je modem; daarna verdwijnt de poort vanzelf.'
      : CLOSE_STEPS[product],
    'Heb je wel toegang van buitenaf nodig? Gebruik dan een VPN of de app van de fabrikant in plaats van een open poort.',
    'Klik daarna op "Opnieuw controleren"; we lezen de router opnieuw uit.',
  ];
  return steps.map((t, i) => `${i + 1}. ${t}`).join(' ');
}

/**
 * Bevindingen uit wat de router zelf over doorgezette poorten meldt (UPnP en NAT-regels).
 * Geen scan: de router vertelt welke poorten hij van internet naar binnen doorzet.
 */
export function forwardFindings(readouts: Readout[], assets: InventoryAsset[]): Finding[] {
  const out: Finding[] = [];
  for (const r of readouts) {
    const router = assets.find((a) => a.kind === 'netwerkapparaat' && r.devices.some((d) => (d.serial && a.identifiers.some((i) => i.type === 'serial' && i.value === d.serial!.toUpperCase())) || (d.mac && a.identifiers.some((i) => i.type === 'mac' && i.value === d.mac!.toLowerCase()))));
    for (const f of r.portForwards ?? []) {
      if (!f.enabled) continue;
      const known = assets.find((a) => a.status === 'actief' && a.identifiers.some((i) => i.type === 'ip' && i.value === f.internalIp));
      const target = known ?? router;
      if (!target) continue;
      const sa = scoreAsset(target);
      // De dienst zit op de interne poort; de buitenpoort zegt alleen iets als binnen geen webpagina draait.
      const risky = f.allPorts ? 'alle poorten' : (RISKY_PORTS[f.internalPort] ?? (WEB_ADMIN.has(f.internalPort) ? undefined : RISKY_PORTS[f.externalPort]));
      // Een beheerpagina (80/443/...) telt alleen zwaar als we weten dat het een gevoelig apparaat is.
      const admin = risky !== undefined || (known !== undefined && WEB_ADMIN.has(f.internalPort) && SENSITIVE.has(known.category));
      const key = admin ? 'apparaat.beheerpoort_open_naar_internet' : 'apparaat.poort_open_naar_internet';
      const what = known ? (known === router ? 'router' : label(known)) : `apparaat op ${f.internalIp}`;
      const limited = f.allowedFrom && f.allowedFrom.length > 0;
      const how = f.allPorts
        ? `De router stuurt al het verkeer van internet door naar ${f.internalIp} (1:1 NAT of DMZ)`
        : `De router zet ${f.protocol.toUpperCase()}-poort ${f.externalPort} door naar ${f.internalIp}:${f.internalPort}`;
      out.push({
        key,
        checkKey: 'inventaris.doorgezette_poorten',
        asset: sa,
        // Beperkt tot bepaalde adressen: open, maar niet voor iedereen. Dat weten we zeker, het risico is kleiner.
        certainty: 'vastgesteld',
        title: admin
          ? `${known ? 'Je ' : 'Een '}${what} is vanaf internet bereikbaar via ${risky ?? 'de beheerpagina'}${limited ? ' (voor een beperkt aantal adressen)' : ''}`
          : `Een poort van ${known ? 'je ' : 'een '}${what} staat open naar internet${limited ? ' (voor een beperkt aantal adressen)' : ''}`,
        detail:
          `${how}${f.description ? ` ("${f.description}")` : ''}, ${f.origin === 'upnp' ? 'zelf geopend door het apparaat via UPnP' : 'ingesteld als regel in de router'}.` +
          (limited ? ` Alleen bereikbaar vanaf ${f.allowedFrom!.join(', ')}.` : ' Iedereen op internet kan deze poort bereiken.') +
          (admin ? ' Dit soort toegang is een van de meest misbruikte ingangen.' : '') +
          ` Zo sluit je hem: ${closeSteps(r.product, f)}`,
        fingerprint: fingerprint(sa.type, sa.value, key, f.allPorts ? 'alle' : `${f.protocol}/${f.externalPort}`),
        // Direct bereikbaar vanaf internet; beperkt tot vaste adressen telt half zo zwaar.
        z: limited ? 0.5 : 1.0,
      });
    }
    if (r.upnpEnabled && router) {
      const sa = scoreAsset(router);
      const key = 'netwerkapparaat.upnp_aan';
      out.push({
        key,
        checkKey: 'inventaris.upnp',
        asset: sa,
        certainty: 'vastgesteld',
        title: 'Op je router staat UPnP aan: apparaten kunnen zelf poorten naar internet openzetten',
        detail: `UPnP staat aan op ${label(router)}. Handig voor spelcomputers, maar ook camera's en malware kunnen zo ongemerkt een opening maken.`,
        fingerprint: fingerprint(sa.type, sa.value, key),
        z: 1.0,
      });
    }
  }
  return out;
}

export type ForwardStatus = 'gecontroleerd' | 'deels' | 'niet_gecontroleerd';

export interface ForwardCoverage {
  status: ForwardStatus;
  /** In gewone taal: wat we wel en niet weten over open poorten. */
  uitleg: string;
  /** Routers waarvan de lijst niet (volledig) uit te lezen was. */
  nietUitgelezen: Readout['product'][];
}

/**
 * Eerlijke status voor "open poorten naar internet" (Erik, 27-11: "niet
 * gecontroleerd" is iets anders dan "geen problemen"). Alleen als élke router de
 * lijst met doorgezette poorten volledig gaf, mag het overzicht zeggen dat er
 * niets open staat. Een router achter een ander modem (dubbele NAT) telt als
 * deels: het modem ervoor kan ook poorten doorzetten.
 */
export function forwardCoverage(readouts: Readout[]): ForwardCoverage {
  if (readouts.length === 0) {
    return { status: 'niet_gecontroleerd', uitleg: 'Niet gecontroleerd: er is geen router gekoppeld. Koppel je router, dan lezen we uit welke poorten open staan naar internet.', nietUitgelezen: [] };
  }
  const missing = readouts.filter((r) => r.portForwardsRead !== true).map((r) => r.product);
  const behindNat = readouts.some((r) => r.privateWanIp);
  if (missing.length === readouts.length) {
    return { status: 'niet_gecontroleerd', uitleg: 'Niet gecontroleerd: de router gaf de lijst met doorgezette poorten niet. Zie de melding bij de koppeling.', nietUitgelezen: missing };
  }
  if (missing.length > 0 || behindNat) {
    return {
      status: 'deels',
      uitleg: behindNat && missing.length === 0
        ? 'Deels gecontroleerd: je router staat achter het modem van je provider. Koppel ook het modem, want ook dat kan poorten doorzetten.'
        : 'Deels gecontroleerd: niet elke router gaf de lijst met doorgezette poorten.',
      nietUitgelezen: missing,
    };
  }
  return { status: 'gecontroleerd', uitleg: 'Gecontroleerd: we lazen bij je router uit welke poorten hij van internet naar binnen doorzet.', nietUitgelezen: [] };
}
