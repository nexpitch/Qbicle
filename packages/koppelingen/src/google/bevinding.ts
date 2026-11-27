import type { VoorbeeldBevinding } from '../catalogus.ts';
import type { Dekking } from './client.ts';

/** Bevinding uit een echte (of test-)ronde. Zelfde vorm als in de teststand, plus code en bewijs. */
export interface GoogleBevinding extends VoorbeeldBevinding {
  /** Vaste code, bijv. gw.2sv.beheerders; gebruikt voor hercontrole en het scoremodel. */
  code: string;
  onderdeel: string;
  /** Wat we zagen, kort (accountnamen, bucketnamen, regels). Maximaal 10 regels. */
  bewijs: string[];
}

/** Asset die we via de koppeling vonden, voor "Alles in beeld" en de domeinscan. */
export interface GoogleAsset {
  soort: 'domein' | 'ip' | 'url' | 'bucket' | 'database' | 'server';
  waarde: string;
  bron: string;
  openbaar: boolean;
}

export interface GoogleUitkomst {
  bevindingen: GoogleBevinding[];
  dekking: Dekking[];
  assets: GoogleAsset[];
  /** Rechten die verder gaan dan nodig (let_op in de koppeling). */
  teVeelRechten: string[];
}

export const max10 = (xs: string[]) => (xs.length > 10 ? [...xs.slice(0, 10), `… en nog ${xs.length - 10}`] : xs);

const VOLGORDE = { crit: 0, warn: 1, ok: 2 } as const;
export const sorteer = (b: GoogleBevinding[]) => [...b].sort((x, y) => VOLGORDE[x.urgentie] - VOLGORDE[y.urgentie]);
