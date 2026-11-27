import { EU_VAT_FORMATS } from '@qbicle/platform';

/** Landen voor het factuuradres: Nederland eerst, dan de EU, dan een paar buiten de EU. */
export const LANDEN: [string, string][] = [
  ['NL', 'Nederland'],
  ...Object.entries(EU_VAT_FORMATS)
    .filter(([code]) => code !== 'NL')
    .map(([code, f]): [string, string] => [code, f.naam])
    .sort((a, b) => a[1].localeCompare(b[1], 'nl')),
  ['GB', 'Verenigd Koninkrijk (buiten de EU)'],
  ['CH', 'Zwitserland (buiten de EU)'],
  ['NO', 'Noorwegen (buiten de EU)'],
  ['US', 'Verenigde Staten (buiten de EU)'],
];
