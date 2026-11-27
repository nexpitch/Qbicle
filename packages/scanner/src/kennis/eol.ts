import { existsSync, readFileSync } from 'node:fs';
import { compareVersions } from '@qbicle/devices';

/**
 * Einde-ondersteuning en laatste versies per product, uit endoflife.date.
 *
 * De scanner haalt tijdens een scan nooit iets op: hij leest een snapshot
 * (eol-snapshot.json naast dit bestand, of QBICLE_EOL_FILE). `npm run kennis:bijwerken`
 * ververst die snapshot uit de openbare bronbestanden van endoflife.date.
 * Elke reeks heeft een bron (https://endoflife.date/<product>).
 */

export interface EolCycle {
  /** Versiereeks zoals endoflife.date hem noemt: "8.3", "2.4", "3", "1.1.1". */
  cycle: string;
  /** Laatste dag met beveiligingsupdates (ISO), true = voorbij zonder datum, false = nog ondersteund. */
  eol: string | boolean;
  /** Nieuwste versie in deze reeks. */
  latest?: string;
  latestDate?: string;
  releaseDate?: string;
}

export interface EolSnapshot {
  /** Datum waarop de snapshot is gemaakt (ISO). */
  stand: string;
  bron: string;
  producten: Record<string, EolCycle[]>;
}

/** Producten die we bijhouden (slug op endoflife.date). */
export const EOL_PRODUCTS = [
  // Server en taal (hostingpartij)
  'php',
  'apache-http-server',
  'nginx',
  'openssl',
  'tomcat',
  'windows-server',
  'centos',
  'ubuntu',
  'debian',
  'rhel',
  // CMS en webwinkel (webbouwer)
  'wordpress',
  'drupal',
  'joomla',
  'typo3',
  'magento',
  'shopware',
  // Bibliotheken in de browser (webbouwer)
  'jquery',
  'jquery-ui',
  'bootstrap',
  'angularjs',
  'vue',
] as const;

const SNAPSHOT_URL = new URL('./eol-snapshot.json', import.meta.url);

let cached: EolSnapshot | null | undefined;

/** De snapshot, of null als die er niet is (dan valt de scanner terug op de handmatige startset). */
export function eolSnapshot(): EolSnapshot | null {
  if (cached !== undefined) return cached;
  const file = process.env.QBICLE_EOL_FILE;
  try {
    const path = file && existsSync(file) ? file : SNAPSHOT_URL;
    cached = JSON.parse(readFileSync(path, 'utf8')) as EolSnapshot;
  } catch {
    cached = null;
  }
  return cached;
}

/** Alleen voor tests. */
export function setEolSnapshot(s: EolSnapshot | null | undefined): void {
  cached = s;
}

export function eolSource(slug: string) {
  return { name: 'endoflife.date', url: `https://endoflife.date/${slug}` };
}

/**
 * Leest het `releases:`-blok uit de YAML-kop van een productbestand van endoflife.date.
 * Bewust een kleine lezer voor alleen dit blok (lijst van platte sleutel-waardeparen),
 * zodat de scanner geen YAML-bibliotheek nodig heeft.
 */
export function parseEndoflifeMarkdown(md: string): EolCycle[] {
  const head = md.split(/^---\s*$/m)[1] ?? '';
  const lines = head.split('\n');
  const start = lines.findIndex((l) => /^releases:\s*$/.test(l));
  if (start < 0) return [];
  const items: Record<string, string>[] = [];
  for (const raw of lines.slice(start + 1)) {
    if (/^\S/.test(raw)) break; // volgende sleutel op het hoogste niveau
    const line = raw.replace(/\s+#.*$/, '');
    const m = line.match(/^\s*(-\s+)?([A-Za-z][\w]*):\s*(.*)$/);
    if (!m) continue;
    if (m[1]) items.push({});
    const cur = items[items.length - 1];
    if (!cur) continue;
    cur[m[2]!] = m[3]!.trim().replace(/^["'](.*)["']$/, '$1');
  }
  const bool = (v: string | undefined): string | boolean | undefined =>
    v === undefined ? undefined : v === 'true' ? true : v === 'false' ? false : v;
  return items
    .filter((i) => i.releaseCycle)
    .map((i) => {
      const eol = bool(i.eol);
      return {
        cycle: i.releaseCycle!,
        eol: eol === undefined ? false : eol,
        ...(i.latest ? { latest: i.latest } : {}),
        ...(i.latestReleaseDate ? { latestDate: i.latestReleaseDate } : {}),
        ...(i.releaseDate ? { releaseDate: i.releaseDate } : {}),
      };
    });
}

const parts = (v: string) => v.split('.');

/**
 * De reeks waar een versie bij hoort: de langste reeks waarmee de versie begint
 * ("8.3.4" -> "8.3", "1.1.1w" -> "1.1.1", "3.7.1" -> "3").
 * Kennen we alleen de hoofdversie ("3" bij Joomla 3 of Drupal 7), dan
 * geven we alle reeksen die daarmee beginnen.
 */
export function cyclesFor(cycles: EolCycle[], version: string): EolCycle[] {
  const v = version.replace(/[a-z]+$/i, '');
  const vp = parts(v);
  let best: EolCycle | undefined;
  for (const c of cycles) {
    const cp = parts(c.cycle);
    if (!/^\d+(\.\d+)*$/.test(c.cycle) || cp.length > vp.length) continue;
    if (cp.every((x, i) => Number(x) === Number(vp[i]))) {
      if (!best || cp.length > parts(best.cycle).length) best = c;
    }
  }
  // OpenSSL 1.1.1w: de letters horen bij de patch, de reeks is 1.1.1.
  if (best) return [best];
  return cycles.filter((c) => {
    const cp = parts(c.cycle);
    return cp.length > vp.length && vp.every((x, i) => Number(x) === Number(cp[i]));
  });
}

/** Nieuwste versie over alle reeksen. */
export function newestOverall(cycles: EolCycle[]): string | undefined {
  let best: string | undefined;
  for (const c of cycles) {
    if (c.latest && /^\d/.test(c.latest) && (!best || compareVersions(c.latest, best) > 0)) best = c.latest;
  }
  return best;
}
