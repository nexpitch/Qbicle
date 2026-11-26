import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';

/** TLD's en achtervoegsels die nooit een openbaar internetdomein zijn. */
const INTERNAL_SUFFIXES = [
  'localhost',
  'local',
  'internal',
  'intranet',
  'lan',
  'home',
  'corp',
  'private',
  'test',
  'invalid',
  'example',
  'onion',
  'home.arpa',
  'in-addr.arpa',
  'ip6.arpa',
];

export class DomainInputError extends Error {}

/**
 * Normaliseert wat een gebruiker invult tot een kaal domein.
 * Accepteert ook "https://www.voorbeeld.nl/pad" en haalt dan het domein eruit.
 * Weigert IP-adressen, poorten en interne namen.
 */
export function normalizeDomain(input: string): string {
  let s = input.trim().toLowerCase();
  if (!s) throw new DomainInputError('Vul een domein in, bijvoorbeeld voorbeeld.nl.');

  if (/^[a-z][a-z0-9+.-]*:\/\//.test(s)) {
    try {
      s = new URL(s).hostname;
    } catch {
      throw new DomainInputError('Dit lijkt geen geldig webadres.');
    }
  } else {
    s = s.split(/[/?#]/)[0]!;
  }
  if (s.includes('@')) throw new DomainInputError('Vul alleen het domein in, zonder e-mailadres.');
  if (s.startsWith('[') || isIP(s)) {
    throw new DomainInputError('Qbicle scant domeinnamen, geen IP-adressen.');
  }
  if (/:\d+$/.test(s)) throw new DomainInputError('Vul het domein in zonder poortnummer.');
  s = s.replace(/\.$/, '');

  const ascii = domainToASCII(s);
  if (!ascii) throw new DomainInputError('Dit lijkt geen geldige domeinnaam.');
  if (ascii.length > 253) throw new DomainInputError('Deze domeinnaam is te lang.');

  const labels = ascii.split('.');
  if (labels.length < 2) {
    throw new DomainInputError('Vul een volledig domein in, bijvoorbeeld voorbeeld.nl.');
  }
  for (const l of labels) {
    if (!/^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9])?$/.test(l)) {
      throw new DomainInputError('Dit lijkt geen geldige domeinnaam.');
    }
  }
  if (/^\d+$/.test(labels[labels.length - 1]!)) {
    throw new DomainInputError('Dit lijkt geen geldige domeinnaam.');
  }
  for (const suf of INTERNAL_SUFFIXES) {
    if (ascii === suf || ascii.endsWith('.' + suf)) {
      throw new DomainInputError('Dit is een intern of gereserveerd domein; dat scant Qbicle niet.');
    }
  }
  return ascii;
}

/** Is `host` gelijk aan `domain` of een subdomein ervan? */
export function isSameOrSubdomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith('.' + domain);
}
