import { readFileSync } from 'node:fs';
import { normalizeDomain } from './domain.ts';

/**
 * Leest de opt-outlijst: één domein per regel, # voor commentaar.
 * Wie niet gescand wil worden, staat hierin. Later komt deze lijst in de database.
 */
export function loadOptOut(path: string | undefined): Set<string> {
  const set = new Set<string>();
  if (!path) return set;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const s = line.replace(/#.*/, '').trim();
    if (!s) continue;
    try {
      set.add(normalizeDomain(s));
    } catch {
      // Ongeldige regel overslaan.
    }
  }
  return set;
}
