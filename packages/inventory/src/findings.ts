import type { Certainty } from '@qbicle/score';
import type { Exposure, InventoryAsset, Managed } from './types.ts';

/**
 * Voorstel voor factor z in het scoremodel voor inventaris-assets.
 * Voorlopig: te kalibreren in de pilot, daarna naar packages/score met een nieuwe modelversie.
 */
export const EXPOSURE_FACTOR_VOORSTEL = {
  internet: 1.0,
  cloud: 0.8,
  'intern-onbeheerd': 0.6,
  'intern-beheerd': 0.4,
  onbekend: 0.5,
} as const;

export function exposureFactor(exposure: Exposure, managed: Managed): number {
  if (exposure === 'intern') {
    return managed === 'ja' ? EXPOSURE_FACTOR_VOORSTEL['intern-beheerd'] : EXPOSURE_FACTOR_VOORSTEL['intern-onbeheerd'];
  }
  return EXPOSURE_FACTOR_VOORSTEL[exposure];
}

export interface InventoryFinding {
  key: string;
  assetKey: string;
  certainty: Certainty;
  /** Gewone taal, voor de klant. */
  title: string;
  /** Wat we zagen en waar het vandaan komt. */
  detail: string;
}

export interface FindingOptions {
  now: Date;
  /** Na zoveel dagen zonder patch melden we het. Standaard 60. */
  patchMaxDays?: number;
}

/**
 * Eerste bevindingen die uit de inventaris zelf volgen, zonder te scannen.
 * Verdwenen assets tellen niet mee.
 */
export function inventoryFindings(assets: InventoryAsset[], opts: FindingOptions): InventoryFinding[] {
  const maxDays = opts.patchMaxDays ?? 60;
  const out: InventoryFinding[] = [];
  for (const a of assets) {
    if (a.status !== 'actief') continue;
    const name = a.attributes.name?.value ?? a.key;

    if (a.managed === 'nee') {
      out.push({
        key: 'apparaat.onbeheerd',
        assetKey: a.key,
        certainty: 'vastgesteld',
        title: `Er hangt een ${a.category} aan je netwerk die niet in je beheertool staat`,
        detail: `${name} is gezien door ${a.sourceIds.join(', ')}, maar niet door Intune of je RMM. Niemand houdt de updates in de gaten.`,
      });
    }

    const admin = a.attributes.admin?.value;
    const mfa = a.attributes.mfa;
    if (a.kind === 'account' && admin === true && mfa && mfa.value === false) {
      out.push({
        key: 'account.admin_zonder_mfa',
        assetKey: a.key,
        certainty: mfa.certainty,
        title: 'Een beheerdersaccount heeft geen tweestapsverificatie',
        detail: `${name} is beheerder, maar heeft geen MFA (volgens ${mfa.sourceId}). Met alleen een gestolen wachtwoord kan iemand alles overnemen.`,
      });
    }

    const patched = a.attributes.lastPatched;
    if (patched) {
      const days = Math.floor((opts.now.getTime() - Date.parse(patched.value)) / 86400_000);
      if (days > maxDays) {
        out.push({
          key: 'apparaat.updates_achter',
          assetKey: a.key,
          certainty: patched.certainty,
          title: `${name} heeft al ${days} dagen geen updates gehad`,
          detail: `Laatste update ${patched.value.slice(0, 10)} volgens ${patched.sourceId}.`,
        });
      }
    }
  }
  return out;
}
