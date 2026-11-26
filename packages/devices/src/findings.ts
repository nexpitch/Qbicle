import { createHash } from 'node:crypto';
import { exposureFactor, inventoryFindings, type InventoryAsset, type InventoryFinding } from '@qbicle/inventory';
import type { Asset as ScoreAsset, Finding, LinkedVuln } from '@qbicle/score';
import { componentsFor, type Component } from './vulns/cpe.ts';
import type { ComponentVuln, VulnDb } from './vulns/db.ts';

/** Zelfde vorm als de vingerafdruk van de scanner: zelfde fout op hetzelfde asset = zelfde waarde. */
export function fingerprint(assetType: string, assetValue: string, key: string, discriminator = ''): string {
  return createHash('sha256').update([assetType, assetValue.toLowerCase(), key, discriminator].join('\u0000')).digest('hex').slice(0, 32);
}

const EDGE = new Set(['router', 'firewall']);

const CATEGORY_LABEL: Record<string, string> = {
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
  const what = CATEGORY_LABEL[asset.category] ?? 'apparaat';
  const model = [asset.attributes.vendor?.value, asset.attributes.model?.value].filter(Boolean).join(' ');
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
 * - de bevindingen uit de inventaris zelf (onbeheerd, updates achter, MFA).
 */
export function deviceFindings(assets: InventoryAsset[], vulnDb: VulnDb, now: Date): DeviceFindingResult {
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
