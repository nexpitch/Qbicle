import { createHash } from 'node:crypto';
import { exposureFactor, inventoryFindings, type InventoryAsset, type InventoryFinding } from '@qbicle/inventory';
import type { Asset as ScoreAsset, Finding, LinkedVuln } from '@qbicle/score';
import { shortVendor } from './classify.ts';
import { componentsFor, type Component } from './vulns/cpe.ts';
import type { ComponentVuln, VulnDb } from './vulns/db.ts';
import type { EolDb } from './eol.ts';
import type { Readout } from './types.ts';

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
  1433: 'SQL Server',
  3306: 'MySQL',
  3389: 'Extern bureaublad (RDP)',
  5432: 'PostgreSQL',
  5900: 'VNC',
  8291: 'MikroTik Winbox',
};
const WEB_ADMIN = new Set([80, 443, 8080, 8443]);
const SENSITIVE = new Set(['router', 'firewall', 'camera', 'nas', 'alarmsysteem', 'zonnepanelen', 'laadpaal', 'iot', 'printer']);

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
      const risky = RISKY_PORTS[f.internalPort] ?? RISKY_PORTS[f.externalPort];
      // Een beheerpagina (80/443/...) telt alleen zwaar als we weten dat het een gevoelig apparaat is.
      const admin = risky !== undefined || (known !== undefined && WEB_ADMIN.has(f.internalPort) && SENSITIVE.has(known.category));
      const key = admin ? 'apparaat.beheerpoort_open_naar_internet' : 'apparaat.poort_open_naar_internet';
      const what = known ? (known === router ? 'router' : label(known)) : `apparaat op ${f.internalIp}`;
      out.push({
        key,
        checkKey: 'inventaris.doorgezette_poorten',
        asset: sa,
        certainty: 'vastgesteld',
        title: admin
          ? `${known ? 'Je ' : 'Een '}${what} is vanaf internet bereikbaar via ${risky ?? 'de beheerpagina'}`
          : `Een poort van ${known ? 'je ' : 'een '}${what} staat open naar internet`,
        detail:
          `De router zet ${f.protocol.toUpperCase()}-poort ${f.externalPort} door naar ${f.internalIp}:${f.internalPort}` +
          `${f.description ? ` ("${f.description}")` : ''}, ${f.origin === 'upnp' ? 'zelf geopend door het apparaat via UPnP' : 'ingesteld als regel in de router'}.` +
          (admin ? ' Dit soort toegang is een van de meest misbruikte ingangen; gebruik een VPN in plaats van een open poort.' : ''),
        fingerprint: fingerprint(sa.type, sa.value, key, `${f.protocol}/${f.externalPort}`),
        z: 1.0, // Direct bereikbaar vanaf internet.
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
