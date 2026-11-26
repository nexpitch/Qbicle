import { isRandomizedMac, normalizeMac } from '@qbicle/inventory';
import { pseudonymizeMac } from './secrets.ts';

/**
 * AVG: zo min mogelijk persoonsgegevens (ontwerp, hoofdstuk Privacy).
 *
 * Wat een router meldt bevat vaak persoonsgegevens: hostnamen als "LAPTOP-ERIK"
 * of "iPhone-van-Sanne", en MAC-adressen van telefoons van gasten. Regels:
 *
 * 1. Een hostnaam die een naam lijkt te bevatten bewaren we niet. We tonen een
 *    gemaskeerde versie ("iPhone-van-…"). De indeling in een categorie gebeurt
 *    vóór het maskeren, in het geheugen.
 * 2. Gastapparaten: MAC-adres alleen gepseudonimiseerd (HMAC per organisatie),
 *    of helemaal niet als het een willekeurig privacy-adres is.
 * 3. Fabrikant en categorie mogen blijven: die zeggen iets over het apparaat,
 *    niet over de persoon.
 *
 * Lijkt iets op een naam terwijl het een merk is, dan maskeren we liever te veel
 * dan te weinig.
 */
const DEVICE_WORDS = new Set(
  (
    'mac macbook macbookpro macbookair imac deco tapo kasa repeater extender versterker mesh bosch siemens neff gaggenau miele dishwasher oven washer dryer vaatwasser wasmachine droger koelkast fridge roborock vacuum roomba sonos sonoszp sonosone black white lgwebostv webos lg espressif ajax ajaxcamera wlan lwip device vacuum camera tv dyson philips hue tado nest ring shelly tuya esp chromecast airport time capsule homepod apple samsung xiaomi huawei roku synology qnap brother epson canon hp kpn ziggo odido box iphone ipad ipod galaxy android pixel macbook pro air max mini plus ultra note tab watch laptop desktop pc tablet phone ' +
    'telefoon van de het den der of s my mijn the and en kantoor office keuken woonkamer hal gang receptie vergaderruimte ' +
    'boven beneden werkplaats magazijn kantine zolder garage local lan home thinkpad surface xps latitude elitebook probook ' +
    'zenbook vivobook chromecast apple samsung xiaomi redmi oneplus huawei google amazon fire stick kindle playstation xbox ' +
    'nintendo switch roku homepod easee alfen zaptec wallbox evbox shelly tasmota sonoff tado hue philips envoy fronius ' +
    'solaredge growatt goodwe sungrow ajax verisure synology diskstation qnap reolink hikvision dahua ezviz epson canon ' +
    'brother hp kyocera ricoh xerox bose alexa echo dot sonos meross netatmo toon homewizard raspberrypi raspberry pi ubuntu ' +
    'debian windows linux unifi fritz box mikrotik router ap gateway wifi repeater mesh camera cam doorbell deurbel gast guest ' +
    'kassa pin pinautomaat scanner beamer projector speaker tv smart lamp plug stekker thermostaat thermostat alarm hub bridge ' +
    'nvr dvr inverter omvormer laadpaal charger esp wled assistant homeassistant octoprint pihole nuc mac macmini imac studio ' +
    'laserjet officejet deskjet envy mfc dcp workstation srv server dc vm nas printer lenovo dell asus acer msi intel realtek ' +
    'nest audio display lg sony bravia webos tizen firetv appletv shield sma sunny boy tripower toshiba sharp panasonic ' +
    'kodi plex docker proxmox esxi unraid truenas mycloud wd ingang uitgang entree voordeur achterdeur poort parkeerplaats ' +
    'buiten binnen tuin dak hoofd vergader balie showroom winkel atelier lab serverruimte meterkast'
  ).split(' '),
);

/** Lijkt deze hostnaam een naam van een persoon te bevatten? */
export function looksPersonal(hostname: string): boolean {
  return personalTokens(hostname).length > 0;
}

function tokens(hostname: string): string[] {
  return hostname.replace(/\.local\.?$/i, '').split(/[-_.\s'’]+/).filter(Boolean);
}

function personalTokens(hostname: string): string[] {
  return tokens(hostname).filter((t) => {
    const w = t.toLowerCase();
    if (!/^[a-zà-ÿ]+$/i.test(w)) return false; // cijfers of hex: serienummer, model of willekeurig
    if (w.length < 3) return false;
    return !DEVICE_WORDS.has(w);
  });
}

/** "iPhone-van-Erik" wordt "iPhone-van-…", "LAPTOP-ERIK" wordt "LAPTOP-…". */
export function maskHostname(hostname: string): string {
  const personal = new Set(personalTokens(hostname));
  if (personal.size === 0) return hostname;
  let out = hostname.replace(/\.local\.?$/i, '');
  for (const t of personal) out = out.replace(new RegExp(`(^|[-_.\\s'’])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[-_.\\s'’])`, 'g'), '$1…');
  return out.replace(/['’]s(?=$|[-_.\s])/g, '');
}

export interface PrivacyPolicy {
  /** Hostnamen die een naam lijken niet bewaren. Standaard aan. */
  dropPersonalHostnames: boolean;
  /** MAC-adressen van gastapparaten pseudonimiseren. Standaard aan; vereist pseudonymKey. */
  pseudonymizeGuests: boolean;
  /** Sleutel per organisatie, zie orgPseudonymKey. */
  pseudonymKey?: Buffer;
}

export const DEFAULT_PRIVACY: Omit<PrivacyPolicy, 'pseudonymKey'> = {
  dropPersonalHostnames: true,
  pseudonymizeGuests: true,
};

export interface MinimizedClient {
  mac?: string;
  macHash?: string;
  /** Alleen als hij geen naam lijkt te bevatten (of het beleid dat toestaat). */
  hostname?: string;
  /** Wat we tonen: hostnaam of de gemaskeerde versie. */
  displayName?: string;
}

export function minimizeClient(c: { mac?: string; hostname?: string; guest?: boolean }, policy: PrivacyPolicy): MinimizedClient {
  const out: MinimizedClient = {};
  const mac = c.mac ? normalizeMac(c.mac) : undefined;
  if (mac) {
    if (c.guest && policy.pseudonymizeGuests) {
      if (!policy.pseudonymKey) throw new Error('Pseudonimiseren van gastapparaten vraagt om een sleutel per organisatie');
      // Een willekeurig privacy-adres wisselt toch; dat bewaren we helemaal niet.
      if (!isRandomizedMac(mac)) out.macHash = pseudonymizeMac(mac, policy.pseudonymKey);
    } else out.mac = mac;
  }
  if (c.hostname) {
    const personal = looksPersonal(c.hostname);
    if (!personal || !policy.dropPersonalHostnames) {
      // Gasthostnamen bewaren we nooit als identifier: die zeggen niets over het bedrijf.
      if (!c.guest) out.hostname = c.hostname;
      out.displayName = c.guest && personal ? maskHostname(c.hostname) : c.hostname;
    } else out.displayName = maskHostname(c.hostname);
  }
  return out;
}
