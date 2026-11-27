import { audit, type Actor } from './audit.ts';
import type { Platform } from './context.ts';
import { one, type Queryable } from './db.ts';
import { PlatformError } from './errors.ts';

/**
 * Btw verleggen naar zakelijke klanten in een ander EU-land (Erik, 27-11-2026).
 *
 * Regel: factuuradres in een EU-land buiten Nederland + een btw-nummer dat de
 * VIES-dienst van de EU als geldig bevestigt = 0% btw, "btw verlegd". In alle
 * andere gevallen (Nederland, buiten de EU, geen nummer, ongeldig nummer,
 * VIES-storing) rekenen we het gewone Nederlandse tarief. Nooit stilzwijgend 0%.
 *
 * Elke controle wordt bewaard in vat_check (resultaat, tijdstip, VIES-
 * consultatienummer) als bewijs voor de Belastingdienst. Een controle telt
 * `vatCheckMaxDays` dagen; bij elke verlenging en bij een nieuwe betaling met
 * een oudere controle vragen we VIES opnieuw.
 *
 * Buiten deze regeling: diensten aan particulieren in andere EU-landen (OSS).
 * Qbicle verkoopt alleen zakelijk; zonder geldig btw-nummer rekenen we 21%.
 */

export type VatCode = 'nl_standaard' | 'eu_verlegd';
export type VatCheckStatus = 'geldig' | 'ongeldig' | 'storing';
export type VatCheckSource = 'klant' | 'registratie' | 'betaling' | 'verlenging' | 'cockpit';

/** EU-lidstaten (ISO-landcode) met het voorvoegsel van hun btw-nummer en het formaat erna. */
export const EU_VAT_FORMATS: Record<string, { prefix: string; pattern: RegExp; voorbeeld: string; naam: string }> = {
  AT: { prefix: 'AT', pattern: /^U\d{8}$/, voorbeeld: 'ATU12345678', naam: 'Oostenrijk' },
  BE: { prefix: 'BE', pattern: /^[01]\d{9}$/, voorbeeld: 'BE0123456789', naam: 'België' },
  BG: { prefix: 'BG', pattern: /^\d{9,10}$/, voorbeeld: 'BG123456789', naam: 'Bulgarije' },
  CY: { prefix: 'CY', pattern: /^\d{8}[A-Z]$/, voorbeeld: 'CY12345678X', naam: 'Cyprus' },
  CZ: { prefix: 'CZ', pattern: /^\d{8,10}$/, voorbeeld: 'CZ12345678', naam: 'Tsjechië' },
  DE: { prefix: 'DE', pattern: /^\d{9}$/, voorbeeld: 'DE123456789', naam: 'Duitsland' },
  DK: { prefix: 'DK', pattern: /^\d{8}$/, voorbeeld: 'DK12345678', naam: 'Denemarken' },
  EE: { prefix: 'EE', pattern: /^\d{9}$/, voorbeeld: 'EE123456789', naam: 'Estland' },
  ES: { prefix: 'ES', pattern: /^[A-Z0-9]\d{7}[A-Z0-9]$/, voorbeeld: 'ESX1234567X', naam: 'Spanje' },
  FI: { prefix: 'FI', pattern: /^\d{8}$/, voorbeeld: 'FI12345678', naam: 'Finland' },
  FR: { prefix: 'FR', pattern: /^[0-9A-HJ-NP-Z]{2}\d{9}$/, voorbeeld: 'FR12345678901', naam: 'Frankrijk' },
  GR: { prefix: 'EL', pattern: /^\d{9}$/, voorbeeld: 'EL123456789', naam: 'Griekenland' },
  HR: { prefix: 'HR', pattern: /^\d{11}$/, voorbeeld: 'HR12345678901', naam: 'Kroatië' },
  HU: { prefix: 'HU', pattern: /^\d{8}$/, voorbeeld: 'HU12345678', naam: 'Hongarije' },
  IE: { prefix: 'IE', pattern: /^\d[0-9A-Z+*]\d{5}[A-W][A-I]?$/, voorbeeld: 'IE1234567WA', naam: 'Ierland' },
  IT: { prefix: 'IT', pattern: /^\d{11}$/, voorbeeld: 'IT12345678901', naam: 'Italië' },
  LT: { prefix: 'LT', pattern: /^(\d{9}|\d{12})$/, voorbeeld: 'LT123456789', naam: 'Litouwen' },
  LU: { prefix: 'LU', pattern: /^\d{8}$/, voorbeeld: 'LU12345678', naam: 'Luxemburg' },
  LV: { prefix: 'LV', pattern: /^\d{11}$/, voorbeeld: 'LV12345678901', naam: 'Letland' },
  MT: { prefix: 'MT', pattern: /^\d{8}$/, voorbeeld: 'MT12345678', naam: 'Malta' },
  NL: { prefix: 'NL', pattern: /^\d{9}B\d{2}$/, voorbeeld: 'NL123456789B01', naam: 'Nederland' },
  PL: { prefix: 'PL', pattern: /^\d{10}$/, voorbeeld: 'PL1234567890', naam: 'Polen' },
  PT: { prefix: 'PT', pattern: /^\d{9}$/, voorbeeld: 'PT123456789', naam: 'Portugal' },
  RO: { prefix: 'RO', pattern: /^[1-9]\d{1,9}$/, voorbeeld: 'RO1234567890', naam: 'Roemenië' },
  SE: { prefix: 'SE', pattern: /^\d{10}01$/, voorbeeld: 'SE123456789001', naam: 'Zweden' },
  SI: { prefix: 'SI', pattern: /^\d{8}$/, voorbeeld: 'SI12345678', naam: 'Slovenië' },
  SK: { prefix: 'SK', pattern: /^\d{10}$/, voorbeeld: 'SK1234567890', naam: 'Slowakije' },
};

/** Land waarvoor btw verleggen kan: EU, maar niet Nederland (daar zit Qbicle zelf). */
export function isReverseChargeCountry(country: string): boolean {
  return country !== 'NL' && country in EU_VAT_FORMATS;
}

/** Spaties, punten en streepjes eruit, hoofdletters. */
export function normalizeVatNumber(raw: string): string {
  return raw.replace(/[\s.\-]/g, '').toUpperCase();
}

/**
 * Formaatcontrole per land. Voor EU-landen moet het voorvoegsel bij het land
 * van het factuuradres horen; buiten de EU alleen een ruwe controle.
 * Gooit een PlatformError met een voorbeeld als het niet klopt.
 */
export function validateVatFormat(country: string, vat: string): void {
  const f = EU_VAT_FORMATS[country];
  if (!f) {
    if (!/^[A-Z0-9]{4,20}$/.test(vat)) throw new PlatformError('ongeldige_invoer', 'Dit btw-nummer klopt niet. Gebruik alleen letters en cijfers.');
    return;
  }
  if (!vat.startsWith(f.prefix)) {
    throw new PlatformError('ongeldige_invoer', `Een btw-nummer uit ${f.naam} begint met ${f.prefix}, bijvoorbeeld ${f.voorbeeld}. Klopt het land van je factuuradres?`);
  }
  if (!f.pattern.test(vat.slice(f.prefix.length))) {
    throw new PlatformError('ongeldige_invoer', `Dit btw-nummer heeft niet het formaat van ${f.naam}. Voorbeeld: ${f.voorbeeld}.`);
  }
}

// VIES ------------------------------------------------------------------------------

export interface ViesRequest {
  /** Voorvoegsel zoals VIES het wil (EL voor Griekenland). */
  countryCode: string;
  /** Nummer zonder voorvoegsel. */
  vatNumber: string;
  /** Btw-nummer van Qbicle zelf; alleen dan geeft VIES een consultatienummer. */
  requesterCountryCode?: string;
  requesterNumber?: string;
}

export interface ViesResult {
  status: VatCheckStatus;
  /** Consultatienummer van VIES: het bewijs dat we gecontroleerd hebben. */
  requestIdentifier: string | null;
  requestDate: string | null;
  name: string | null;
  address: string | null;
  /** Bij storing: wat VIES of het netwerk meldde. */
  error: string | null;
}

export interface ViesClient {
  readonly name: 'vies' | 'test';
  check(input: ViesRequest): Promise<ViesResult>;
}

const VIES_URL = 'https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-number';

/** Lege VIES-velden ("---") als null. */
const clean = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.replace(/\s+/g, ' ').trim();
  return t && t !== '---' ? t.slice(0, 400) : null;
};

/**
 * De echte VIES-dienst (REST). Een storing (land niet bereikbaar, te druk,
 * time-out) geeft status 'storing', nooit 'geldig'.
 */
export class ViesRestClient implements ViesClient {
  readonly name = 'vies' as const;
  constructor(
    private readonly url = VIES_URL,
    private readonly timeoutMs = 10_000,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async check(input: ViesRequest): Promise<ViesResult> {
    const fail = (error: string): ViesResult => ({ status: 'storing', requestIdentifier: null, requestDate: null, name: null, address: null, error: error.slice(0, 200) });
    let res: Response;
    try {
      res = await this.fetchFn(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          countryCode: input.countryCode,
          vatNumber: input.vatNumber,
          ...(input.requesterNumber ? { requesterMemberStateCode: input.requesterCountryCode, requesterNumber: input.requesterNumber } : {}),
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      return fail(`VIES niet bereikbaar: ${(e as Error).name === 'TimeoutError' ? 'time-out' : (e as Error).message}`);
    }
    let body: Record<string, unknown>;
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      return fail(`VIES gaf geen geldig antwoord (HTTP ${res.status})`);
    }
    return parseViesResponse(res.status, body);
  }
}

/** Los, zodat de tests het antwoord van VIES kunnen nabootsen. */
export function parseViesResponse(httpStatus: number, body: Record<string, unknown>): ViesResult {
  const base = { requestIdentifier: clean(body.requestIdentifier), requestDate: clean(body.requestDate), name: clean(body.name), address: clean(body.address) };
  const wrappers = Array.isArray(body.errorWrappers) ? (body.errorWrappers as Array<{ error?: string }>) : [];
  const userError = typeof body.userError === 'string' ? body.userError : null;
  if (httpStatus >= 400 || wrappers.length || body.actionSucceed === false) {
    const code = wrappers.map((w) => w.error).filter(Boolean).join(', ') || userError || `HTTP ${httpStatus}`;
    // INVALID_INPUT betekent: dit nummer kan niet bestaan. Ook dan geen 0%.
    if (code === 'INVALID_INPUT' || code === 'INVALID') return { ...base, status: 'ongeldig', error: code };
    return { ...base, status: 'storing', error: `VIES meldt ${code}` };
  }
  if (body.valid === true) return { ...base, status: 'geldig', error: null };
  if (body.valid === false && (userError === null || userError === 'INVALID' || userError === 'VALID')) return { ...base, status: 'ongeldig', error: null };
  if (body.valid === false && userError) return { ...base, status: 'storing', error: `VIES meldt ${userError}` };
  return { ...base, status: 'storing', error: 'VIES gaf geen uitslag' };
}

/**
 * Test-VIES voor de lokale klantomgeving (QBICLE_VIES=test): geen netwerk.
 * Nummers met 000000 zijn ongeldig, met 999999 is VIES "in storing"; de rest geldig.
 */
export class TestVies implements ViesClient {
  readonly name = 'test' as const;
  calls: ViesRequest[] = [];
  /** Voor tests: vaste uitslag per volledig nummer (bijv. 'BE0123456789'). */
  outcomes = new Map<string, VatCheckStatus>();
  async check(input: ViesRequest): Promise<ViesResult> {
    this.calls.push(input);
    const full = input.countryCode + input.vatNumber;
    const status: VatCheckStatus = this.outcomes.get(full) ?? (full.includes('999999') ? 'storing' : full.includes('000000') ? 'ongeldig' : 'geldig');
    if (status === 'storing') return { status, requestIdentifier: null, requestDate: null, name: null, address: null, error: 'VIES meldt MS_UNAVAILABLE (test)' };
    return {
      status,
      requestIdentifier: input.requesterNumber ? `TEST${String(this.calls.length).padStart(10, '0')}` : null,
      requestDate: new Date().toISOString(),
      name: status === 'geldig' ? 'TESTBEDRIJF' : null,
      address: null,
      error: null,
    };
  }
}

export function viesFromEnv(env: NodeJS.ProcessEnv = process.env): ViesClient {
  if (env.QBICLE_VIES === 'test') return new TestVies();
  return new ViesRestClient(env.QBICLE_VIES_URL || VIES_URL);
}

// Controle vastleggen ---------------------------------------------------------------------

export interface VatCheck {
  id: string;
  vatNumber: string;
  country: string;
  status: VatCheckStatus;
  checkedAt: Date;
  requestIdentifier: string | null;
  requestDate: string | null;
  traderName: string | null;
  error: string | null;
  source: VatCheckSource;
}

interface CheckRow {
  id: string;
  vat_number: string;
  country: string;
  status: VatCheckStatus;
  checked_at: Date;
  request_identifier: string | null;
  request_date: string | null;
  trader_name: string | null;
  error: string | null;
  source: VatCheckSource;
}
const CHECK_COLS = 'id, vat_number, country, status, checked_at, request_identifier, request_date, trader_name, error, source';
const toCheck = (r: CheckRow): VatCheck => ({
  id: r.id,
  vatNumber: r.vat_number,
  country: r.country,
  status: r.status,
  checkedAt: r.checked_at,
  requestIdentifier: r.request_identifier,
  requestDate: r.request_date,
  traderName: r.trader_name,
  error: r.error,
  source: r.source,
});

async function orgVat(q: Queryable, organizationId: string): Promise<{ country: string; vat: string | null } | undefined> {
  const r = await one<{ billing_country: string; vat_number: string | null }>(q, 'SELECT billing_country, vat_number FROM organization WHERE id = $1', [organizationId]);
  return r ? { country: r.billing_country, vat: r.vat_number } : undefined;
}

/** Hoort dit nummer bij een land waarvoor we verleggen, en klopt het formaat? */
function applicable(country: string, vat: string | null): vat is string {
  if (!vat || !isReverseChargeCountry(country)) return false;
  try {
    validateVatFormat(country, vat);
    return true;
  } catch {
    return false;
  }
}

/** Laatste controle met een echte uitslag (geldig of ongeldig) voor dit nummer. */
async function lastDefinitive(q: Queryable, organizationId: string, vat: string): Promise<CheckRow | undefined> {
  return one<CheckRow>(
    q,
    `SELECT ${CHECK_COLS} FROM vat_check WHERE organization_id = $1 AND vat_number = $2 AND status <> 'storing' ORDER BY checked_at DESC LIMIT 1`,
    [organizationId, vat],
  );
}

/**
 * Vraag VIES nu om het btw-nummer van de organisatie te controleren en bewaar
 * de uitslag. Geeft undefined als verleggen niet van toepassing is (NL, buiten
 * de EU of geen nummer). Gooit nooit bij een VIES-storing: die wordt vastgelegd.
 */
export async function checkVatNumber(p: Platform, organizationId: string, source: VatCheckSource, actor: Actor): Promise<VatCheck | undefined> {
  const o = await orgVat(p.pool, organizationId);
  if (!o || !applicable(o.country, o.vat)) return undefined;
  const vat = o.vat;
  const prefix = EU_VAT_FORMATS[o.country]!.prefix;
  const supplier = p.config.supplier.btwNummer ? normalizeVatNumber(p.config.supplier.btwNummer) : null;
  let result: ViesResult;
  if (!p.vies) {
    result = { status: 'storing', requestIdentifier: null, requestDate: null, name: null, address: null, error: 'Geen VIES-koppeling ingesteld' };
  } else {
    try {
      result = await p.vies.check({
        countryCode: prefix,
        vatNumber: vat.slice(prefix.length),
        ...(supplier ? { requesterCountryCode: supplier.slice(0, 2), requesterNumber: supplier.slice(2) } : {}),
      });
    } catch (e) {
      result = { status: 'storing', requestIdentifier: null, requestDate: null, name: null, address: null, error: String((e as Error).message ?? e).slice(0, 200) };
    }
  }

  const before = await vatTreatment(p, p.pool, organizationId);
  const prev = await lastDefinitive(p.pool, organizationId, vat);
  const row = await one<CheckRow>(
    p.pool,
    `INSERT INTO vat_check (organization_id, country, vat_number, status, request_identifier, request_date, requester_vat_number,
                            trader_name, trader_address, error, source, checked_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING ${CHECK_COLS}`,
    [organizationId, o.country, vat, result.status, result.requestIdentifier, result.requestDate, supplier, result.name, result.address, result.error, source, actor.userId ?? null],
  );
  const after = await vatTreatment(p, p.pool, organizationId);
  await audit(p.pool, actor, { organizationId, action: 'btw.gecontroleerd', subject: vat, detail: { uitslag: result.status, bron: source, consultatienummer: result.requestIdentifier } });

  // Melding in de cockpit als btw verleggen stopt (ongeldig geworden, of VIES te lang niet bereikbaar).
  if (before.reverseCharge && !after.reverseCharge) {
    const why = result.status === 'ongeldig' ? `VIES meldt btw-nummer ${vat} als ongeldig` : `VIES was niet bereikbaar en de laatste geldige controle is te oud (${result.error ?? 'storing'})`;
    await alert(p.pool, organizationId, `${why}. Nieuwe facturen weer met ${p.catalog.btwPercentage}% btw.`);
  } else if (!before.reverseCharge && !after.reverseCharge && result.status === 'ongeldig' && prev?.status === 'geldig') {
    await alert(p.pool, organizationId, `VIES meldt btw-nummer ${vat} als ongeldig (was eerder geldig). Facturen met ${p.catalog.btwPercentage}% btw.`);
  } else if (after.reverseCharge) {
    await p.pool.query('UPDATE organization SET vat_alert_at = NULL, vat_alert = NULL WHERE id = $1 AND vat_alert_at IS NOT NULL', [organizationId]);
  }
  return toCheck(row!);
}

async function alert(q: Queryable, organizationId: string, text: string): Promise<void> {
  await q.query('UPDATE organization SET vat_alert_at = now(), vat_alert = $2 WHERE id = $1', [organizationId, text.slice(0, 400)]);
  await q.query(`INSERT INTO org_note (organization_id, body, source) VALUES ($1, $2, 'systeem')`, [organizationId, `Btw verlegd gestopt: ${text}`.slice(0, 2000)]);
}

/**
 * Controleer opnieuw als de laatste uitslag ouder is dan `maxAgeDays` (standaard
 * de geldigheid uit de config). Voor betalingen en verlengingen.
 */
export async function refreshVatCheck(p: Platform, organizationId: string, source: VatCheckSource, actor: Actor, maxAgeDays = p.config.vatCheckMaxDays): Promise<void> {
  const o = await orgVat(p.pool, organizationId);
  if (!o || !applicable(o.country, o.vat)) return;
  const last = await lastDefinitive(p.pool, organizationId, o.vat);
  if (last && last.checked_at.getTime() > Date.now() - maxAgeDays * 86_400_000) return;
  await checkVatNumber(p, organizationId, source, actor);
}

// Btw per betaling ---------------------------------------------------------------------

export interface VatTreatment {
  code: VatCode;
  /** Percentage, bijv. 21 of 0. */
  rate: number;
  reverseCharge: boolean;
  /** De VIES-controle waarop de verlegging rust. */
  checkId: string | null;
  customerVatNumber: string | null;
}

/**
 * Welk btw-tarief geldt nu voor deze organisatie? Alleen lezen uit de database
 * (geen netwerk), zodat het binnen een transactie kan.
 */
export async function vatTreatment(p: Platform, q: Queryable, organizationId: string, now = new Date()): Promise<VatTreatment> {
  const o = await orgVat(q, organizationId);
  const standard: VatTreatment = { code: 'nl_standaard', rate: p.catalog.btwPercentage, reverseCharge: false, checkId: null, customerVatNumber: o?.vat ?? null };
  if (!o || !applicable(o.country, o.vat)) return standard;
  const last = await lastDefinitive(q, organizationId, o.vat);
  if (!last || last.status !== 'geldig') return standard;
  if (last.checked_at.getTime() <= now.getTime() - p.config.vatCheckMaxDays * 86_400_000) return standard;
  return { code: 'eu_verlegd', rate: 0, reverseCharge: true, checkId: last.id, customerVatNumber: o.vat };
}

export function vatAmount(t: Pick<VatTreatment, 'rate'>, exclCents: number): number {
  return Math.round((exclCents * t.rate) / 100);
}

/** Voor de klant en de cockpit: hoe staat het btw-nummer ervoor? */
export interface VatStatus {
  /** Verleggen is mogelijk voor dit land (EU buiten NL). */
  vanToepassing: boolean;
  verlegd: boolean;
  laatsteControle: VatCheck | null;
  /** Korte uitleg in gewone taal. */
  uitleg: string;
  melding: { at: Date; tekst: string } | null;
}

export async function vatStatus(p: Platform, q: Queryable, organizationId: string): Promise<VatStatus> {
  const o = await one<{ billing_country: string; vat_number: string | null; vat_alert_at: Date | null; vat_alert: string | null }>(
    q,
    'SELECT billing_country, vat_number, vat_alert_at, vat_alert FROM organization WHERE id = $1',
    [organizationId],
  );
  const melding = o?.vat_alert_at ? { at: o.vat_alert_at, tekst: o.vat_alert ?? '' } : null;
  const pct = `${p.catalog.btwPercentage}%`;
  if (!o || !isReverseChargeCountry(o.billing_country)) {
    return { vanToepassing: false, verlegd: false, laatsteControle: null, melding, uitleg: o && o.billing_country !== 'NL' ? `Buiten de EU: we rekenen ${pct} btw.` : `We rekenen ${pct} btw.` };
  }
  if (!o.vat_number) {
    return { vanToepassing: true, verlegd: false, laatsteControle: null, melding, uitleg: `Vul je btw-nummer in, dan verleggen we de btw (0%). Zonder geldig nummer rekenen we ${pct} btw.` };
  }
  const last = await one<CheckRow>(q, `SELECT ${CHECK_COLS} FROM vat_check WHERE organization_id = $1 AND vat_number = $2 ORDER BY checked_at DESC LIMIT 1`, [organizationId, o.vat_number]);
  const t = await vatTreatment(p, q, organizationId);
  const uitleg = t.reverseCharge
    ? 'Je btw-nummer is geldig volgens VIES: btw verlegd, je betaalt 0% btw.'
    : !last
      ? `Je btw-nummer is nog niet gecontroleerd. Tot het geldig is, rekenen we ${pct} btw.`
      : last.status === 'ongeldig'
        ? `VIES kent dit btw-nummer niet als geldig. We rekenen ${pct} btw. Klopt het nummer wel? Controleer het en probeer opnieuw.`
        : last.status === 'storing'
          ? `VIES was niet bereikbaar. Tot de controle lukt, rekenen we ${pct} btw. Probeer het later opnieuw.`
          : `De laatste controle is verlopen. Bij de volgende betaling controleren we opnieuw; tot die tijd ${pct} btw.`;
  return { vanToepassing: true, verlegd: t.reverseCharge, laatsteControle: last ? toCheck(last) : null, melding, uitleg };
}
