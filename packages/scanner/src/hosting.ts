/**
 * Waar draait de website: een websiteplatform (Wix, Shopify ...), een hostingpartij
 * (TransIP, Strato ...), een eigen server in de cloud (AWS, Hetzner ...), of zit er
 * een beschermlaag (Cloudflare) voor?
 *
 * Alleen uit wat al openbaar is: de CNAME van de websitenaam, de naam bij het IP-adres
 * (PTR) en wat de softwareherkenning al zag. Die namen kiest de partij zelf, dus een
 * herkenning via DNS is "waarschijnlijk"; via de website zelf (Shopify-header) "zeker".
 */

export type HostingSoort = 'platform' | 'beheerde-wordpress' | 'hosting' | 'cloud' | 'statisch' | 'cdn';

export interface HostingInfo {
  naam: string;
  soort: HostingSoort;
  zekerheid: 'zeker' | 'waarschijnlijk';
  /** Waar we het aan zien, in gewone taal. */
  bron: string;
  /** Wat dit betekent: wat de partij doet en wat bij jou of je webbouwer ligt. */
  uitleg: string;
  /** Zit er een beschermlaag voor, dan is de partij erachter vaak niet zichtbaar. */
  achter?: string;
}

/** Herkenbare namen (achtervoegsel van CNAME of PTR) per partij. Alleen namen die de partij zelf publiceert. */
const PARTIJEN: { re: RegExp; naam: string; soort: HostingSoort }[] = [
  { re: /(^|\.)myshopify\.com$/, naam: 'Shopify', soort: 'platform' },
  { re: /(^|\.)(wixdns\.net|wixsite\.com)$/, naam: 'Wix', soort: 'platform' },
  { re: /(^|\.)squarespace\.com$/, naam: 'Squarespace', soort: 'platform' },
  { re: /(^|\.)webflow\.(io|com)$/, naam: 'Webflow', soort: 'platform' },
  { re: /(^|\.)webshopapp\.com$/, naam: 'Lightspeed eCom', soort: 'platform' },
  { re: /(^|\.)(wpengine\.com|wpenginepowered\.com)$/, naam: 'WP Engine', soort: 'beheerde-wordpress' },
  { re: /(^|\.)kinsta\.cloud$/, naam: 'Kinsta', soort: 'beheerde-wordpress' },
  { re: /(^|\.)(netlify\.app|netlify\.com)$/, naam: 'Netlify', soort: 'statisch' },
  { re: /(^|\.)(vercel-dns\.com|vercel\.app)$/, naam: 'Vercel', soort: 'statisch' },
  { re: /(^|\.)github\.io$/, naam: 'GitHub Pages', soort: 'statisch' },
  { re: /(^|\.)cloudfront\.net$/, naam: 'Amazon CloudFront', soort: 'cdn' },
  { re: /(^|\.)azurewebsites\.net$/, naam: 'Microsoft Azure', soort: 'cloud' },
  { re: /(^|\.)amazonaws\.com$/, naam: 'Amazon Web Services', soort: 'cloud' },
  { re: /(^|\.)googleusercontent\.com$/, naam: 'Google Cloud', soort: 'cloud' },
  { re: /(^|\.)(your-server\.de|hetzner\.(com|de|cloud))$/, naam: 'Hetzner', soort: 'cloud' },
  { re: /(^|\.)(ovh\.net|ovh\.ca|ovh\.us)$/, naam: 'OVHcloud', soort: 'cloud' },
  { re: /(^|\.)linode\.com$/, naam: 'Akamai (Linode)', soort: 'cloud' },
  { re: /(^|\.)(leaseweb\.(net|com|nl))$/, naam: 'Leaseweb', soort: 'cloud' },
  { re: /(^|\.)transip\.(nl|net|eu)$/, naam: 'TransIP', soort: 'hosting' },
  { re: /(^|\.)(strato\.(de|nl|com)|stratoserver\.net|rzone\.de)$/, naam: 'Strato', soort: 'hosting' },
  { re: /(^|\.)hostnet\.nl$/, naam: 'Hostnet', soort: 'hosting' },
  { re: /(^|\.)(antagonist\.nl|zxcs\.nl)$/, naam: 'Antagonist', soort: 'hosting' },
  { re: /(^|\.)vimexx\.nl$/, naam: 'Vimexx', soort: 'hosting' },
  { re: /(^|\.)mijndomein\.nl$/, naam: 'Mijndomein', soort: 'hosting' },
  { re: /(^|\.)versio\.nl$/, naam: 'Versio', soort: 'hosting' },
  { re: /(^|\.)argeweb\.nl$/, naam: 'Argeweb', soort: 'hosting' },
  { re: /(^|\.)combell\.(net|com|be)$/, naam: 'Combell', soort: 'hosting' },
  { re: /(^|\.)one\.com$/, naam: 'one.com', soort: 'hosting' },
  { re: /(^|\.)(hostinger\.com|hstgr\.cloud)$/, naam: 'Hostinger', soort: 'hosting' },
  { re: /(^|\.)sgvps\.net$/, naam: 'SiteGround', soort: 'hosting' },
];

const UITLEG: Record<HostingSoort, (n: string) => string> = {
  platform: (n) =>
    `Je website draait op ${n}. ${n} beheert de server, de software en de beveiligingsupdates; daar hoef je niets aan te doen. Wat bij jou (of je webbouwer) ligt: de apps en koppelingen die je toevoegt, wie er mag inloggen (zet tweestapsverificatie aan) en de instellingen van je domein.`,
  'beheerde-wordpress': (n) =>
    `Je website draait bij ${n}, een hostingpartij speciaal voor WordPress. ${n} beheert de server en PHP en werkt WordPress zelf vaak automatisch bij. De plug-ins, het thema en wie er mag inloggen liggen bij jou of je webbouwer.`,
  hosting: (n) =>
    `Je website staat waarschijnlijk bij ${n}. De hostingpartij beheert de server, het besturingssysteem en de webserver. De PHP-versie kies je meestal zelf in het beheerpaneel van ${n}; de website zelf (CMS, plug-ins, thema) ligt bij jou of je webbouwer.`,
  cloud: (n) =>
    `Je website draait op een eigen (virtuele) server bij ${n}. ${n} levert alleen de machine; updates van het besturingssysteem, de webserver en PHP moet je IT-partner of webbouwer zelf regelen. Vraag na wie dat doet.`,
  statisch: (n) =>
    `Je website wordt geleverd door ${n}. ${n} beheert de servers; je webbouwer beheert de code en de scripts die erin zitten.`,
  cdn: (n) => `Er zit een beschermlaag (${n}) voor je website. Welke partij de website daarachter host, is daardoor van buitenaf niet te zien.`,
};

function match(names: string[]): { naam: string; soort: HostingSoort; via: string } | null {
  for (const raw of names) {
    const n = raw.toLowerCase().replace(/\.$/, '');
    const p = PARTIJEN.find((x) => x.re.test(n));
    if (p) return { naam: p.naam, soort: p.soort, via: n };
  }
  return null;
}

export interface HostingSignals {
  cnames: string[];
  ptrs: string[];
  /** Platform of CDN dat de softwareherkenning al zag (bijv. Shopify uit een header). */
  platform?: { naam: string; categorie: 'platform' | 'cdn' } | null;
}

export function detectHosting(sig: HostingSignals): HostingInfo | null {
  const cdn = sig.platform?.categorie === 'cdn' ? sig.platform.naam : undefined;
  if (sig.platform?.categorie === 'platform') {
    return { naam: sig.platform.naam, soort: 'platform', zekerheid: 'zeker', bron: 'kenmerken van het platform in de website zelf', uitleg: UITLEG.platform(sig.platform.naam) };
  }
  const viaCname = match(sig.cnames);
  if (viaCname && viaCname.soort !== 'cdn') {
    return { naam: viaCname.naam, soort: viaCname.soort, zekerheid: 'waarschijnlijk', bron: `de websitenaam verwijst naar ${viaCname.via}`, uitleg: UITLEG[viaCname.soort](viaCname.naam), ...(cdn ? { achter: cdn } : {}) };
  }
  const viaPtr = match(sig.ptrs);
  if (viaPtr && viaPtr.soort !== 'cdn' && !cdn) {
    return { naam: viaPtr.naam, soort: viaPtr.soort, zekerheid: 'waarschijnlijk', bron: `de server heet ${viaPtr.via}`, uitleg: UITLEG[viaPtr.soort](viaPtr.naam) };
  }
  const cdnNaam = cdn ?? (viaCname?.soort === 'cdn' ? viaCname.naam : undefined);
  if (cdnNaam) return { naam: cdnNaam, soort: 'cdn', zekerheid: 'zeker', bron: 'kenmerken van de beschermlaag', uitleg: UITLEG.cdn(cdnNaam) };
  return null;
}
