import type { Category } from '@qbicle/inventory';
import { isRandomizedMac, normalizeMac } from '@qbicle/inventory';
import type { OuiDb } from './oui.ts';
import type { ClientDevice } from './types.ts';

/**
 * Indeling van apparaten in categorieën op basis van wat de router al weet:
 * fabrikant (uit de router of de MAC-prefix), hostnaam, model en aangekondigde diensten.
 *
 * Elke regel geeft punten aan een categorie, met een reden in gewone taal. De
 * categorie met de meeste punten wint, mits boven een drempel. Een indeling is
 * altijd een afleiding ("mogelijk"), nooit een melding van de bron.
 */
export interface Classification {
  category: Category;
  /** "mogelijk" bij een indeling; "onbekend" als er te weinig aanwijzingen zijn. */
  certainty: 'mogelijk' | 'onbekend';
  /** Fabrikant: uit de router, anders uit de MAC-prefix. */
  vendor?: string;
  vendorSource?: 'router' | 'mac-prefix';
  /** Punten van de winnaar (voor uitleg en tests). */
  score: number;
  /** Waarom, in gewone taal. */
  reasons: string[];
}

type Signal = 'fabrikant' | 'hostnaam' | 'model' | 'dienst';

interface Rule {
  category: Category;
  on: Signal[];
  re: RegExp;
  points: number;
  reason: string;
}

/** Drempel: onder dit aantal punten zeggen we "onbekend". */
export const MIN_SCORE = 3;

// Fabrikantnamen zoals het IEEE-register en routers ze schrijven (kleine letters).
const VENDOR_RULES: Rule[] = [
  { category: 'camera', on: ['fabrikant'], re: /hikvision|dahua|axis communications|reolink|ezviz|hanwha|uniview|vivotek|mobotix|foscam|amcrest|arlo|ring llc/, points: 4, reason: 'fabrikant {v} maakt vooral camera\'s' },
  { category: 'printer', on: ['fabrikant'], re: /brother industries|seiko epson|canon inc|xerox|kyocera|ricoh|lexmark|konica minolta|sharp corporation|oki electric|zebra technologies/, points: 4, reason: 'fabrikant {v} maakt vooral printers' },
  { category: 'nas', on: ['fabrikant'], re: /synology|qnap|western digital|buffalo inc|asustor|drobo|terramaster/, points: 4, reason: 'fabrikant {v} maakt vooral NAS-opslag' },
  { category: 'zonnepanelen', on: ['fabrikant'], re: /sma solar|sma regelsysteme|solaredge|fronius|enphase|goodwe|growatt|sungrow|solis|ginlong|huawei.*digital power|kostal|victron|apsystems|hoymiles|sofar/, points: 5, reason: 'fabrikant {v} maakt omvormers voor zonnepanelen' },
  { category: 'laadpaal', on: ['fabrikant'], re: /alfen|easee|zaptec|wallbox|evbox|ev-box|chargepoint|abb e-mobility|webasto|peblar|keba|mennekes|ecoflow/, points: 5, reason: 'fabrikant {v} maakt laadpalen' },
  { category: 'alarmsysteem', on: ['fabrikant'], re: /ajax systems|verisure|risco|paradox|honeywell security|bosch security|texecom|pyronix|jablotron|dsc|climax technology/, points: 5, reason: 'fabrikant {v} maakt alarmsystemen' },
  { category: 'slimme-speaker', on: ['fabrikant'], re: /sonos|bose|harman/, points: 4, reason: 'fabrikant {v} maakt vooral speakers' },
  { category: 'slimme-speaker', on: ['fabrikant'], re: /amazon technologies|amazon\.com/, points: 2, reason: 'fabrikant {v} maakt onder meer Echo-speakers' },
  { category: 'tv-media', on: ['fabrikant'], re: /roku|sony interactive|nintendo|tcl|hisense|vizio|lg electronics|philips tv|tp vision/, points: 3, reason: 'fabrikant {v} maakt vooral tv\'s en media-apparaten' },
  { category: 'iot', on: ['fabrikant'], re: /espressif|tuya|shelly|allterco|signify|philips lighting|tado|nest labs|netatmo|ecobee|sonoff|itead|meross|aqara|lumi united|homewizard|p1 monitor|eneco|quby|toon/, points: 3, reason: 'fabrikant {v} maakt slimme apparaten (IoT)' },
  { category: 'telefoon', on: ['fabrikant'], re: /apple|samsung|xiaomi|oneplus|oppo|vivo mobile|motorola|huawei device|honor device|fairphone|nothing technology|google/, points: 1, reason: 'fabrikant {v} maakt onder meer telefoons' },
  { category: 'laptop', on: ['fabrikant'], re: /intel corporate|lcfc|lenovo|dell|hewlett packard|hp inc|microsoft|asustek|acer|liteon|azurewave|realtek|framework/, points: 1, reason: 'fabrikant {v} maakt onder meer laptops of netwerkkaarten daarvoor' },
  { category: 'server', on: ['fabrikant'], re: /vmware|supermicro|super micro|proxmox|xen/, points: 3, reason: 'fabrikant {v} wijst op een server of virtuele machine' },
  { category: 'server', on: ['fabrikant'], re: /raspberry pi/, points: 3, reason: 'een Raspberry Pi: kleine computer, meestal als server of besturing' },
  { category: 'router', on: ['fabrikant'], re: /routerboard|mikrotik|avm audiovisuelles|draytek|zyxel|fortinet|sophos|watchguard|netgate|sonicwall|juniper|cisco meraki/, points: 2, reason: 'fabrikant {v} maakt netwerkapparatuur' },
  { category: 'accesspoint', on: ['fabrikant'], re: /ubiquiti|tp-link|tp link|aruba|ruckus|cambium|engenius|netgear|cisco/, points: 1, reason: 'fabrikant {v} maakt netwerkapparatuur' },
];

// Hostnamen en modelnamen zoals apparaten ze zelf kiezen.
const NAME_RULES: Rule[] = [
  { category: 'telefoon', on: ['hostnaam', 'model'], re: /iphone|galaxy|android|pixel-?\d|oneplus|redmi|xiaomi|huawei-?p\d|fairphone|^sm-[agsn]\d/, points: 5, reason: '{s} "{x}" klinkt als een telefoon' },
  { category: 'tablet', on: ['hostnaam', 'model'], re: /ipad|galaxy-?tab|^sm-[tx]\d|tablet/, points: 6, reason: '{s} "{x}" klinkt als een tablet' },
  { category: 'laptop', on: ['hostnaam', 'model'], re: /macbook|laptop|notebook|thinkpad|latitude|elitebook|probook|surface|zenbook|vivobook/, points: 5, reason: '{s} "{x}" klinkt als een laptop' },
  { category: 'desktop', on: ['hostnaam', 'model'], re: /^desktop-|imac|mac-?mini|optiplex|^pc-|workstation/, points: 4, reason: '{s} "{x}" klinkt als een pc' },
  { category: 'printer', on: ['hostnaam', 'model'], re: /^br[nw][0-9a-f]{6}|^npi[0-9a-f]{6}|^hp[0-9a-f]{6}|^epson|^canon|^ki?yocera|printer|laserjet|officejet|deskjet|^mfc-|^dcp-|^hl-|^ecosys|^ricoh|^xerox|^et-\d{4}/, points: 5, reason: '{s} "{x}" klinkt als een printer' },
  { category: 'camera', on: ['hostnaam', 'model'], re: /camera|ipcam|^cam-?\d|hikvision|dahua|reolink|^ds-2cd|^ipc-|doorbell|deurbel|ezviz|^axis-|tapo-?c\d/, points: 5, reason: '{s} "{x}" klinkt als een camera' },
  { category: 'slimme-speaker', on: ['hostnaam', 'model'], re: /echo|alexa|google-?home|nest-?(mini|audio|hub)|homepod|sonos|bose|speaker/, points: 5, reason: '{s} "{x}" klinkt als een slimme speaker' },
  { category: 'tv-media', on: ['hostnaam', 'model'], re: /chromecast|apple-?tv|appletv|roku|fire-?tv|firetv|smart-?tv|bravia|webos|-tv$|^tv-|^lgwebos|playstation|^ps[45]-|xbox|nintendo|switch-console|shield/, points: 5, reason: '{s} "{x}" klinkt als een tv of media-apparaat' },
  { category: 'nas', on: ['hostnaam', 'model'], re: /diskstation|synology|qnap|^nas\b|^nas-|-nas$|truenas|unraid|mycloud/, points: 5, reason: '{s} "{x}" klinkt als een NAS' },
  { category: 'zonnepanelen', on: ['hostnaam', 'model'], re: /^sma\d|sunny-?(boy|tripower)|solaredge|fronius|envoy|enphase|growatt|goodwe|sungrow|sun2000|omvormer|inverter|solarman|hoymiles|^dtu-/, points: 6, reason: '{s} "{x}" klinkt als een omvormer van zonnepanelen' },
  { category: 'laadpaal', on: ['hostnaam', 'model'], re: /easee|alfen|zaptec|wallbox|evbox|laadpaal|charger|chargepoint|peblar|^eve-/, points: 6, reason: '{s} "{x}" klinkt als een laadpaal' },
  { category: 'alarmsysteem', on: ['hostnaam', 'model'], re: /ajax|alarm|verisure|risco|paradox|jablotron|texecom|hub-?2/, points: 6, reason: '{s} "{x}" klinkt als een alarmsysteem' },
  { category: 'iot', on: ['hostnaam', 'model'], re: /shelly|tasmota|^esp[-_]|espressif|sonoff|tuya|^hue|philips-hue|tado|nest-?therm|netatmo|^toon|homewizard|^p1|smartplug|^wled|meross|zigbee|thermostat|thermostaat/, points: 5, reason: '{s} "{x}" klinkt als een slim apparaat (IoT)' },
  { category: 'server', on: ['hostnaam', 'model'], re: /^srv|server|^dc\d|^esx|proxmox|hyper-?v|^vm-/, points: 4, reason: '{s} "{x}" klinkt als een server' },
];

const SERVICE_RULES: Rule[] = [
  { category: 'printer', on: ['dienst'], re: /^_(ipp|ipps|printer|pdl-datastream|uscan|scanner)\._tcp$/, points: 6, reason: 'kondigt printdienst {x} aan' },
  { category: 'camera', on: ['dienst'], re: /^_(rtsp|onvif)\._(tcp|udp)$/, points: 5, reason: 'kondigt videostream {x} aan' },
  { category: 'slimme-speaker', on: ['dienst'], re: /^_(sonos|amzn-alexa|alexa|spotify-connect)\._tcp$/, points: 5, reason: 'kondigt audiodienst {x} aan' },
  { category: 'tv-media', on: ['dienst'], re: /^_(airplay|googlecast|androidtvremote2?|mediaremotetv)\._tcp$/, points: 4, reason: 'kondigt mediadienst {x} aan' },
  { category: 'slimme-speaker', on: ['dienst'], re: /^_raop\._tcp$/, points: 2, reason: 'kondigt AirPlay-audio aan' },
  { category: 'nas', on: ['dienst'], re: /^_(afpovertcp|nfs|adisk)\._tcp$/, points: 3, reason: 'kondigt bestandsdeling {x} aan' },
  { category: 'iot', on: ['dienst'], re: /^_(hap|homekit|matter|matterc|shelly|hue|esphomelib)\._(tcp|udp)$/, points: 4, reason: 'kondigt slimme-huisdienst {x} aan' },
];

export interface ClassifyInput {
  mac?: string;
  hostname?: string;
  vendor?: string;
  model?: string;
  services?: string[];
}

export function classifyClient(c: ClassifyInput | ClientDevice, oui: OuiDb): Classification {
  const mac = c.mac ? normalizeMac(c.mac) : undefined;
  const ouiVendor = mac ? oui.lookup(mac) : undefined;
  const vendor = c.vendor ?? ouiVendor;
  const vendorSource = c.vendor ? 'router' : ouiVendor ? 'mac-prefix' : undefined;
  const host = (c.hostname ?? '').trim().toLowerCase().replace(/\.local\.?$/, '').replace(/[\s_.'’]+/g, '-');
  const model = (c.model ?? '').trim().toLowerCase().replace(/\s+/g, '-');

  const points = new Map<Category, number>();
  const reasons = new Map<Category, string[]>();
  const add = (cat: Category, p: number, reason: string) => {
    points.set(cat, (points.get(cat) ?? 0) + p);
    reasons.set(cat, [...(reasons.get(cat) ?? []), reason]);
  };

  if (vendor) {
    const v = vendor.toLowerCase();
    for (const r of VENDOR_RULES) if (r.re.test(v)) add(r.category, r.points, r.reason.replace('{v}', shortVendor(vendor)));
  }
  for (const [signal, value] of [['hostnaam', host], ['model', model]] as const) {
    if (!value) continue;
    for (const r of NAME_RULES) {
      if (r.on.includes(signal) && r.re.test(value)) add(r.category, r.points, r.reason.replace('{s}', signal === 'hostnaam' ? 'Hostnaam' : 'Model').replace('{x}', signal === 'hostnaam' ? c.hostname! : c.model!));
    }
  }
  for (const s of c.services ?? []) {
    for (const r of SERVICE_RULES) if (r.re.test(s)) add(r.category, r.points, r.reason.replace('{x}', s));
  }
  // Een willekeurig MAC-adres gebruiken vooral telefoons, tablets en laptops (privacy-adres per wifi-netwerk).
  if (mac && isRandomizedMac(mac)) add('telefoon', 2, 'gebruikt een privacy-MAC-adres, zoals telefoons doen');

  let best: Category = 'onbekend';
  let bestScore = 0;
  for (const [cat, p] of points) {
    if (p > bestScore || (p === bestScore && cat < best)) {
      best = cat;
      bestScore = p;
    }
  }
  if (bestScore < MIN_SCORE) {
    return { category: 'onbekend', certainty: 'onbekend', vendor, vendorSource, score: bestScore, reasons: [...(reasons.get(best) ?? [])] };
  }
  return { category: best, certainty: 'mogelijk', vendor, vendorSource, score: bestScore, reasons: reasons.get(best) ?? [] };
}

/** "Hangzhou Hikvision Digital Technology Co.,Ltd." wordt "Hikvision". */
export function shortVendor(org: string): string {
  const known: Array<[RegExp, string]> = [
    [/hikvision/i, 'Hikvision'],
    [/dahua/i, 'Dahua'],
    [/routerboard|mikrotik/i, 'MikroTik'],
    [/avm audiovisuelles/i, 'AVM'],
    [/seiko epson/i, 'Epson'],
    [/brother/i, 'Brother'],
    [/sma solar|sma regelsysteme/i, 'SMA'],
    [/espressif/i, 'Espressif'],
    [/signify|philips lighting/i, 'Philips Hue (Signify)'],
    [/allterco|shelly/i, 'Shelly'],
    [/lcfc/i, 'Lenovo'],
    [/amazon/i, 'Amazon'],
    [/apple/i, 'Apple'],
    [/samsung/i, 'Samsung'],
    [/google/i, 'Google'],
    [/ubiquiti/i, 'Ubiquiti'],
  ];
  for (const [re, name] of known) if (re.test(org)) return name;
  return org.replace(/[,.]?\s*(co\.?,?\s*ltd\.?|inc\.?|gmbh|ag|b\.?v\.?|corporation|corp\.?|limited|llc|as|ab|s\.?a\.?)\.?$/i, '').trim();
}
