import dgram from 'node:dgram';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeNet } from '../src/net.ts';

/**
 * Een kleine DNS-server op 127.0.0.1 met de echte resolver van Node (c-ares).
 * www.cname.test heeft alleen een CNAME: een SOA-vraag daarop geeft in Node EBADRESP
 * (dat zag Erik bij www.nexpitch.com). kapot.test laat de eerste server falen (SERVFAIL).
 */
type Answer = { type: number; data: Buffer } | 'servfail' | 'nxdomain';

function encodeName(name: string): Buffer {
  return Buffer.concat([...name.split('.').map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)])), Buffer.from([0])]);
}

function startServer(answer: (name: string, qtype: number) => Answer): Promise<{ port: number; close: () => void }> {
  const s = dgram.createSocket('udp4');
  s.on('message', (msg, r) => {
    let i = 12;
    const labels: string[] = [];
    while (msg[i] !== 0) {
      labels.push(msg.subarray(i + 1, i + 1 + msg[i]!).toString());
      i += msg[i]! + 1;
    }
    i += 5;
    const qtype = msg.readUInt16BE(i - 4);
    const a = answer(labels.join('.'), qtype);
    const hdr = Buffer.from(msg.subarray(0, 12));
    const rcode = a === 'servfail' ? 2 : a === 'nxdomain' ? 3 : 0;
    hdr.writeUInt16BE(0x8180 | rcode, 2);
    hdr.writeUInt16BE(1, 4);
    hdr.writeUInt16BE(typeof a === 'object' ? 1 : 0, 6);
    hdr.writeUInt32BE(0, 8);
    const parts: Buffer[] = [hdr, msg.subarray(12, i)];
    if (typeof a === 'object') {
      const rr = Buffer.alloc(12);
      rr.writeUInt16BE(0xc00c, 0);
      rr.writeUInt16BE(a.type, 2);
      rr.writeUInt16BE(1, 4);
      rr.writeUInt32BE(300, 6);
      rr.writeUInt16BE(a.data.length, 10);
      parts.push(rr, a.data);
    }
    s.send(Buffer.concat(parts), r.port, r.address);
  });
  return new Promise((resolve) => s.bind(0, '127.0.0.1', () => resolve({ port: s.address().port, close: () => s.close() })));
}

const CNAME = (target: string): Answer => ({ type: 5, data: encodeName(target) });
const A = (ip: string): Answer => ({ type: 1, data: Buffer.from(ip.split('.').map(Number)) });

describe('DNS-opzoeking met echte resolver', () => {
  let primary: Awaited<ReturnType<typeof startServer>>;
  let backup: Awaited<ReturnType<typeof startServer>>;

  beforeAll(async () => {
    primary = await startServer((name, qtype) => {
      if (name === 'www.cname.test') return CNAME('host.provider.test');
      if (name === 'kapot.test') return 'servfail';
      if (name === 'bestaatniet.test') return 'nxdomain';
      return qtype === 1 ? A('93.184.216.34') : 'nxdomain';
    });
    backup = await startServer((name, qtype) => (name === 'kapot.test' && qtype === 1 ? A('93.184.216.34') : name === 'kapot.test' ? CNAME('x.test') : 'nxdomain'));
  });
  afterAll(() => {
    primary?.close();
    backup?.close();
  });

  const net = (fallback: boolean) =>
    createNodeNet({ dnsServers: [`127.0.0.1:${primary.port}`], fallbackDns: fallback ? [`127.0.0.1:${backup.port}`] : [], dohUrl: 'http://127.0.0.1:9/dns', timeoutMs: 1000 });

  it('naam met alleen een CNAME (zoals www.voorbeeld.nl) bestaat, ook al geeft SOA EBADRESP', async () => {
    expect(await net(false).domainExists('www.cname.test')).toBe(true);
  });

  it('valt terug op een andere resolver als de eerste faalt', async () => {
    expect(await net(true).domainExists('kapot.test')).toBe(true);
    expect(await net(true).resolveAddresses('kapot.test')).toEqual(['93.184.216.34']);
  });

  it('zonder werkende resolver: een DNS-fout, geen "bestaat niet"', async () => {
    await expect(net(false).domainExists('kapot.test')).rejects.toMatchObject({ code: 'ESERVFAIL' });
  });

  it('echt niet-bestaand domein blijft "bestaat niet"', async () => {
    expect(await net(true).domainExists('bestaatniet.test')).toBe(false);
  });
});
