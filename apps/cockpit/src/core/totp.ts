import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Tijdgebonden codes (TOTP, RFC 6238): SHA-1, 6 cijfers, 30 seconden.
 * Werkt met elke authenticator-app (Google Authenticator, Microsoft
 * Authenticator, 1Password, Bitwarden).
 */

const STEP_SECONDS = 30;
const DIGITS = 6;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.replace(/[\s=-]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('Ongeldig base32-teken');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function stepAt(ms: number): number {
  return Math.floor(ms / 1000 / STEP_SECONDS);
}

export function totpCode(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = h[h.length - 1]! & 0xf;
  const bin = ((h[offset]! & 0x7f) << 24) | (h[offset + 1]! << 16) | (h[offset + 2]! << 8) | h[offset + 3]!;
  return String(bin % 10 ** DIGITS).padStart(DIGITS, '0');
}

/**
 * Controleert een code met één stap speling naar voren en achteren (klokverschil).
 * Geeft de tijdstap terug die past, zodat de aanroeper hergebruik kan weigeren.
 */
export function verifyTotp(secret: string, code: string, nowMs = Date.now(), afterStep = -1): number | undefined {
  const clean = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(clean)) return undefined;
  const now = stepAt(nowMs);
  for (const step of [now - 1, now, now + 1]) {
    if (step <= afterStep) continue;
    const expected = Buffer.from(totpCode(secret, step));
    if (timingSafeEqual(expected, Buffer.from(clean))) return step;
  }
  return undefined;
}

/** Link voor de authenticator-app (ook als QR-code te tonen). */
export function otpauthUri(secret: string, account: string, issuer = 'Qbicle Cockpit'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const q = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: String(DIGITS), period: String(STEP_SECONDS) });
  return `otpauth://totp/${label}?${q.toString()}`;
}
