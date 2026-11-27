import { createSign } from 'node:crypto';

/**
 * Toegang tot Google-API's met een serviceaccount, zonder Google-SDK.
 *
 * Productie: Qbicle heeft één eigen serviceaccount. De klant geeft dat account
 *  - bij Google Workspace: alleen-lezen beheer-scopes via domeinbrede delegatie
 *    (Admin-console → Beveiliging → API-beheer, later via de Marketplace);
 *  - bij Google Cloud: de rol Security Reviewer op project of organisatie.
 * Per klant bewaren we dus geen geheimen, alleen het e-mailadres van een beheerder
 * (Workspace) of de project-id's (Cloud).
 *
 * Lokaal testen: een sleutelbestand (JSON) van een serviceaccount in je eigen
 * Google-project, zie docs/google.md. De sleutel wordt nooit gelogd of opgeslagen.
 */

export interface ServiceAccountSleutel {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

export type Fetch = typeof fetch;

const TOKEN_URI = 'https://oauth2.googleapis.com/token';

export class GoogleFout extends Error {
  constructor(
    /** geen_recht: 401/403; niet_gevonden: 404; dienst_uit: API staat uit; overig: alles anders */
    readonly soort: 'geen_recht' | 'niet_gevonden' | 'dienst_uit' | 'token' | 'overig',
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export function leesSleutel(json: string): ServiceAccountSleutel {
  let d: unknown;
  try {
    d = JSON.parse(json);
  } catch {
    throw new GoogleFout('token', 'Het sleutelbestand is geen geldige JSON.');
  }
  const s = d as Partial<ServiceAccountSleutel> & { type?: string };
  if (s.type !== 'service_account' || typeof s.client_email !== 'string' || typeof s.private_key !== 'string') {
    throw new GoogleFout('token', 'Dit is geen sleutel van een serviceaccount (type "service_account").');
  }
  return { client_email: s.client_email, private_key: s.private_key, token_uri: s.token_uri };
}

const b64 = (v: string | Buffer) => Buffer.from(v).toString('base64url');

/** Ondertekende JWT voor de token-uitwisseling (RFC 7523). `sub` = beheerder om namens te lezen (Workspace). */
export function maakJwt(sleutel: ServiceAccountSleutel, scopes: string[], sub: string | undefined, nu: Date): string {
  const iat = Math.floor(nu.getTime() / 1000);
  const kop = b64(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims: Record<string, unknown> = {
    iss: sleutel.client_email,
    scope: scopes.join(' '),
    aud: sleutel.token_uri || TOKEN_URI,
    iat,
    exp: iat + 3600,
  };
  if (sub) claims.sub = sub;
  const inhoud = `${kop}.${b64(JSON.stringify(claims))}`;
  const handtekening = createSign('RSA-SHA256').update(inhoud).sign(sleutel.private_key);
  return `${inhoud}.${b64(handtekening)}`;
}

export interface GoogleClientOpties {
  sleutel: ServiceAccountSleutel;
  scopes: string[];
  /** Workspace: e-mailadres van een beheerder; Cloud: leeg. */
  namens?: string;
  fetch?: Fetch;
  nu?: () => Date;
}

export class GoogleClient {
  private token: { waarde: string; verloopt: number; scopes: string[] } | null = null;
  private readonly f: Fetch;
  private readonly nu: () => Date;

  constructor(private readonly o: GoogleClientOpties) {
    this.f = o.fetch ?? fetch;
    this.nu = o.nu ?? (() => new Date());
  }

  /** Vraagt een token aan. Geeft de verleende scopes terug (voor de te-veel-rechten-check). */
  async tokenVoor(scopes: string[]): Promise<{ waarde: string; scopes: string[] }> {
    const uri = this.o.sleutel.token_uri || TOKEN_URI;
    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: maakJwt(this.o.sleutel, scopes, this.o.namens, this.nu()),
    });
    const r = await this.f(uri, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
    const d = (await r.json().catch(() => ({}))) as { access_token?: string; scope?: string; error?: string; error_description?: string; expires_in?: number };
    if (!r.ok || !d.access_token) {
      // Geen details van Google doorgeven die de sleutel zouden kunnen bevatten; error-code is genoeg.
      const uitleg =
        d.error === 'unauthorized_client'
          ? 'Google geeft geen toestemming voor deze rechten. Controleer de domeinbrede delegatie (Client-ID en scopes).'
          : d.error === 'invalid_grant'
            ? 'Google weigert de sleutel of het beheerdersaccount. Controleer of het account bestaat en of de sleutel niet is ingetrokken.'
            : `Google gaf geen toegang (${d.error ?? r.status}).`;
      throw new GoogleFout('token', uitleg, r.status);
    }
    return { waarde: d.access_token, scopes: d.scope ? d.scope.split(' ') : scopes };
  }

  async verleendeScopes(): Promise<string[]> {
    return (await this.geldigToken()).scopes;
  }

  private async geldigToken() {
    const nu = this.nu().getTime();
    if (!this.token || this.token.verloopt <= nu + 60_000) {
      const t = await this.tokenVoor(this.o.scopes);
      this.token = { waarde: t.waarde, scopes: t.scopes, verloopt: nu + 3_000_000 };
    }
    return this.token;
  }

  async get<T>(url: string): Promise<T> {
    return this.verzoek<T>('GET', url);
  }

  async post<T>(url: string, body: unknown): Promise<T> {
    return this.verzoek<T>('POST', url, body);
  }

  private async verzoek<T>(method: 'GET' | 'POST', url: string, body?: unknown): Promise<T> {
    if (!url.startsWith('https://') || !new URL(url).hostname.endsWith('.googleapis.com')) {
      throw new GoogleFout('overig', 'Alleen Google-API’s zijn toegestaan.');
    }
    const t = await this.geldigToken();
    const headers: Record<string, string> = { authorization: `Bearer ${t.waarde}`, accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const r = await this.f(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
    if (r.ok) return (await r.json()) as T;
    const d = (await r.json().catch(() => ({}))) as { error?: { message?: string; status?: string; errors?: { reason?: string }[]; details?: { reason?: string }[] } };
    const redenen = [...(d.error?.errors ?? []), ...(d.error?.details ?? [])].map((e) => e.reason ?? '');
    const melding = d.error?.message ?? `HTTP ${r.status}`;
    if (redenen.some((x) => x === 'SERVICE_DISABLED' || x === 'accessNotConfigured')) throw new GoogleFout('dienst_uit', melding, r.status);
    if (r.status === 401 || r.status === 403) throw new GoogleFout('geen_recht', melding, r.status);
    if (r.status === 404) throw new GoogleFout('niet_gevonden', melding, r.status);
    throw new GoogleFout('overig', melding, r.status);
  }

  /** Alle pagina's van een lijst ophalen (nextPageToken), met een harde grens. */
  async alles<T>(url: string, veld: string, max = 5_000): Promise<T[]> {
    const uit: T[] = [];
    let token: string | undefined;
    do {
      const u = new URL(url);
      if (token) u.searchParams.set('pageToken', token);
      const d = await this.get<Record<string, unknown> & { nextPageToken?: string }>(u.toString());
      const items = d[veld];
      if (Array.isArray(items)) uit.push(...(items as T[]));
      token = d.nextPageToken;
    } while (token && uit.length < max);
    return uit.slice(0, max);
  }
}

/** Uitkomst van één onderdeel: eerlijk over wat we wel en niet konden lezen. */
export type Dekking = { onderdeel: string; status: 'gecontroleerd' | 'niet_gecontroleerd'; reden?: string };

export function redenVan(e: unknown): string {
  if (e instanceof GoogleFout) {
    if (e.soort === 'geen_recht') return 'Geen leesrecht voor dit onderdeel.';
    if (e.soort === 'dienst_uit') return 'Deze Google-dienst (API) staat uit.';
    if (e.soort === 'niet_gevonden') return 'Niet gevonden.';
    return e.message;
  }
  return 'Onbekende fout bij het lezen.';
}
