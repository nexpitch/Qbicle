import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { inspect } from 'node:util';
import type { RouterCredentials } from './types.ts';

/**
 * Geheimen (router-wachtwoorden, API-sleutels).
 *
 * Regels:
 * - Een geheim zit in code altijd in een `Secret`. Die geeft bij toString, JSON
 *   en console.log/inspect alleen "[geheim]" terug. Zo lekt het niet via logs,
 *   foutmeldingen of API-antwoorden, ook niet per ongeluk.
 * - Opslaan gebeurt versleuteld met AES-256-GCM. De sleutel staat niet in de
 *   database (omgevingsvariabele of kluis). De versleuteling is gebonden aan de
 *   organisatie en de bron (AAD), zodat je een versleuteld geheim niet kunt
 *   verplaatsen naar een andere bron of klant.
 * - Op de lokale connector blijven router-wachtwoorden lokaal (ontwerp); deze
 *   code werkt daar hetzelfde, met een lokale sleutel.
 */
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    if (typeof value !== 'string' || value.length === 0) throw new Error('Leeg geheim');
    this.#value = value;
  }

  /** De echte waarde. Alleen gebruiken op de plek waar hij nodig is (verzoek naar de router). */
  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return '[geheim]';
  }

  toJSON(): string {
    return '[geheim]';
  }

  [inspect.custom](): string {
    return 'Secret([geheim])';
  }
}

const VERSION = 'v1';

export interface KeyRing {
  /** Sleutel waarmee nieuw wordt versleuteld. */
  currentId: string;
  keys: Map<string, Buffer>;
}

/**
 * Leest de sleutelring uit een omgevingsvariabele:
 * QBICLE_SECRETS_KEYS="2026a:<base64 32 bytes>,2025b:<base64 32 bytes>" (eerste = huidige).
 * Zo kun je een sleutel vervangen zonder oude geheimen meteen onleesbaar te maken.
 */
export function keyRingFromEnv(value = process.env.QBICLE_SECRETS_KEYS): KeyRing {
  if (!value) throw new Error('Zet QBICLE_SECRETS_KEYS (zie .env.example)');
  const keys = new Map<string, Buffer>();
  let currentId = '';
  for (const part of value.split(',').map((p) => p.trim()).filter(Boolean)) {
    const [id, b64] = part.split(':');
    if (!id || !b64 || !/^[a-z0-9-]{1,32}$/i.test(id)) throw new Error('Ongeldige sleutelring: verwacht id:base64');
    const key = Buffer.from(b64, 'base64');
    if (key.length !== 32) throw new Error(`Sleutel ${id} is geen 32 bytes`);
    keys.set(id, key);
    if (!currentId) currentId = id;
  }
  if (!currentId) throw new Error('Lege sleutelring');
  return { currentId, keys };
}

/** Nieuwe willekeurige sleutel, als base64 (voor in QBICLE_SECRETS_KEYS). */
export function newSecretKey(): string {
  return randomBytes(32).toString('base64');
}

/** Waar het geheim bij hoort. Gaat als AAD mee in de versleuteling. */
export interface SecretContext {
  organizationId: string;
  sourceId: string;
}

function aad(ctx: SecretContext): Buffer {
  return Buffer.from(`qbicle-geheim|${ctx.organizationId}|${ctx.sourceId}`, 'utf8');
}

export class SecretBox {
  constructor(private readonly ring: KeyRing) {}

  /** Versleutelt; uitkomst "v1.<sleutel-id>.<iv>.<tag>.<data>" (base64url). */
  seal(plaintext: string, ctx: SecretContext): string {
    const key = this.ring.keys.get(this.ring.currentId)!;
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(aad(ctx));
    const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [VERSION, this.ring.currentId, iv.toString('base64url'), tag.toString('base64url'), data.toString('base64url')].join('.');
  }

  open(sealed: string, ctx: SecretContext): string {
    const [version, keyId, iv, tag, data] = sealed.split('.');
    if (version !== VERSION || !keyId || !iv || !tag || data === undefined) throw new Error('Onbekend formaat versleuteld geheim');
    const key = this.ring.keys.get(keyId);
    if (!key) throw new Error(`Sleutel ${keyId} ontbreekt in de sleutelring`);
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    decipher.setAAD(aad(ctx));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    try {
      return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
    } catch {
      // Geen details: die zouden niets helpen en kunnen iets verraden.
      throw new Error('Geheim kon niet worden ontsleuteld (verkeerde sleutel, bron of beschadigd)');
    }
  }

  /** Moet dit geheim opnieuw versleuteld worden met de huidige sleutel? */
  needsRotation(sealed: string): boolean {
    return sealed.split('.')[1] !== this.ring.currentId;
  }
}

/** Inloggegevens versleutelen voor opslag. */
export function sealCredentials(box: SecretBox, creds: RouterCredentials, ctx: SecretContext): string {
  const plain =
    creds.kind === 'api-key'
      ? { kind: creds.kind, apiKey: creds.apiKey.reveal() }
      : { kind: creds.kind, username: creds.username, password: creds.password.reveal() };
  return box.seal(JSON.stringify(plain), ctx);
}

export function openCredentials(box: SecretBox, sealed: string, ctx: SecretContext): RouterCredentials {
  const raw = JSON.parse(box.open(sealed, ctx)) as Record<string, string>;
  if (raw.kind === 'api-key' && raw.apiKey) return { kind: 'api-key', apiKey: new Secret(raw.apiKey) };
  if (raw.kind === 'wachtwoord' && raw.username && raw.password) {
    return { kind: 'wachtwoord', username: raw.username, password: new Secret(raw.password) };
  }
  throw new Error('Onbekend soort inloggegevens');
}

/** Opslag van versleutelde geheimen per bron. */
export interface SecretStore {
  put(ctx: SecretContext, sealed: string): Promise<void>;
  get(ctx: SecretContext): Promise<string | undefined>;
  delete(ctx: SecretContext): Promise<void>;
}

export class MemorySecretStore implements SecretStore {
  private readonly rows = new Map<string, string>();
  private k(ctx: SecretContext): string {
    return `${ctx.organizationId}|${ctx.sourceId}`;
  }
  async put(ctx: SecretContext, sealed: string): Promise<void> {
    this.rows.set(this.k(ctx), sealed);
  }
  async get(ctx: SecretContext): Promise<string | undefined> {
    return this.rows.get(this.k(ctx));
  }
  async delete(ctx: SecretContext): Promise<void> {
    this.rows.delete(this.k(ctx));
  }
  /** Alleen voor tests: wat er echt is opgeslagen. */
  raw(): string[] {
    return [...this.rows.values()];
  }
}

/** Alles met een query-functie zoals pg.Pool of pg.Client. */
export interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

/** Opslag in tabel source_secret (migratie 0004). Bevat alleen versleutelde waarden. */
export class PgSecretStore implements SecretStore {
  constructor(private readonly db: Queryable) {}

  async put(ctx: SecretContext, sealed: string): Promise<void> {
    // Alleen voor een bron die echt van deze organisatie is.
    const r = await this.db.query(
      `INSERT INTO source_secret (source_id, organization_id, sealed)
       SELECT s.id, s.organization_id, $3 FROM source s WHERE s.id = $1 AND s.organization_id = $2
       ON CONFLICT (source_id) DO UPDATE SET sealed = EXCLUDED.sealed, updated_at = now()
       RETURNING source_id`,
      [ctx.sourceId, ctx.organizationId, sealed],
    );
    if (r.rows.length === 0) throw new Error('Bron hoort niet bij deze organisatie');
  }

  async get(ctx: SecretContext): Promise<string | undefined> {
    const r = await this.db.query('SELECT sealed FROM source_secret WHERE source_id = $1 AND organization_id = $2', [
      ctx.sourceId,
      ctx.organizationId,
    ]);
    return r.rows[0]?.sealed as string | undefined;
  }

  async delete(ctx: SecretContext): Promise<void> {
    await this.db.query('DELETE FROM source_secret WHERE source_id = $1 AND organization_id = $2', [ctx.sourceId, ctx.organizationId]);
  }
}

/**
 * Pseudonimiseert een MAC-adres met een sleutel per organisatie (HMAC-SHA-256).
 * Zelfde apparaat = zelfde waarde binnen de organisatie, maar niet terug te rekenen
 * en niet te vergelijken tussen klanten.
 */
export function pseudonymizeMac(mac: string, orgKey: Buffer): string {
  return createHmac('sha256', orgKey).update(`mac|${mac.toLowerCase()}`).digest('hex').slice(0, 32);
}

/**
 * Sleutel voor pseudonimisering per organisatie, afgeleid van QBICLE_PSEUDONYM_KEY.
 * Bewust een aparte sleutel die niet roteert met de geheimensleutels: anders
 * krijgt hetzelfde gastapparaat na een rotatie een ander pseudoniem.
 */
export function orgPseudonymKey(organizationId: string, master = process.env.QBICLE_PSEUDONYM_KEY): Buffer {
  if (!master) throw new Error('Zet QBICLE_PSEUDONYM_KEY (zie .env.example)');
  const key = Buffer.from(master, 'base64');
  if (key.length < 32) throw new Error('QBICLE_PSEUDONYM_KEY moet minstens 32 bytes zijn');
  return createHmac('sha256', key).update(`pseudoniem|${organizationId}`).digest();
}

export function constantTimeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
