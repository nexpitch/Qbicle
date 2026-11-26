import { createSocket } from 'node:dgram';
import { isPrivateIpv4 } from './util.ts';

/**
 * Vindt de UPnP-beschrijving van de eigen gateway (providermodem of router) met één
 * SSDP-zoekvraag, rechtstreeks aan het adres van de gateway (unicast, poort 1900).
 *
 * Dit is dezelfde vraag die elke computer, spelcomputer of tv in huis stelt om de
 * router te vinden. We vragen het alleen aan de gateway, nemen alleen een antwoord van
 * dat adres aan, en alleen een beschrijving die op dat adres staat. Niveau 2P:
 * geen scan, geen login, niets wordt veranderd.
 */
export const IGD_TARGETS = ['urn:schemas-upnp-org:device:InternetGatewayDevice:1', 'urn:schemas-upnp-org:device:InternetGatewayDevice:2'];

export function mSearch(target: string, host: string): string {
  return ['M-SEARCH * HTTP/1.1', `HOST: ${host}:1900`, 'MAN: "ssdp:discover"', 'MX: 2', `ST: ${target}`, 'USER-AGENT: Qbicle-connector/0.1 (alleen-lezen) UPnP/1.1', '', ''].join('\r\n');
}

/** LOCATION uit een SSDP-antwoord, alleen als die op de gateway zelf staat. */
export function parseSsdpLocation(reply: string, gateway: string): URL | undefined {
  if (!/^HTTP\/1\.[01] 200/i.test(reply)) return undefined;
  const line = reply.split(/\r?\n/).find((l) => /^location\s*:/i.test(l));
  if (!line) return undefined;
  try {
    const url = new URL(line.replace(/^location\s*:\s*/i, '').trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    if (url.hostname !== gateway) return undefined;
    return url;
  } catch {
    return undefined;
  }
}

export async function locateIgd(gateway: string, opts: { timeoutMs?: number } = {}): Promise<URL | undefined> {
  if (!isPrivateIpv4(gateway)) throw new Error('De gateway moet een adres in je eigen netwerk zijn (bijvoorbeeld 192.168.2.254)');
  const timeoutMs = opts.timeoutMs ?? 3000;
  return new Promise((resolve) => {
    const socket = createSocket('udp4');
    let done = false;
    const finish = (url: URL | undefined) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.close();
      resolve(url);
    };
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    socket.on('error', () => finish(undefined));
    socket.on('message', (msg, rinfo) => {
      if (rinfo.address !== gateway) return;
      const url = parseSsdpLocation(msg.toString('utf8'), gateway);
      if (url) finish(url);
    });
    socket.bind(0, () => {
      for (const t of IGD_TARGETS) socket.send(mSearch(t, gateway), 1900, gateway);
    });
  });
}

export interface UpnpDeviceInfo {
  vendor?: string;
  model?: string;
  /** Kort apparaattype uit de UPnP-beschrijving, bijvoorbeeld "MediaRenderer". */
  deviceType?: string;
}

/** Fabrikant, model en type uit een UPnP-apparaatbeschrijving (alleen het hoofdapparaat). */
export function parseUpnpDescription(xml: string): UpnpDeviceInfo {
  const root = (xml.match(/<device>([\s\S]*?)(<deviceList>|<\/device>)/)?.[1] ?? '');
  const field = (name: string) => root.match(new RegExp(`<${name}>([^<]{1,120})</${name}>`))?.[1]?.trim() || undefined;
  const model = [field('modelName'), field('modelNumber')].filter(Boolean);
  // "Sonos Play:1 S12" of "LG TV 43UK6300": modelnummer alleen toevoegen als het niet al in de naam staat.
  const modelText = model.length === 2 && model[0]!.includes(model[1]!) ? model[0] : model.join(' ');
  return {
    vendor: field('manufacturer'),
    model: modelText || field('modelDescription'),
    deviceType: field('deviceType')?.match(/:device:([\w-]+):/)?.[1],
  };
}

/**
 * Vraagt elk opgegeven apparaat in het eigen netwerk één keer (unicast) of het UPnP spreekt,
 * en leest dan zijn eigen beschrijving: fabrikant, model en type. Geen poortscan, geen
 * login, alleen de beschrijving op het adres van het apparaat zelf. Hoort bij de scanopdracht.
 */
export async function describeUpnpDevices(
  ips: string[],
  opts: { timeoutMs?: number; fetchDescription?: (url: URL) => Promise<string | undefined> } = {},
): Promise<Map<string, UpnpDeviceInfo>> {
  const targets = [...new Set(ips.filter(isPrivateIpv4))].slice(0, 254);
  const locations = new Map<string, URL>();
  if (targets.length === 0) return new Map();
  await new Promise<void>((resolve) => {
    const socket = createSocket('udp4');
    const timer = setTimeout(() => {
      socket.close();
      resolve();
    }, opts.timeoutMs ?? 3000);
    socket.on('error', () => {
      clearTimeout(timer);
      socket.close();
      resolve();
    });
    socket.on('message', (msg, rinfo) => {
      if (!targets.includes(rinfo.address) || locations.has(rinfo.address)) return;
      const url = parseSsdpLocation(msg.toString('utf8'), rinfo.address);
      if (url && url.protocol === 'http:') locations.set(rinfo.address, url);
    });
    socket.bind(0, () => {
      targets.forEach((ip, i) => setTimeout(() => socket.send(mSearch('upnp:rootdevice', ip), 1900, ip, () => undefined), i * 5));
    });
  });
  const fetchDescription = opts.fetchDescription ?? defaultFetch;
  const out = new Map<string, UpnpDeviceInfo>();
  const queue = [...locations];
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      for (let item = queue.shift(); item; item = queue.shift()) {
        const [ip, url] = item;
        const xml = await fetchDescription(url).catch(() => undefined);
        if (xml) out.set(ip, parseUpnpDescription(xml));
      }
    }),
  );
  return out;
}

async function defaultFetch(url: URL): Promise<string | undefined> {
  if (url.pathname.includes('..') || url.pathname.length > 200) return undefined;
  const { HttpTransport, ReadOnlyGuard } = await import('../transport.ts');
  const path = url.pathname + url.search;
  const t = new ReadOnlyGuard(new HttpTransport({ baseUrl: url.origin, tls: { mode: 'systeem' }, timeoutMs: 3000, maxBytes: 500_000 }), [
    { method: 'GET', path: new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) },
  ]);
  const res = await t.send({ method: 'GET', path });
  return res.status === 200 ? res.body : undefined;
}
