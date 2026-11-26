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
