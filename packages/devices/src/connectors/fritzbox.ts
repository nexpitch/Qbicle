import { ConnectorError, ReadOnlyGuard, type AllowRule, type HttpResponse, type Transport } from '../transport.ts';
import type { ClientDevice, PortForward, Readout, RouterConnector } from '../types.ts';
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

/**
 * Doorgezette poorten ("Portfreigaben") staan bij de WAN-verbinding: WANIPConnection
 * bij kabel en glasvezel, WANPPPConnection bij DSL. We proberen ze in die volgorde.
 * Alleen lezen: aantal opvragen en dan regel voor regel.
 */
const WAN_SERVICES = [
  { control: '/upnp/control/wanipconnection1', service: 'urn:dslforum-org:service:WANIPConnection:1' },
  { control: '/upnp/control/wanpppconn1', service: 'urn:dslforum-org:service:WANPPPConnection:1' },
] as const;
const MAX_MAPPINGS = 128;

export const FRITZ_RULES: AllowRule[] = [
  { method: 'POST', path: /^\/upnp\/control\/deviceinfo$/, soapActions: /^"?urn:dslforum-org:service:DeviceInfo:1#GetInfo"?$/ },
  { method: 'POST', path: /^\/upnp\/control\/userif$/, soapActions: /^"?urn:dslforum-org:service:UserInterface:1#GetInfo"?$/ },
  { method: 'POST', path: /^\/upnp\/control\/hosts$/, soapActions: /^"?urn:dslforum-org:service:Hosts:1#X_AVM-DE_GetHostListPath"?$/ },
  { method: 'POST', path: /^\/upnp\/control\/wanipconnection1$/, soapActions: /^"?urn:dslforum-org:service:WANIPConnection:1#(GetExternalIPAddress|GetPortMappingNumberOfEntries|GetGenericPortMappingEntry)"?$/ },
  { method: 'POST', path: /^\/upnp\/control\/wanpppconn1$/, soapActions: /^"?urn:dslforum-org:service:WANPPPConnection:1#(GetPortMappingNumberOfEntries|GetGenericPortMappingEntry)"?$/ },
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

  /** @param args alleen vaste, door ons opgebouwde argumenten (getallen), nooit invoer van buiten. */
  private async soap(call: SoapCall, args = ''): Promise<Record<string, string>> {
    const inner = args ? `<u:${call.action} xmlns:u="${call.service}">${args}</u:${call.action}>` : `<u:${call.action} xmlns:u="${call.service}"/>`;
    const body =
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
      `<s:Body>${inner}</s:Body></s:Envelope>`;
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

    const { portForwards, portForwardsRead } = await this.readPortForwards(warnings);

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
      portForwards,
      portForwardsRead,
      warnings,
    };
  }

  private async readPortForwards(warnings: string[]): Promise<{ portForwards: PortForward[]; portForwardsRead: boolean }> {
    for (const wan of WAN_SERVICES) {
      let count: number;
      try {
        count = Number((await this.soap({ ...wan, action: 'GetPortMappingNumberOfEntries' })).NewPortMappingNumberOfEntries);
      } catch (err) {
        if (!(err instanceof ConnectorError) || err.code === 'niet_toegestaan') throw err;
        continue; // Deze WAN-verbinding bestaat niet op dit model; probeer de volgende.
      }
      if (!Number.isInteger(count) || count < 0) break;
      const portForwards: PortForward[] = [];
      try {
        for (let i = 0; i < Math.min(count, MAX_MAPPINGS); i++) {
          const f = await this.soap({ ...wan, action: 'GetGenericPortMappingEntry' }, `<NewPortMappingIndex>${i}</NewPortMappingIndex>`);
          const ext = Number(f.NewExternalPort);
          const int = Number(f.NewInternalPort);
          if (!f.NewInternalClient || !Number.isInteger(ext) || !Number.isInteger(int)) continue;
          portForwards.push({
            protocol: /udp/i.test(f.NewProtocol ?? '') ? 'udp' : 'tcp',
            externalPort: ext,
            internalIp: f.NewInternalClient,
            internalPort: int,
            description: f.NewPortMappingDescription || undefined,
            enabled: f.NewEnabled !== '0',
            // De FRITZ!Box meldt hier zowel eigen Portfreigaben als poorten die apparaten zelf openden.
            origin: 'regel',
            allowedFrom: f.NewRemoteHost ? [f.NewRemoteHost] : undefined,
          });
        }
      } catch (err) {
        if (!(err instanceof ConnectorError) || err.code === 'niet_toegestaan') throw err;
        warnings.push('Doorgezette poorten maar deels uitgelezen');
        return { portForwards, portForwardsRead: false };
      }
      if (count > MAX_MAPPINGS) {
        warnings.push(`Meer dan ${MAX_MAPPINGS} doorgezette poorten; de rest is niet gelezen`);
        return { portForwards, portForwardsRead: false };
      }
      return { portForwards, portForwardsRead: true };
    }
    warnings.push('Doorgezette poorten niet uitgelezen; controleer of de FRITZ!Box-gebruiker de instellingen mag bekijken');
    return { portForwards: [], portForwardsRead: false };
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
