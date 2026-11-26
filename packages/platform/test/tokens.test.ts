import { describe, expect, it } from 'vitest';
import { hashKey, hashToken, looksLikeToken, newToken } from '../src/tokens.ts';

describe('tokens', () => {
  it('zijn uniek, herkenbaar en worden alleen als hash bewaard', () => {
    const a = newToken('login');
    const b = newToken('login');
    expect(a.token).not.toBe(b.token);
    expect(a.token).toMatch(/^qbl_[A-Za-z0-9_-]{43}$/);
    expect(a.hash).toHaveLength(32);
    expect(a.hash.equals(hashToken(a.token))).toBe(true);
    expect(a.hash.toString('utf8')).not.toContain(a.token);
  });

  it('vorm wordt per soort gecontroleerd', () => {
    const t = newToken('sessie').token;
    expect(looksLikeToken('sessie', t)).toBe(true);
    expect(looksLikeToken('login', t)).toBe(false);
    expect(looksLikeToken('sessie', t + 'x')).toBe(false);
    expect(looksLikeToken('sessie', "qbs_' OR 1=1 --")).toBe(false);
    expect(looksLikeToken('sessie', undefined)).toBe(false);
  });

  it('limietsleutels zijn hoofdletterongevoelig en niet leesbaar', () => {
    expect(hashKey('Jan@Voorbeeld.nl').equals(hashKey('jan@voorbeeld.nl'))).toBe(true);
    expect(hashKey('jan@voorbeeld.nl').toString('hex')).not.toContain('jan');
  });
});
