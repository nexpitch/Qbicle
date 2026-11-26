import { createHash, randomBytes } from 'node:crypto';

/**
 * Geheime tokens: 32 willekeurige bytes uit de CSPRNG van het besturingssysteem,
 * base64url-gecodeerd met een herkenbaar voorvoegsel (handig bij secret scanning).
 * In de database staat alleen de SHA-256-hash; een gelekte database levert
 * dus geen bruikbare inloglinks of sessies op.
 */
export type TokenKind = 'login' | 'sessie' | 'uitnodiging' | 'domeinmail';

const PREFIX: Record<TokenKind, string> = {
  login: 'qbl_',
  sessie: 'qbs_',
  uitnodiging: 'qbu_',
  domeinmail: 'qbd_',
};

export interface NewToken {
  token: string;
  hash: Buffer;
}

export function newToken(kind: TokenKind): NewToken {
  const token = PREFIX[kind] + randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

/** Controleert alleen de vorm, zodat onzin niet eens bij de database komt. */
export function looksLikeToken(kind: TokenKind, token: unknown): token is string {
  return typeof token === 'string' && token.length === PREFIX[kind].length + 43 && token.startsWith(PREFIX[kind]) &&
    /^[A-Za-z0-9_-]+$/.test(token.slice(PREFIX[kind].length));
}

/** Niet-geheime, maar onraadbare waarde voor het DNS-TXT-record. */
export function newVerificationCode(): string {
  return randomBytes(16).toString('hex');
}

/** Hash voor sleutels van misbruiklimieten (e-mail, IP), zodat die niet leesbaar worden opgeslagen. */
export function hashKey(value: string): Buffer {
  return createHash('sha256').update('qbicle-limiet:' + value.toLowerCase(), 'utf8').digest();
}
