/**
 * Fouten die de gebruiker te zien krijgt. De boodschap is Nederlands en bevat
 * nooit gegevens van een andere organisatie.
 */
export type ErrorCode =
  | 'niet_ingelogd'
  | 'geen_toegang'
  | 'niet_gevonden'
  | 'ongeldige_invoer'
  | 'conflict'
  | 'te_veel_verzoeken'
  | 'verlopen'
  | 'niet_geverifieerd';

const STATUS: Record<ErrorCode, number> = {
  niet_ingelogd: 401,
  geen_toegang: 403,
  niet_gevonden: 404,
  ongeldige_invoer: 400,
  conflict: 409,
  te_veel_verzoeken: 429,
  verlopen: 410,
  niet_geverifieerd: 403,
};

export class PlatformError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.status = STATUS[code];
  }
}

/** Zelfde antwoord voor "bestaat niet" en "mag je niet zien", zodat ids niet te raden zijn. */
export function notFound(what = 'Dit onderdeel'): PlatformError {
  return new PlatformError('niet_gevonden', `${what} bestaat niet of je hebt er geen toegang toe.`);
}
