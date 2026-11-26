import { ConnectorError, ReadOnlyGuard, type AllowRule, type HttpResponse, type Transport } from '../transport.ts';
import type { ClientDevice, Readout, RouterConnector } from '../types.ts';
import { isPublicIpv4, xmlBlocks, xmlFields } from './util.ts';

/**
 * AVM FRITZ!Box via TR-064 (SOAP), op het lokale netwerk (https-poort 49443).
 * Inloggen met een eigen FRITZ!Box-gebruiker; Digest-authenticatie.
 * Alleen leesacties uit een vaste lijst. Bereikbaar via de lokale connector,
 * niet vanuit de cloud.
 */
interface SoapCall {
  control: string;
  service: string;
  action: string;
}

const CALLS = {
  deviceInfo: { control: '/upnp/control/deviceinfo', service: 'urn:dslforum-org:service:DeviceInfo:1', action: 'GetInfo' },
  userIf: { control: '/upnp/control/userif', service: 'urn:dslforum-org:service:UserInterface:1', action: 'GetInfo' },
  hostListPath: { control: '/upnp/control/hosts', service: 'urn:dslforum-org:service:Hosts:1', action: 'X_AVM-DE_GetHostListPath' },
  externalIp: { control: '/upnp/control/wanipconnection1', service: 'urn:dslforum-org:service:WANIPConnection:1', action: 'GetExternalIPAddress' },
} satisfies Record<string, SoapCall>;

export const FRITZ_RULES: AllowRule[] = [
  { method: 'POST', path: /^\/upnp\/control\/deviceinfo$/, soapActions: /^"?urn:dslforum-org:service:DeviceInfo:1#GetInfo"?$/ },
  { method: 'POST', path: /^\/upnp\/control\/userif$/, soapActions: /^"?urn:dslforum-org:service:UserInterface:1#GetInfo"?$/ },
  { method: 'POST', path: /^\/upnp\/control\/hosts$/, soapActions: /^"?urn:dslforum-org:service:Hosts:1#X_AVM-DE_GetHostListPath"?$/ },
  { method: 'POST', path: /^\/upnp\/control\/wanipconnection1$/, soapActions: /^"?urn:dslforum-org:service:WANIPConnection:1#GetExternalIPAddress"?$/ },
  { method: 'GET', path: /^\/devicehostlist\.lua\?sid=[0-9a-f]{16}$/ },
];

export class FritzboxConnector implements RouterConnector {
  readonly product = 'fritzbox' as const;
  private readonly t: Transport;

  constructor(
    transport: Transport,
    private readonly opts: { now?: () => Date } = {},
  ) {
    this.t = new ReadOnlyGuard(transport, FRITZ_RULES);
  }

  private async soap(call: SoapCall): Promise<Record<string, string>> {
    const body =
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
      `<s:Body><u:${call.action} xmlns:u="${call.service}"/></s:Body></s:Envelope>`;
    const res = await this.t.send({
      method: 'POST',
      path: call.control,
      headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPAction: `"${call.service}#${call.action}"` },
      body,
    });
    return parseSoap(res, call.action);
  }

  async read(): Promise<Readout> {
    const readAt = (this.opts.now?.() ?? new Date()).toISOString();
    const warnings: string[] = [];
    const info = await this.soap(CALLS.deviceInfo);

    let updateAvailable: boolean | undefined;
    try {
      const ui = await this.soap(CALLS.userIf);
      updateAvailable = ui.NewUpgradeAvailable === '1' ? true : ui.NewUpgradeAvailable === '0' ? false : undefined;
    } catch (err) {
      if (!(err instanceof ConnectorError) || err.code === 'niet_toegestaan') throw err;
      warnings.push('Niet vastgesteld of er een FRITZ!OS-update klaarstaat');
    }

    const wanIps: string[] = [];
    try {
      const ip = (await this.soap(CALLS.externalIp)).NewExternalIPAddress;
      if (ip && isPublicIpv4(ip)) wanIps.push(ip);
      else if (ip) warnings.push('Het internetadres is geen publiek IPv4-adres (bijvoorbeeld CGNAT of DS-Lite)');
    } catch (err) {
      if (!(err instanceof ConnectorError) || err.code === 'niet_toegestaan') throw err;
      warnings.push('Internetadres niet uitgelezen');
    }

    const path = (await this.soap(CALLS.hostListPath))['NewX_AVM-DE_HostListPath'];
    if (!path || !/^\/devicehostlist\.lua\?sid=[0-9a-f]{16}$/.test(path)) throw new ConnectorError('antwoord_onbekend', 'Onverwacht pad voor de apparatenlijst');
    const list = await this.t.send({ method: 'GET', path });
    if (list.status !== 200) throw new ConnectorError('antwoord_onbekend', `Apparatenlijst: onverwacht antwoord (${list.status})`);
    const clients: ClientDevice[] = xmlBlocks(list.body, 'Item').map((item) => {
      const f = xmlFields(item);
      return {
        mac: f.MACAddress || undefined,
        ip: f.IPAddress || undefined,
        hostname: f.HostName || undefined,
        connection: /802\.11/.test(f.InterfaceType ?? '') ? 'draadloos' : /ethernet/i.test(f.InterfaceType ?? '') ? 'bekabeld' : undefined,
        guest: f['X_AVM-DE_Guest'] === '1',
        active: f.Active === '1',
        model: f['X_AVM-DE_Model'] || undefined,
      } satisfies ClientDevice;
    });

    return {
      product: 'fritzbox',
      readAt,
      devices: [
        {
          role: 'router',
          vendor: 'AVM',
          model: info.NewModelName,
          serial: info.NewSerialNumber,
          firmware: info.NewSoftwareVersion,
          firmwareProduct: 'FRITZ!OS',
          updateAvailable,
        },
      ],
      clients,
      wanIps,
      warnings,
    };
  }
}

function parseSoap(res: HttpResponse, action: string): Record<string, string> {
  if (res.status !== 200) {
    const fault = xmlFields(res.body);
    throw new ConnectorError('antwoord_onbekend', `${action}: fout van de FRITZ!Box (${fault.errorCode ?? res.status})`);
  }
  const m = res.body.match(new RegExp(`<u:${action}Response[^>]*>([\\s\\S]*?)</u:${action}Response>`));
  if (!m) throw new ConnectorError('antwoord_onbekend', `${action}: onverwacht antwoord`);
  return xmlFields(m[1]!);
}

/**
 * FRITZ!OS-versie uit NewSoftwareVersion: "164.07.57" betekent FRITZ!OS 7.57
 * op hardware 164. Geeft "7.57" terug.
 */
export function fritzOsVersion(raw: string | undefined): string | undefined {
  const m = raw?.match(/^\d+\.(\d{2})\.(\d{2})(?:-\d+)?$/);
  if (!m) return undefined;
  return `${Number(m[1])}.${m[2]}`;
}
