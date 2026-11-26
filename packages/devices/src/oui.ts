import { readFileSync } from 'node:fs';
import { isRandomizedMac, normalizeMac } from '@qbicle/inventory';

/**
 * Fabrikant opzoeken op MAC-prefix (OUI), offline.
 *
 * Bron: het openbare register van de IEEE (MA-L, MA-M en MA-S, CSV-formaat
 * "Registry,Assignment,Organization Name,Organization Address"). Haal het op met
 * scripts/oui-update.sh en wijs het aan met QBICLE_OUI_FILE. We zoeken nooit
 * online op: zo lekken MAC-adressen van klanten niet naar een derde.
 */
export class OuiDb {
  /** Prefix in hex (6, 7 of 9 tekens) naar organisatienaam. */
  private readonly map = new Map<string, string>();

  static fromCsv(csv: string): OuiDb {
    const db = new OuiDb();
    for (const line of csv.split(/\r?\n/).slice(1)) {
      const cols = parseCsvLine(line);
      const [registry, assignment, org] = cols;
      if (!registry || !assignment || !org || !/^[0-9A-F]+$/i.test(assignment)) continue;
      db.map.set(assignment.toLowerCase(), org.trim());
    }
    return db;
  }

  static fromFile(path: string): OuiDb {
    return OuiDb.fromCsv(readFileSync(path, 'utf8'));
  }

  /** Leeg, als er geen register is: dan valt de MAC-prefix als signaal weg. */
  static empty(): OuiDb {
    return new OuiDb();
  }

  get size(): number {
    return this.map.size;
  }

  /** Fabrikant bij een MAC-adres; undefined bij een willekeurig (privacy-)adres of onbekende prefix. */
  lookup(rawMac: string): string | undefined {
    const mac = normalizeMac(rawMac);
    if (!mac || isRandomizedMac(mac)) return undefined;
    const hex = mac.replace(/:/g, '');
    // Langste prefix eerst: MA-S (36 bits), MA-M (28 bits), MA-L (24 bits).
    return this.map.get(hex.slice(0, 9)) ?? this.map.get(hex.slice(0, 7)) ?? this.map.get(hex.slice(0, 6));
  }
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}
