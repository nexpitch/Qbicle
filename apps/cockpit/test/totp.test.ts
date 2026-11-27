import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, otpauthUri, stepAt, totpCode, verifyTotp } from '../src/core/totp.ts';

// RFC 6238, bijlage B (SHA-1, sleutel "12345678901234567890"), laatste 6 cijfers.
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));

describe('TOTP', () => {
  it('base32 heen en terug', () => {
    expect(RFC_SECRET).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Decode(RFC_SECRET).toString()).toBe('12345678901234567890');
  });

  it('testvectoren uit RFC 6238', () => {
    expect(totpCode(RFC_SECRET, stepAt(59_000))).toBe('287082');
    expect(totpCode(RFC_SECRET, stepAt(1_111_111_109_000))).toBe('081804');
    expect(totpCode(RFC_SECRET, stepAt(2_000_000_000_000))).toBe('279037');
  });

  it('accepteert één stap speling en weigert hergebruik', () => {
    const now = 1_700_000_000_000;
    const step = stepAt(now);
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step), now)).toBe(step);
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step - 1), now)).toBe(step - 1);
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step - 2), now)).toBeUndefined();
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step), now, step)).toBeUndefined();
    expect(verifyTotp(RFC_SECRET, 'abcdef', now)).toBeUndefined();
    expect(verifyTotp(RFC_SECRET, '123 456'.replace(/\d/g, '1'), now)).toBeUndefined();
  });

  it('otpauth-link voor de app', () => {
    expect(otpauthUri('ABC', 'erik@qbicle.nl')).toBe(
      'otpauth://totp/Qbicle%20Cockpit%3Aerik%40qbicle.nl?secret=ABC&issuer=Qbicle+Cockpit&algorithm=SHA1&digits=6&period=30',
    );
  });
});
