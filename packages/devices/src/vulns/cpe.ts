import type { InventoryAsset } from '@qbicle/inventory';
import { fritzOsVersion } from '../connectors/fritzbox.ts';

/**
 * Component (OS of firmware) op een asset, met CPE-kandidaat voor de koppeling
 * aan CVE's. Velden volgen tabel `component` (migratie 0003).
 */
export interface Component {
  assetKey: string;
  kind: 'os' | 'firmware' | 'software';
  vendor: string;
  product: string;
  /** Genormaliseerde versie, als bekend. */
  version?: string;
  /** Ruwe versie zoals de bron die meldde. */
  rawVersion?: string;
  /** CPE 2.3, met versie "*" als die onbekend is. */
  cpe: string;
  /**
   * vastgesteld: product uit de vertaaltabel en exacte versie bekend.
   * mogelijk: product geraden of versie onbekend.
   */
  cpeCertainty: 'vastgesteld' | 'mogelijk';
  sourceId: string;
}

export interface CpeParts {
  part: string;
  vendor: string;
  product: string;
  version: string;
}

/** Splitst een CPE 2.3-string op ":" (behalve "\:"). */
export function parseCpe(cpe: string): CpeParts | undefined {
  const f = cpe.split(/(?<!\\):/);
  if (f[0] !== 'cpe' || f[1] !== '2.3' || f.length < 6) return undefined;
  return { part: f[2]!, vendor: f[3]!, product: f[4]!, version: f[5]! };
}

export function buildCpe(part: 'o' | 'a' | 'h', vendor: string, product: string, version = '*'): string {
  const esc = (s: string) => s.replace(/([^A-Za-z0-9_.\-*\\])/g, '\\$1');
  return ['cpe', '2.3', part, esc(vendor), esc(product), version === '*' ? '*' : esc(version), '*', '*', '*', '*', '*', '*', '*'].join(':');
}

interface CpeRule {
  /** Past op fabrikant + firmwareproduct/OS van het asset. */
  vendor: RegExp;
  os?: RegExp;
  model?: RegExp;
  cpeVendor: string;
  cpeProduct: string | ((model: string) => string);
  normalize?: (raw: string) => string | undefined;
  /** Komt de productnaam uit een vaste vertaling (vastgesteld) of uit een afgeleide naam (mogelijk)? */
  curated: boolean;
}

/**
 * Eigen vertaaltabel van wat routers rapporteren naar CPE-namen zoals NVD ze gebruikt
 * (ontwerp: "CPE-woordenboek van NVD plus een eigen vertaaltabel").
 * Uitbreiden per ondersteund merk; controleer de naam altijd in het NVD-woordenboek.
 */
export const CPE_RULES: CpeRule[] = [
  {
    vendor: /mikrotik|routerboard/i,
    os: /routeros/i,
    cpeVendor: 'mikrotik',
    cpeProduct: 'routeros',
    normalize: (v) => v.match(/^\d+(\.\d+){1,2}/)?.[0],
    curated: true,
  },
  {
    vendor: /^avm/i,
    os: /fritz!?os/i,
    cpeVendor: 'avm',
    cpeProduct: 'fritz!os',
    normalize: (v) => fritzOsVersion(v) ?? v.match(/^\d+\.\d{2}$/)?.[0],
    curated: true,
  },
  {
    // UniFi: NVD gebruikt per producttype eigen namen; afgeleid uit het model, dus "mogelijk".
    vendor: /ubiquiti/i,
    cpeVendor: 'ui',
    cpeProduct: (model) => `${model.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_firmware`,
    normalize: (v) => v.match(/^\d+(\.\d+){1,3}/)?.[0],
    curated: false,
  },
];

/** Componenten (firmware/OS) van een asset, met CPE-kandidaat. */
export function componentsFor(asset: InventoryAsset): Component[] {
  const vendor = asset.attributes.vendor?.value;
  if (!vendor) return [];
  const os = asset.attributes.os?.value ?? '';
  const model = asset.attributes.model?.value ?? '';
  const fw = asset.attributes.firmware ?? asset.attributes.osVersion;
  const out: Component[] = [];
  for (const rule of CPE_RULES) {
    if (!rule.vendor.test(vendor)) continue;
    if (rule.os && !rule.os.test(os)) continue;
    if (typeof rule.cpeProduct === 'function' && !model) continue;
    const product = typeof rule.cpeProduct === 'string' ? rule.cpeProduct : rule.cpeProduct(model);
    const version = fw ? rule.normalize?.(fw.value) ?? fw.value : undefined;
    out.push({
      assetKey: asset.key,
      kind: 'firmware',
      vendor,
      product: rule.os ? os : `${model} firmware`,
      version,
      rawVersion: fw?.value,
      cpe: buildCpe('o', rule.cpeVendor, product, version ?? '*'),
      cpeCertainty: rule.curated && version ? 'vastgesteld' : 'mogelijk',
      sourceId: fw?.sourceId ?? asset.attributes.vendor!.sourceId,
    });
    break;
  }
  return out;
}
