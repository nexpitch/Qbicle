import { createHash } from 'node:crypto';

/**
 * Vingerafdruk van een bevinding: dezelfde fout op hetzelfde asset geeft in
 * elke scan dezelfde waarde. Zo zie je wat nieuw is, wat openstaat en wat is opgelost.
 * `discriminator` is optioneel, voor bevindingen die per onderdeel uniek zijn
 * (bijvoorbeeld per cookienaam).
 */
export function fingerprint(assetType: string, assetValue: string, key: string, discriminator = ''): string {
  return createHash('sha256')
    .update([assetType, assetValue.toLowerCase(), key, discriminator].join('\u0000'))
    .digest('hex')
    .slice(0, 32);
}
