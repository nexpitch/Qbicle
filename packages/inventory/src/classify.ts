import type { Attributes, Category } from './types.ts';

/**
 * Leidt een categorie af uit wat een apparaat aankondigt of wat we weten.
 * Uitkomst is altijd "mogelijk": een afleiding, geen melding van een bron.
 */
const SERVICE_HINTS: Array<[RegExp, Category]> = [
  [/^_(ipp|ipps|printer|pdl-datastream)\._tcp$/, 'printer'],
  [/^_(rtsp|onvif)\._(tcp|udp)$/, 'camera'],
  [/^_(airplay|googlecast|raop|spotify-connect)\._tcp$/, 'tv-media'],
  [/^_(smb|afpovertcp|nfs)\._tcp$/, 'nas'],
  [/^_(hap|homekit|matter|matterc)\._(tcp|udp)$/, 'iot'],
];

const OS_HINTS: Array<[RegExp, Category]> = [
  [/^(ios|iphone)/i, 'telefoon'],
  [/^android/i, 'telefoon'],
  [/^ipados/i, 'tablet'],
  [/^windows server/i, 'server'],
  [/^(windows|macos|mac os)/i, 'laptop'],
];

export function inferCategory(attrs: Attributes): Category | undefined {
  for (const service of attrs.services ?? []) {
    for (const [re, cat] of SERVICE_HINTS) if (re.test(service)) return cat;
  }
  if (attrs.os) {
    for (const [re, cat] of OS_HINTS) if (re.test(attrs.os)) return cat;
  }
  return undefined;
}
