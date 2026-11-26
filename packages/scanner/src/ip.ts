import { isIP } from 'node:net';

/**
 * Bepaalt of een IP-adres een gewoon, publiek internetadres is.
 *
 * De scanner verbindt nooit met interne, lokale of gereserveerde adressen.
 * Zo kan iemand Qbicle niet misbruiken om via een domein dat naar
 * bijvoorbeeld 10.0.0.1 of 169.254.169.254 wijst ons eigen netwerk te verkennen.
 */
export function isPublicIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return isPublicIpv4(ip);
  if (v === 6) return isPublicIpv6(ip);
  return false;
}

function ipv4ToInt(ip: string): number {
  const p = ip.split('.').map(Number);
  return ((p[0]! << 24) >>> 0) + (p[1]! << 16) + (p[2]! << 8) + p[3]!;
}

const V4_BLOCKED: [string, number][] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

function isPublicIpv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  for (const [base, bits] of V4_BLOCKED) {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if ((n & mask) >>> 0 === (ipv4ToInt(base) & mask) >>> 0) return false;
  }
  return true;
}

function expandIpv6(ip: string): number[] {
  let s = ip.toLowerCase();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  // IPv4-staart (bijv. ::ffff:1.2.3.4) omzetten naar twee groepen.
  const v4 = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const n = ipv4ToInt(v4[1]!);
    s = s.slice(0, -v4[1]!.length) + ((n >>> 16) & 0xffff).toString(16) + ':' + (n & 0xffff).toString(16);
  }
  const [head, tail] = s.split('::') as [string, string | undefined];
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail ? tail.split(':') : [];
  const fill = tail !== undefined ? 8 - h.length - t.length : 0;
  return [...h, ...Array(fill).fill('0'), ...t].map((g) => parseInt(g || '0', 16));
}

function isPublicIpv6(ip: string): boolean {
  const g = expandIpv6(ip);
  if (g.length !== 8) return false;
  const [a, b] = g as [number, number, ...number[]];
  if (g.every((x) => x === 0)) return false; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return false; // ::1
  // IPv4-mapped ::ffff:a.b.c.d en IPv4-compatible
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) {
    const v4 = `${g[6]! >> 8}.${g[6]! & 255}.${g[7]! >> 8}.${g[7]! & 255}`;
    return isPublicIpv4(v4);
  }
  if ((a & 0xfe00) === 0xfc00) return false; // fc00::/7 unique local
  if ((a & 0xffc0) === 0xfe80) return false; // fe80::/10 link-local
  if ((a & 0xff00) === 0xff00) return false; // ff00::/8 multicast
  if (a === 0x2001 && b === 0x0db8) return false; // documentatie
  if (a === 0x0064 && b === 0xff9b) return false; // NAT64, kan naar intern IPv4 wijzen
  if (a === 0x2002) return false; // 6to4, kan intern IPv4 bevatten
  if (a === 0x2001 && b === 0) return false; // Teredo
  return true;
}
