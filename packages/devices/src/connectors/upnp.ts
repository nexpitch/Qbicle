import { ConnectorError, ReadOnlyGuard, type AllowRule, type Transport } from '../transport.ts';
import { identifyProviderModem } from '../providers.ts';
import type { PortForward, Readout, RouterConnector } from '../types.ts';
import { isPublicIpv4, xmlBlocks, xmlFields } from './util.ts';

/**
 * Router of providermodem via UPnP IGD (Internet Gateway Device), zonder inloggen.
 *
 * Bijna elk providermodem (KPN, Ziggo, Odido) en veel thuisrouters spreken UPnP. Zonder
 * beheerdersgegevens van de provider lezen we zo:
 * - fabrikant, model en naam uit de apparaatbeschrijving (rootDesc.xml),
 * - het internetadres (GetExternalIPAddress),
 * - de poorten die apparaten zelf via UPnP hebben opengezet (GetGenericPortMappingEntry).
 *
 * Alleen de standaard leesacties, alleen naar de gateway van het eigen netwerk. Het
 * adres van de beschrijving komt uit de SSDP-aankondiging die de lokale connector
 * hoort, of uit de configuratie. Poorten die de provider of een beheerder handmatig
 * heeft doorgezet zijn zo niet zichtbaar; daarvoor is de buitenkant nodig (stap 2).
 */
const READ_ACTIONS = /^"?urn:schemas-upnp-org:service:WAN(IP|PPP)Connection:[12]#(GetExternalIPAddress|GetGenericPortMappingEntry)"?$/;

export const UPNP_RULES: AllowRule[] = [
  { method: 'GET', path: /^\/[\w./-]{1,100}\.xml$/ },
  { method: 'POST', path: /^\/[\w./-]{1,100}$/, soapActions: READ_ACTIONS },
];

const MAX_MAPPINGS = 128;

export class UpnpIgdConnector implements RouterConnector {
  readonly product = 'upnp' as const;
  private readonly t: Transport;

  constructor(
    transport: Transport,
    private readonly opts: { descriptionPath: string; now?: () => Date; wanAsn?: number },
  ) {
    if (!/^\/[\w./-]{1,100}\.xml$/.test(opts.descriptionPath) || opts.descriptionPath.includes('..')) {
      throw new ConnectorError('niet_toegestaan', 'Ongeldig pad voor de UPnP-beschrijving');
    }
    this.t = new ReadOnlyGuard(transport, UPNP_RULES);
  }

  async read(): Promise<Readout> {
    const readAt = (this.opts.now?.() ?? new Date()).toISOString();
    const warnings: string[] = [];
    const desc = await this.t.send({ method: 'GET', path: this.opts.descriptionPath });
    if (desc.status !== 200) throw new ConnectorError('antwoord_onbekend', `UPnP-beschrijving: onverwacht antwoord (${desc.status})`);
    const root = xmlFields(xmlBlocks(desc.body, 'device')[0]?.split('<deviceList>')[0] ?? '');

    // Zoek de WAN-verbinding (IP of PPP) en haar controle-URL.
    const service = xmlBlocks(desc.body, 'service')
      .map(xmlFields)
      .find((s) => /WAN(IP|PPP)Connection/.test(s.serviceType ?? ''));
    const wanIps: string[] = [];
    const portForwards: PortForward[] = [];
    let privateWanIp: string | undefined;
    let portForwardsRead = false;
    if (!service?.controlURL || !service.serviceType) {
      warnings.push('Geen WAN-verbinding in de UPnP-beschrijving; mogelijk staat UPnP voor internet uit');
    } else {
      const control = new URL(service.controlURL, 'http://x').pathname;
      if (control.includes('..')) throw new ConnectorError('niet_toegestaan', 'Ongeldige controle-URL');
      const call = async (action: string, args = '') => {
        const res = await this.t.send({
          method: 'POST',
          path: control,
          headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPAction: `"${service.serviceType}#${action}"` },
          body:
            '<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
            `<s:Body><u:${action} xmlns:u="${service.serviceType}">${args}</u:${action}></s:Body></s:Envelope>`,
        });
        return { status: res.status, fields: xmlFields(res.body) };
      };

      const ip = await call('GetExternalIPAddress');
      const ext = ip.fields.NewExternalIPAddress;
      if (ip.status === 200 && ext && isPublicIpv4(ext)) wanIps.push(ext);
      else if (ip.status === 200 && ext) privateWanIp = ext;

      for (let i = 0; i < MAX_MAPPINGS; i++) {
        const r = await call('GetGenericPortMappingEntry', `<NewPortMappingIndex>${i}</NewPortMappingIndex>`);
        if (r.status !== 200) {
          // 713 SpecifiedArrayIndexInvalid (of 714 NoSuchEntryInArray): einde van de lijst.
          // Elke andere fout (bijvoorbeeld 401 of 606) betekent: niet uitgelezen.
          if (/^71[34]$/.test(r.fields.errorCode ?? '')) portForwardsRead = true;
          else warnings.push('Doorgezette poorten niet uitgelezen: het modem gaf een fout');
          break;
        }
        const f = r.fields;
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
          origin: 'upnp',
        });
        if (i === MAX_MAPPINGS - 1) warnings.push(`Meer dan ${MAX_MAPPINGS} UPnP-poorten; de rest is niet gelezen`);
      }
    }

    const model = [root.modelName, root.modelNumber].filter(Boolean).join(' ') || undefined;
    const guess = identifyProviderModem({ model, friendlyName: root.friendlyName, vendor: root.manufacturer, wanAsn: this.opts.wanAsn });
    return {
      product: 'upnp',
      readAt,
      devices: [
        {
          role: 'router',
          vendor: root.manufacturer ?? 'onbekend',
          model,
          name: root.friendlyName,
          serial: root.serialNumber || undefined,
          // Firmware staat zelden in de UPnP-beschrijving; bij providermodems beheert de provider die.
          provider: guess?.provider,
        },
      ],
      clients: [],
      wanIps,
      privateWanIp,
      portForwards,
      portForwardsRead,
      upnpEnabled: Boolean(service),
      warnings: [
        ...warnings,
        ...(guess?.provider ? [`Providermodem van ${guess.provider}: firmware en instellingen beheert de provider`] : []),
        'Apparaten achter dit modem komen uit de ARP/DHCP/mDNS-tabellen van de connector, niet uit het modem zelf',
      ],
    };
  }
}
