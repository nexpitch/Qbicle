import type { Asset as ScanAsset } from '@qbicle/score';
import type { AssetKind, Identifier, InventoryAsset, Observation, Source } from './types.ts';

/** De bestaande buitenkant-scanner als bron in de inventaris. */
export const SCANNER_SOURCE: Source = { id: 'scanner', kind: 'scanner', product: 'qbicle-scanner', level: '1' };

const KIND_BY_SCAN_TYPE: Record<ScanAsset['type'], AssetKind> = {
  domein: 'domein',
  subdomein: 'subdomein',
  host: 'ip-adres',
  mailserver: 'mailserver',
  website: 'website',
  certificaat: 'certificaat',
  dienst: 'dienst',
  apparaat: 'apparaat',
  netwerkapparaat: 'netwerkapparaat',
};

function scanIdentifier(asset: ScanAsset): Identifier {
  switch (asset.type) {
    case 'website':
    case 'dienst':
      return { type: 'url', value: asset.value };
    case 'certificaat':
      return { type: 'cert', value: asset.value };
    case 'host':
      return /^[\d.:a-f]+$/i.test(asset.value) ? { type: 'ip', value: asset.value } : { type: 'fqdn', value: asset.value };
    default:
      return { type: 'fqdn', value: asset.value };
  }
}

/** Scanner naar inventaris: elk gescand asset wordt een waarneming. */
export function fromScanAsset(asset: ScanAsset, observedAt: string): Observation {
  return {
    source: SCANNER_SOURCE,
    observedAt,
    identifiers: [scanIdentifier(asset)],
    attributes: { kind: KIND_BY_SCAN_TYPE[asset.type], exposure: 'internet', name: asset.value },
  };
}

/**
 * Inventaris naar scanner: internetgerichte assets die de scanner nog niet kent,
 * als doel voor de niveau-0-checks (gegevens van derden). Actief scannen (2A)
 * is een aparte stap met een getekende scanopdracht en zit hier bewust niet in.
 */
export function toScanTargets(assets: InventoryAsset[]): ScanAsset[] {
  const targets: ScanAsset[] = [];
  for (const a of assets) {
    if (a.status !== 'actief' || a.exposure !== 'internet') continue;
    if (a.sourceIds.includes(SCANNER_SOURCE.id)) continue;
    const id = a.identifiers.find((i) => i.type === 'ip') ?? a.identifiers.find((i) => i.type === 'fqdn');
    if (!id) continue;
    targets.push({ type: 'host', value: id.value, source: `inventaris:${a.sourceIds.join('+')}`, visibility: 'primair' });
  }
  return targets;
}
