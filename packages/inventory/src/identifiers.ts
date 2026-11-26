import type { Identifier, IdentifierType, Strength } from './types.ts';

/** Serienummers die fabrikanten als opvulling gebruiken; daar mag je nooit op samenvoegen. */
const JUNK_SERIALS = new Set([
  '',
  '0',
  '00000000',
  '123456789',
  'DEFAULT STRING',
  'NONE',
  'N/A',
  'NOT APPLICABLE',
  'SYSTEM SERIAL NUMBER',
  'TO BE FILLED BY O.E.M.',
  'UNKNOWN',
]);

/**
 * Normaliseert een MAC-adres naar "aa:bb:cc:dd:ee:ff".
 * Geeft undefined terug voor ongeldige, lege of broadcast-adressen.
 */
export function normalizeMac(raw: string): string | undefined {
  const hex = raw.toLowerCase().replace(/[^0-9a-f]/g, '');
  if (hex.length !== 12) return undefined;
  if (hex === '000000000000' || hex === 'ffffffffffff') return undefined;
  return hex.match(/../g)!.join(':');
}

/**
 * Willekeurig (privacy-)MAC-adres: het "locally administered"-bit staat aan.
 * Telefoons en laptops gebruiken die per wifi-netwerk, soms per dag anders.
 */
export function isRandomizedMac(mac: string): boolean {
  const first = parseInt(mac.slice(0, 2), 16);
  return (first & 0b10) !== 0;
}

/** Hostnaam zonder domein en in kleine letters: "LAPTOP-Erik.local." wordt "laptop-erik". */
export function normalizeHostname(raw: string): string | undefined {
  const label = raw.trim().toLowerCase().replace(/\.$/, '').split('.')[0] ?? '';
  return label.length > 0 ? label : undefined;
}

export function isPrivateIpv4(ip: string): boolean {
  const m = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

/** Normaliseert een identifier; undefined betekent: niet bruikbaar, weggooien. */
export function normalizeIdentifier(id: Identifier): Identifier | undefined {
  const value = id.value.trim();
  switch (id.type) {
    case 'mac': {
      const mac = normalizeMac(value);
      return mac ? { type: 'mac', value: mac } : undefined;
    }
    case 'hostname': {
      const host = normalizeHostname(value);
      return host ? { type: 'hostname', value: host } : undefined;
    }
    case 'serial': {
      const serial = value.toUpperCase();
      return JUNK_SERIALS.has(serial) ? undefined : { type: 'serial', value: serial };
    }
    case 'fqdn':
      return value ? { type: 'fqdn', value: value.toLowerCase().replace(/\.$/, '') } : undefined;
    case 'ip':
    case 'cloud-id':
    case 'url':
    case 'cert':
    case 'upn':
      return value ? { type: id.type, value: value.toLowerCase() } : undefined;
  }
}

/** Hoe sterk een identifier is voor het samenvoegen van waarnemingen. */
export function strengthOf(id: Identifier): Strength {
  switch (id.type) {
    case 'mac':
      return isRandomizedMac(id.value) ? 'zwak' : 'sterk';
    case 'hostname':
    case 'ip':
      return 'zwak';
    default:
      return 'sterk';
  }
}

/** Identifiertypes waarvan een asset er maar één kan hebben. Verschil = ander apparaat. */
export const SINGLE_VALUED: ReadonlySet<IdentifierType> = new Set(['serial']);

export function identifierKey(id: Identifier): string {
  return `${id.type}:${id.value}`;
}
