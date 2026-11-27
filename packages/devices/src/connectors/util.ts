import { ConnectorError, type HttpResponse } from '../transport.ts';

export function json<T>(res: HttpResponse, what: string): T {
  if (res.status !== 200) throw new ConnectorError('antwoord_onbekend', `${what}: onverwacht antwoord (${res.status})`);
  try {
    return JSON.parse(res.body) as T;
  } catch {
    throw new ConnectorError('antwoord_onbekend', `${what}: antwoord is geen JSON`);
  }
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e] ?? m;
  });
}

/** Leest eenvoudige <Naam>waarde</Naam>-velden uit een stuk XML (geen geneste elementen). */
export function xmlFields(xml: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of xml.matchAll(/<([\w:.-]+)>([^<]*)<\/\1>/g)) {
    const name = m[1]!.replace(/^\w+:/, '');
    out[name] = decodeXml(m[2]!.trim());
  }
  return out;
}

/** Alle blokken <tag>...</tag>. */
export function xmlBlocks(xml: string, tag: string): string[] {
  return [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))].map((m) => m[1]!);
}

export function isPublicIpv4(ip: string): boolean {
  const m = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT: niet van de klant
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  return true;
}

const MAX_RANGE = 64;

/**
 * Poort of poortbereik ("443", "8100-8101", "8100:8101") als lijst. Een heel groot
 * bereik kappen we af op de eerste 64 poorten; de bevinding zegt dan toch genoeg.
 */
export function portRange(v: string | undefined): number[] {
  const m = (v ?? '').trim().match(/^(\d+)(?:[-:](\d+))?$/);
  if (!m) return [];
  const a = Number(m[1]);
  const b = m[2] ? Number(m[2]) : a;
  if (b < a || a < 1 || b > 65535) return [];
  return Array.from({ length: Math.min(b - a + 1, MAX_RANGE) }, (_, i) => a + i);
}
