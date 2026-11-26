import type { InventoryAsset } from '@qbicle/inventory';
import { compareVersions } from './vulns/version.ts';

/**
 * End-of-life: krijgt een apparaat of zijn firmware nog updates?
 *
 * Belangrijk voor MKB, want veel oudere routers (bijvoorbeeld oude DrayTek- en
 * Cisco RV-modellen) krijgen geen beveiligingsupdates meer. Dan is er soms nog
 * geen CVE, maar het apparaat kan nooit meer worden bijgewerkt.
 *
 * Twee soorten gegevens:
 * - hardware: per fabrikant en model de datum waarop de fabrikant stopt met updates
 *   (uit de end-of-life-aankondigingen van de fabrikant; eigen, gecontroleerde lijst);
 * - firmwarecycli: per firmwareproduct de cycli in het formaat van endoflife.date
 *   ([{ cycle, eol, latest }]).
 */
export interface HardwareEol {
  vendor: string;
  /** Reguliere expressie op het model, hoofdletterongevoelig. */
  model: string;
  /** Laatste dag met beveiligingsupdates (ISO-datum). */
  endOfSupport: string;
  /** Waar het vandaan komt (URL van de aankondiging). */
  source: string;
}

export interface EolCycle {
  cycle: string;
  /** Datum, of true (al end-of-life) / false (nog ondersteund). */
  eol: string | boolean;
  latest?: string;
}

export type EolStatus = 'buiten-ondersteuning' | 'binnenkort' | 'ondersteund' | 'onbekend';

export interface EolResult {
  status: EolStatus;
  what: 'hardware' | 'firmware';
  date?: string;
  source?: string;
  /** vastgesteld: model of versie van de bron zelf; mogelijk: alleen een patroon. */
  certainty: 'vastgesteld' | 'mogelijk';
}

/** Binnen zoveel dagen voor de einddatum melden we "binnenkort". */
export const SOON_DAYS = 180;

export class EolDb {
  private readonly hardware: Array<HardwareEol & { re: RegExp }> = [];
  private readonly cycles = new Map<string, EolCycle[]>();

  addHardware(entries: HardwareEol[]): number {
    for (const e of entries) this.hardware.push({ ...e, re: new RegExp(e.model, 'i') });
    return entries.length;
  }

  /** firmwareProduct zoals de connector het meldt, bijvoorbeeld "RouterOS". */
  addCycles(firmwareProduct: string, cycles: EolCycle[]): void {
    this.cycles.set(firmwareProduct.toLowerCase(), cycles);
  }

  check(asset: InventoryAsset, now: Date): EolResult[] {
    const out: EolResult[] = [];
    const vendor = asset.attributes.vendor?.value?.toLowerCase() ?? '';
    const model = asset.attributes.model?.value;
    if (vendor && model) {
      const hit = this.hardware.find((h) => vendor.includes(h.vendor.toLowerCase()) && h.re.test(model));
      if (hit) {
        out.push({
          status: statusFor(hit.endOfSupport, now),
          what: 'hardware',
          date: hit.endOfSupport,
          source: hit.source,
          certainty: asset.attributes.model!.certainty === 'vastgesteld' ? 'vastgesteld' : 'mogelijk',
        });
      }
    }
    const os = asset.attributes.os?.value?.toLowerCase();
    const fw = asset.attributes.firmware?.value;
    const cycles = os ? this.cycles.get(os) : undefined;
    if (cycles && fw) {
      // Langste cyclus die als prefix past: "6.49.10" valt in cyclus "6.49" of "6".
      const cycle = cycles
        .filter((c) => fw === c.cycle || fw.startsWith(c.cycle + '.'))
        .sort((a, b) => compareVersions(b.cycle, a.cycle) || b.cycle.length - a.cycle.length)[0];
      if (cycle) {
        const status: EolStatus = cycle.eol === true ? 'buiten-ondersteuning' : cycle.eol === false ? 'ondersteund' : statusFor(cycle.eol, now);
        out.push({ status, what: 'firmware', date: typeof cycle.eol === 'string' ? cycle.eol : undefined, certainty: 'vastgesteld' });
      }
    }
    return out;
  }
}

function statusFor(date: string, now: Date): EolStatus {
  const t = Date.parse(date);
  if (!Number.isFinite(t)) return 'onbekend';
  if (t < now.getTime()) return 'buiten-ondersteuning';
  if (t - now.getTime() < SOON_DAYS * 86400_000) return 'binnenkort';
  return 'ondersteund';
}
