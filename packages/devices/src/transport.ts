import { createHash, randomBytes } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import type { PeerCertificate } from 'node:tls';
import { constantTimeEqual, type Secret } from './secrets.ts';
import type { TlsSettings } from './types.ts';

/**
 * Netwerktoegang van de connectors, achter één interface. In tests vervangen
 * door FixtureTransport, zodat alles zonder echte router te testen is.
 */
export interface HttpRequest {
  method: 'GET' | 'POST';
  /** Pad inclusief query, bijvoorbeeld "/rest/ip/arp". */
  path: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface Transport {
  send(req: HttpRequest): Promise<HttpResponse>;
}

export class ConnectorError extends Error {
  constructor(
    readonly code: 'niet_toegestaan' | 'inloggen_mislukt' | 'onbereikbaar' | 'certificaat' | 'antwoord_onbekend' | 'time_out',
    message: string,
  ) {
    super(message);
    this.name = 'ConnectorError';
  }
}

/** Een toegestaan verzoek: methode + pad (regex) + optioneel SOAP-actie. */
export interface AllowRule {
  method: 'GET' | 'POST';
  path: RegExp;
  /** Voor TR-064 (Fritz!Box): alleen deze SOAPAction-waarden. */
  soapActions?: RegExp;
}

/**
 * Bewaakt dat een connector alleen leest. Elk verzoek moet passen op een vaste
 * lijst; alles anders (ook een POST naar een schrijf-endpoint door een
 * programmeerfout) wordt geweigerd voordat het de router bereikt.
 */
export class ReadOnlyGuard implements Transport {
  constructor(
    private readonly inner: Transport,
    private readonly rules: AllowRule[],
  ) {}

  async send(req: HttpRequest): Promise<HttpResponse> {
    const action = req.headers?.SOAPAction ?? req.headers?.soapaction;
    const ok = this.rules.some(
      (r) => r.method === req.method && r.path.test(req.path) && (r.soapActions ? action !== undefined && r.soapActions.test(action) : action === undefined),
    );
    if (!ok) throw new ConnectorError('niet_toegestaan', `Verzoek niet toegestaan voor alleen-lezen: ${req.method} ${req.path.split('?')[0]}`);
    return this.inner.send(req);
  }
}

export interface HttpTransportOptions {
  baseUrl: string;
  tls: TlsSettings;
  timeoutMs?: number;
  /** Vaste headers bij elk verzoek (bijvoorbeeld X-API-KEY). Waarden als Secret blijven uit logs. */
  headers?: Record<string, string | Secret>;
  /** Basic- of Digest-authenticatie. */
  auth?: { scheme: 'basic' | 'digest'; username: string; password: Secret };
  /** Maximale grootte van een antwoord. Standaard 5 MB. */
  maxBytes?: number;
}

/**
 * Echte HTTP(S)-verbinding met één router of controller.
 *
 * - Alleen naar de opgegeven basis-URL; redirects worden niet gevolgd.
 * - TLS: systeemcertificaten, of een vastgepind certificaat van de router. Er is
 *   bewust geen optie om certificaten niet te controleren.
 * - Inloggegevens gaan alleen in de Authorization-header; ze staan nooit in een
 *   foutmelding of log.
 */
export class HttpTransport implements Transport {
  private readonly base: URL;
  private digest?: { realm: string; nonce: string; qop?: string; opaque?: string; nc: number };

  constructor(private readonly opts: HttpTransportOptions) {
    this.base = new URL(opts.baseUrl);
    if (this.base.protocol !== 'https:' && this.base.protocol !== 'http:') throw new Error('Alleen http(s) wordt ondersteund');
    const hasSecretHeader = Object.values(opts.headers ?? {}).some((v) => typeof v !== 'string');
    if (this.base.protocol === 'http:' && (opts.auth?.scheme === 'basic' || hasSecretHeader)) {
      // Basic-auth of API-sleutels over onversleuteld http zou het wachtwoord meesturen in leesbare tekst.
      // Zonder inloggegevens (UPnP) of met Digest mag http wel.
      throw new Error('Gebruik https; over http is alleen Digest-authenticatie of geen inloggegevens toegestaan');
    }
    if (opts.tls.mode === 'vastgepind' && !opts.tls.certPem) {
      // Alleen een vingerafdruk is niet genoeg: dan moet de controle ná de handshake,
      // en kan een verzoek met inloggegevens al onderweg zijn.
      throw new Error('Vastgepind certificaat zonder certificaat (PEM)');
    }
  }

  async send(req: HttpRequest): Promise<HttpResponse> {
    let res = await this.once(req, this.authHeader(req));
    if (res.status === 401 && this.opts.auth?.scheme === 'digest') {
      const challenge = parseDigestChallenge(res.headers['www-authenticate'] ?? '');
      if (challenge) {
        this.digest = { ...challenge, nc: 0 };
        res = await this.once(req, this.authHeader(req));
      }
    }
    if (res.status === 401 || res.status === 403) throw new ConnectorError('inloggen_mislukt', 'De router weigert de inloggegevens');
    return res;
  }

  private authHeader(req: HttpRequest): string | undefined {
    const auth = this.opts.auth;
    if (!auth) return undefined;
    if (auth.scheme === 'basic') {
      return 'Basic ' + Buffer.from(`${auth.username}:${auth.password.reveal()}`).toString('base64');
    }
    if (!this.digest) return undefined;
    const d = this.digest;
    d.nc += 1;
    const nc = d.nc.toString(16).padStart(8, '0');
    const cnonce = randomBytes(8).toString('hex');
    const uri = req.path;
    const md5 = (s: string) => createHash('md5').update(s).digest('hex');
    const ha1 = md5(`${auth.username}:${d.realm}:${auth.password.reveal()}`);
    const ha2 = md5(`${req.method}:${uri}`);
    const qop = d.qop?.split(',').map((q) => q.trim()).includes('auth') ? 'auth' : undefined;
    const response = qop ? md5(`${ha1}:${d.nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : md5(`${ha1}:${d.nonce}:${ha2}`);
    const parts = [
      `username="${auth.username}"`,
      `realm="${d.realm}"`,
      `nonce="${d.nonce}"`,
      `uri="${uri}"`,
      `response="${response}"`,
      ...(qop ? [`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`] : []),
      ...(d.opaque ? [`opaque="${d.opaque}"`] : []),
    ];
    return 'Digest ' + parts.join(', ');
  }

  private once(req: HttpRequest, authorization: string | undefined): Promise<HttpResponse> {
    const url = new URL(req.path, this.base);
    if (url.origin !== this.base.origin) return Promise.reject(new ConnectorError('niet_toegestaan', 'Verzoek buiten de router'));
    const headers: Record<string, string> = { 'User-Agent': 'Qbicle-connector/0.1 (alleen-lezen)', Accept: '*/*' };
    for (const [k, v] of Object.entries(this.opts.headers ?? {})) headers[k] = typeof v === 'string' ? v : v.reveal();
    Object.assign(headers, req.headers ?? {});
    if (authorization) headers.Authorization = authorization;
    if (req.body !== undefined) headers['Content-Length'] = String(Buffer.byteLength(req.body));
    const maxBytes = this.opts.maxBytes ?? 5_000_000;
    const timeout = this.opts.timeoutMs ?? 10_000;
    const tls = this.opts.tls;

    return new Promise((resolve, reject) => {
      const common = { method: req.method, headers, timeout };
      const r =
        url.protocol === 'https:'
          ? httpsRequest(url, {
              ...common,
              ...(tls.mode === 'vastgepind'
                ? {
                    // Het vastgepinde certificaat is de enige vertrouwde CA. De naamcontrole
                    // vervangen we door de vingerafdruk: routers hebben zelden een geldige naam.
                    ca: tls.certPem,
                    checkServerIdentity: (_host: string, cert: PeerCertificate) =>
                      tls.fingerprint256 && !constantTimeEqual(cert.fingerprint256 ?? '', tls.fingerprint256)
                        ? new Error('vingerafdruk wijkt af')
                        : undefined,
                  }
                : {}),
            })
          : httpRequest(url, common);
      r.on('timeout', () => r.destroy(new ConnectorError('time_out', 'De router reageert niet op tijd')));
      r.on('error', (err) => {
        if (err instanceof ConnectorError) return reject(err);
        const code = (err as NodeJS.ErrnoException).code ?? '';
        if (/CERT|SSL|TLS|vingerafdruk/i.test(code + err.message)) return reject(new ConnectorError('certificaat', 'Het certificaat van de router klopt niet'));
        reject(new ConnectorError('onbereikbaar', `De router is niet bereikbaar (${code || 'netwerkfout'})`));
      });
      r.on('response', (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > maxBytes) r.destroy(new ConnectorError('antwoord_onbekend', 'Antwoord van de router is te groot'));
          else chunks.push(c);
        });
        res.on('end', () => {
          const h: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) h[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
          resolve({ status: res.statusCode ?? 0, headers: h, body: Buffer.concat(chunks).toString('utf8') });
        });
      });
      if (req.body !== undefined) r.write(req.body);
      r.end();
    });
  }
}

export function parseDigestChallenge(header: string): { realm: string; nonce: string; qop?: string; opaque?: string } | undefined {
  if (!/^Digest\s/i.test(header)) return undefined;
  const params: Record<string, string> = {};
  for (const m of header.slice(7).matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]*))/g)) params[m[1]!.toLowerCase()] = m[2] ?? m[3] ?? '';
  if (!params.realm || !params.nonce) return undefined;
  return { realm: params.realm, nonce: params.nonce, qop: params.qop, opaque: params.opaque };
}

/**
 * Transport voor tests en demo's: antwoorden uit fixtures, per "METHODE pad"
 * (en bij SOAP: "POST pad#actie"). Onbekend verzoek = 404. Houdt bij wat er gevraagd is.
 */
export class FixtureTransport implements Transport {
  readonly requests: HttpRequest[] = [];
  /** Een lijst als waarde: antwoorden op opeenvolgende verzoeken (de laatste blijft staan). */
  constructor(private readonly responses: Record<string, string | HttpResponse | Array<string | HttpResponse>>) {}

  async send(req: HttpRequest): Promise<HttpResponse> {
    this.requests.push(req);
    const action = req.headers?.SOAPAction;
    const key = `${req.method} ${req.path}${action ? '#' + action.replace(/"/g, '').split('#')[1] : ''}`;
    let r = this.responses[key];
    if (Array.isArray(r)) r = r.length > 1 ? r.shift() : r[0];
    if (r === undefined) return { status: 404, headers: {}, body: '' };
    return typeof r === 'string' ? { status: 200, headers: {}, body: r } : r;
  }
}
