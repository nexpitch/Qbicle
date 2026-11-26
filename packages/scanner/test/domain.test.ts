import { describe, expect, it } from 'vitest';
import { DomainInputError, normalizeDomain } from '../src/domain.ts';

describe('normalizeDomain', () => {
  it.each([
    ['Voorbeeld.NL', 'voorbeeld.nl'],
    ['  voorbeeld.nl.  ', 'voorbeeld.nl'],
    ['https://www.voorbeeld.nl/contact?x=1', 'www.voorbeeld.nl'],
    ['voorbeeld.nl/pad', 'voorbeeld.nl'],
    ['bücher.de', 'xn--bcher-kva.de'],
    ['_dmarc.voorbeeld.nl', '_dmarc.voorbeeld.nl'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeDomain(input)).toBe(expected);
  });

  it.each([
    '',
    'localhost',
    'voorbeeld',
    '10.0.0.1',
    '[::1]',
    'http://192.168.1.1/',
    'voorbeeld.nl:8080',
    'printer.local',
    'nas.home.arpa',
    'server.internal',
    'info@voorbeeld.nl',
    '-fout-.nl',
    'a..b.nl',
    '1.2.3.4.5',
  ])('weigert %j', (input) => {
    expect(() => normalizeDomain(input)).toThrow(DomainInputError);
  });
});
