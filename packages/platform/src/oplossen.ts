import type { ForWho } from '@qbicle/score';

/**
 * "Zo los je het op": per bevinding een stap-voor-stapuitleg die een leek zelf
 * kan volgen, met de exacte waarde om te kopiëren.
 *
 * Uitgangspunten (zie ook de validatie van de scanbevindingen):
 * - We geven alleen een kant-en-klare waarde als die veilig is voor iedereen met
 *   deze bevinding. Kan een waarde mail of de website breken als de aanname niet
 *   klopt, dan staat er een voorwaarde bij die de klant eerst bevestigt, of we
 *   geven een voorbeeld en laten het de leverancier nagaan.
 * - DMARC begint altijd in de meekijkstand (p=none). Strenger zetten pas als de
 *   rapporten laten zien dat alle echte mail goed gaat.
 * - "Weigeren" (SPF -all, DMARC p=reject) alleen voor een domein waarvan de
 *   klant bevestigt dat er geen mail vanaf gaat. Geen MX is daar geen bewijs voor.
 * - SPF, DMARC, CAA en DNSSEC horen bij het hoofddomein (de zone), niet blind bij
 *   de naam van het asset. Op een naam met een CNAME (vaak www) kan geen TXT staan.
 * - Bestaande regels nooit stilzwijgend vervangen: bij "aanpassen" tonen we wat er
 *   verandert (van → naar) en laten we de rest staan.
 */

/** Soort ingreep; bepaalt het icoon en de korte uitleg erbij. */
export type Ingreep = 'dns-toevoegen' | 'dns-aanpassen' | 'instelling' | 'bijwerken' | 'bestand' | 'aanvragen';

export const INGREPEN: Record<Ingreep, { label: string; uitleg: string }> = {
  'dns-toevoegen': { label: 'DNS-regel toevoegen', uitleg: 'Je voegt één regel toe in het DNS-beheer van je domein. Er gaat niets weg.' },
  'dns-aanpassen': { label: 'DNS-regel aanpassen', uitleg: 'Je past een regel aan die er al staat. Verander alleen het deel dat hieronder staat.' },
  instelling: { label: 'Instelling aanzetten', uitleg: 'Je zet een instelling aan in het beheerscherm, meestal één schakelaar.' },
  bijwerken: { label: 'Software bijwerken', uitleg: 'Je installeert een update van de leverancier.' },
  bestand: { label: 'Bestand op je website zetten', uitleg: 'Je zet één klein tekstbestand op je website.' },
  aanvragen: { label: 'Bij je leverancier aanvragen', uitleg: 'Dit kun je niet zelf instellen. Stuur het door naar wie het voor je beheert.' },
};

export interface DnsRegel {
  type: 'TXT' | 'CAA';
  /** Volledige naam, bijvoorbeeld _dmarc.voorbeeld.nl. */
  naam: string;
  /** Korte naam voor partijen die het domein zelf aanvullen: @ voor het domein zelf. */
  kort: string;
  waarde: string;
  /** true: alleen een voorbeeld, de klant moet de waarde laten nagaan. */
  voorbeeld?: boolean;
}

/** Een wijziging in een bestaande regel: we tonen alleen wat er verandert. */
export interface Wijziging {
  waar: string;
  van: string;
  naar: string;
}

export interface WebHeader {
  naam: string;
  waarde: string;
  uitleg: string;
}

export interface OplosGids {
  ingreep: Ingreep;
  /** Wie dit kan doen. Bij DNS-regels ook de klant zelf, als die kan inloggen bij het DNS-beheer. */
  wie: ForWho;
  wieTekst: string;
  /** Inschatting, in gewone taal. */
  duur: string;
  stappen: string[];
  regels: DnsRegel[];
  wijzigingen: Wijziging[];
  headers: WebHeader[];
  bestand: { pad: string; inhoud: string } | null;
  /** Moet de klant eerst bevestigen voordat hij de waarden ziet. */
  voorwaarde: string | null;
  waarschuwingen: string[];
  /** Na de wijziging: hoe snel een hercontrole zin heeft. */
  wachten: string;
  /** Waar de klant inlogt (als de DNS-partij bekend is). */
  inlog: { naam: string; url: string } | null;
  /** Tekst om door te sturen naar IT-partner of webbouwer. */
  doorsturen: string;
}

export interface OplosContext {
  /** Naam van het asset met de bevinding (domein, subdomein of host van de website). */
  naam: string;
  /** Hoofddomein waar de DNS staat (uit de naamservers), of null als onbekend. */
  zone: string | null;
  /** Partij van het DNS-beheer, als we die herkennen. */
  dns: { id: string; naam: string; inlog: string; stappen: string[] } | null;
  /** Mailpartij uit de MX-records, als we die herkennen. */
  mail: { id: string; naam: string } | null;
  /** Titel van de actie (voor de doorstuurtekst). */
  titel: string;
  now?: Date;
}

/** SPF-onderdeel per mailpartij. Alleen partijen waarvan we het zeker weten. */
export const SPF_INCLUDE: Record<string, string> = {
  microsoft: 'spf.protection.outlook.com',
  google: '_spf.google.com',
};

const DNS_WACHTEN = 'Een DNS-wijziging is meestal binnen een paar minuten zichtbaar, soms pas na een uur. Lukt de controle niet meteen, probeer het later nog eens.';
const WEB_WACHTEN = 'Zodra de wijziging op de website staat, kun je meteen laten controleren.';

/** Korte naam ten opzichte van de zone: "@" voor de zone zelf, anders het deel ervoor. */
export function korteNaam(naam: string, zone: string | null): string {
  if (!zone) return naam;
  if (naam === zone) return '@';
  return naam.endsWith(`.${zone}`) ? naam.slice(0, -(zone.length + 1)) : naam;
}

function hoofd(ctx: OplosContext): string {
  return ctx.zone ?? ctx.naam;
}

function subdomeinNotitie(ctx: OplosContext, wat: string): string[] {
  if (!ctx.zone || ctx.naam === ctx.zone || !ctx.naam.endsWith(`.${ctx.zone}`)) return [];
  return [`${ctx.naam} is een subdomein. ${wat} stel je in op het hoofddomein ${ctx.zone}; dat geldt dan ook voor ${ctx.naam}.`];
}

/** De stappen om in te loggen en een regel toe te voegen, met de partij erbij als we die kennen. */
function dnsStappen(ctx: OplosContext, type: string, aanpassen = false): string[] {
  const laatste = aanpassen
    ? `Zoek de bestaande regel van type ${type} en pas alleen het deel aan dat hieronder staat. Sla op.`
    : `Kies type ${type} en vul de naam en waarde hieronder in. Sla op.`;
  if (ctx.dns && ctx.dns.stappen.length > 1) {
    // De laatste stap in de partijlijst gaat over de TXT-regel voor domeinbevestiging; die vervangen we.
    return [...ctx.dns.stappen.slice(0, -1), laatste];
  }
  return [
    'Log in bij de partij waar je domein staat (vaak je hostingpartij of de partij waar je de domeinnaam hebt gekocht).',
    'Kies je domein en zoek naar DNS, DNS-beheer of DNS-instellingen.',
    ...(aanpassen ? [] : ['Klik op Toevoegen of Nieuw record.']),
    laatste,
  ];
}

function zelfOfIt(ctx: OplosContext): string {
  return ctx.dns
    ? `Kun je zelf als je kunt inloggen bij ${ctx.dns.naam}. Anders stuur je het door naar je IT-partner.`
    : 'Kun je zelf als je kunt inloggen bij het DNS-beheer van je domein. Anders stuur je het door naar je IT-partner.';
}

type Gids = Omit<OplosGids, 'doorsturen' | 'inlog' | 'regels' | 'wijzigingen' | 'headers' | 'bestand' | 'voorwaarde' | 'waarschuwingen' | 'wachten'> &
  Partial<Pick<OplosGids, 'regels' | 'wijzigingen' | 'headers' | 'bestand' | 'voorwaarde' | 'waarschuwingen' | 'wachten'>>;

function af(ctx: OplosContext, g: Gids): OplosGids {
  const full: OplosGids = {
    regels: [],
    wijzigingen: [],
    headers: [],
    bestand: null,
    voorwaarde: null,
    waarschuwingen: [],
    wachten: g.ingreep.startsWith('dns') || g.ingreep === 'instelling' ? DNS_WACHTEN : WEB_WACHTEN,
    ...g,
    inlog: g.ingreep.startsWith('dns') && ctx.dns ? { naam: ctx.dns.naam, url: ctx.dns.inlog } : null,
    doorsturen: '',
  };
  full.doorsturen = doorstuurTekst(ctx, full);
  return full;
}

export function doorstuurTekst(ctx: OplosContext, g: Omit<OplosGids, 'doorsturen'>): string {
  const regels = [
    `Hoi, kun je dit voor ons regelen voor ${hoofd(ctx)}?`,
    '',
    ctx.titel,
    '',
    'Wat er moet gebeuren:',
    ...g.stappen.map((s, i) => `${i + 1}. ${s}`),
  ];
  for (const r of g.regels) {
    regels.push('', `${r.voorbeeld ? 'Voorbeeld van de ' : ''}DNS-regel: type ${r.type}, naam ${r.naam}, waarde ${r.waarde}`);
  }
  for (const w of g.wijzigingen) regels.push('', `In ${w.waar}: verander "${w.van}" in "${w.naar}".`);
  for (const h of g.headers) regels.push('', `Header: ${h.naam}: ${h.waarde}`);
  if (g.bestand) regels.push('', `Bestand ${g.bestand.pad}:`, g.bestand.inhoud);
  if (g.voorwaarde) regels.push('', `Let op: ${g.voorwaarde}`);
  for (const w of g.waarschuwingen) regels.push('', `Let op: ${w}`);
  regels.push('', 'Gevonden door Qbicle. Na de wijziging laten we het opnieuw controleren.');
  return regels.join('\n');
}

/** Op een websiteplatform (Wix, Squarespace, Shopify) kun je headers en bestanden meestal niet zelf instellen. */
function platformNotitie(ctx: OplosContext): string[] {
  const opPlatform = ctx.dns && ['wix', 'squarespace'].includes(ctx.dns.id);
  return [
    opPlatform
      ? `Je domein staat bij ${ctx.dns!.naam}. Draait je website ook daar, dan kun je dit meestal niet zelf instellen; dat regelt het platform. Vraag het na bij hun helpdesk.`
      : 'Staat je website op een platform als Wix, Squarespace of Shopify? Dan kun je dit meestal niet zelf instellen en regelt het platform het. Vraag het na bij hun helpdesk.',
  ];
}

function securityTxt(ctx: OplosContext): string {
  const expires = new Date((ctx.now ?? new Date()).getTime() + 365 * 24 * 60 * 60 * 1000);
  expires.setUTCHours(0, 0, 0, 0);
  return [`Contact: mailto:security@${hoofd(ctx)}`, `Expires: ${expires.toISOString().replace('.000Z', 'Z')}`, 'Preferred-Languages: nl, en'].join('\n');
}

/**
 * De uitleg voor één bevinding. `findingKey` is de sleutel uit de scanner
 * (bijvoorbeeld dmarc.missing), `actionKey` de actie uit het scoremodel.
 * Geeft null als we (nog) geen uitleg hebben; dan blijft de gewone actietekst staan.
 */
export function oplosGids(findingKey: string, actionKey: string, ctx: OplosContext): OplosGids | null {
  const zone = hoofd(ctx);
  const dmarcNaam = `_dmarc.${zone}`;
  const dmarcKort = korteNaam(dmarcNaam, zone);
  const rua = `mailto:dmarc@${zone}`;

  switch (actionKey) {
    // E-mail --------------------------------------------------------------------------------
    case 'spf-instellen': {
      const include = ctx.mail ? SPF_INCLUDE[ctx.mail.id] : undefined;
      if (!include) {
        return af(ctx, {
          ingreep: 'aanvragen',
          wie: 'it-partner',
          wieTekst: 'Vraag het aan je mailpartij of IT-partner. Zij weten welke servers namens jullie mailen.',
          duur: 'Ongeveer 10 minuten',
          stappen: [
            `Vraag je mailpartij${ctx.mail ? ` (${ctx.mail.naam})` : ''} welke SPF-regel jullie nodig hebben.`,
            'Noem ook andere systemen die mail uit jullie naam sturen: nieuwsbrief, webshop, boekhoud- of factuursoftware.',
            `Laat één TXT-regel op ${ctx.naam} zetten die begint met v=spf1 en eindigt met ~all.`,
          ],
          waarschuwingen: ['Er mag maar één SPF-regel zijn. Staat er al een, dan wordt die aangevuld, niet verdubbeld.'],
        });
      }
      return af(ctx, {
        ingreep: 'dns-toevoegen',
        wie: 'zelf',
        wieTekst: zelfOfIt(ctx),
        duur: 'Ongeveer 5 minuten',
        stappen: dnsStappen(ctx, 'TXT'),
        regels: [{ type: 'TXT', naam: ctx.naam, kort: korteNaam(ctx.naam, zone), waarde: `v=spf1 include:${include} ~all` }],
        waarschuwingen: [
          `Je mail loopt via ${ctx.mail!.naam}; deze regel staat die toe. Stuurt ook een ander systeem mail uit jullie naam (nieuwsbrief, webshop, factuursoftware)? Zet het include-deel van die dienst er dan voor ~all bij, anders komt die mail in de spam.`,
          'Er mag maar één regel zijn die begint met v=spf1. Staat er al een, pas die dan aan in plaats van een tweede toe te voegen.',
        ],
      });
    }
    case 'spf-repareren': {
      const waar = `de TXT-regel van ${ctx.naam} die begint met v=spf1`;
      if (findingKey === 'spf.plus_all' || findingKey === 'spf.neutral_all' || findingKey === 'spf.no_all') {
        const van = findingKey === 'spf.plus_all' ? '+all' : findingKey === 'spf.neutral_all' ? '?all' : '(niets aan het eind)';
        return af(ctx, {
          ingreep: 'dns-aanpassen',
          wie: 'zelf',
          wieTekst: zelfOfIt(ctx),
          duur: 'Ongeveer 5 minuten',
          stappen: dnsStappen(ctx, 'TXT', true),
          wijzigingen: [{ waar, van, naar: '~all' }],
          waarschuwingen: [
            findingKey === 'spf.plus_all'
              ? 'Met +all mag iedereen ter wereld namens jullie mailen. Dit wil je zo snel mogelijk veranderen.'
              : '~all betekent: mail van andere servers is verdacht. Echte mail via je eigen mailpartij komt gewoon aan.',
            'Verander verder niets aan de regel; de andere delen zijn je mailservers.',
          ],
        });
      }
      if (findingKey === 'spf.multiple') {
        return af(ctx, {
          ingreep: 'dns-aanpassen',
          wie: 'it-partner',
          wieTekst: 'Je kunt het zelf, maar laat het liever je IT-partner doen: een fout hierin laat mail in de spam belanden.',
          duur: 'Ongeveer 10 minuten',
          stappen: [
            ...dnsStappen(ctx, 'TXT', true).slice(0, -1),
            `Er staan nu meerdere regels die met v=spf1 beginnen. Maak er één van: neem alle include-, ip4- en ip6-delen over in één regel.`,
            'Eindig die ene regel met ~all en verwijder daarna de andere SPF-regels.',
          ],
          waarschuwingen: ['Twee SPF-regels tellen voor ontvangers als geen enkele. Samenvoegen herstelt dat.'],
        });
      }
      return af(ctx, {
        ingreep: 'aanvragen',
        wie: 'it-partner',
        wieTekst: 'Stuur dit door naar je IT-partner of mailpartij.',
        duur: 'Ongeveer 15 minuten voor je IT-partner',
        stappen: [
          findingKey === 'spf.too_many_lookups'
            ? 'De SPF-regel verwijst naar te veel andere regels (meer dan 10 opzoekingen). Laat overbodige include-delen weghalen of samenvoegen.'
            : findingKey === 'spf.include_broken'
              ? 'De SPF-regel verwijst naar een dienst die niet (meer) bestaat. Laat dat include-deel weghalen of vervangen.'
              : 'De SPF-regel bevat een fout. Laat hem controleren en herstellen.',
          'Laat de regel eindigen met ~all.',
        ],
      });
    }
    case 'dmarc-instellen': {
      const regel: DnsRegel = { type: 'TXT', naam: dmarcNaam, kort: dmarcKort, waarde: `v=DMARC1; p=none; rua=${rua}` };
      const dubbel = findingKey === 'dmarc.multiple';
      return af(ctx, {
        ingreep: dubbel || findingKey === 'dmarc.syntax' ? 'dns-aanpassen' : 'dns-toevoegen',
        wie: 'zelf',
        wieTekst: zelfOfIt(ctx),
        duur: 'Ongeveer 5 minuten',
        stappen: dubbel
          ? [...dnsStappen(ctx, 'TXT', true).slice(0, -1), `Er staan meerdere regels op ${dmarcNaam}. Verwijder ze op één na, of vervang ze door de regel hieronder.`]
          : findingKey === 'dmarc.syntax'
            ? [...dnsStappen(ctx, 'TXT', true).slice(0, -1), `De regel op ${dmarcNaam} klopt niet. Vervang de waarde door de waarde hieronder.`]
            : dnsStappen(ctx, 'TXT'),
        regels: [regel],
        waarschuwingen: [
          'Dit is de meekijkstand (p=none): er verandert nog niets aan het afleveren van je mail. Je krijgt wel rapporten over wie er uit jullie naam mailt.',
          `De rapporten gaan naar dmarc@${zone}. Bestaat dat adres niet, maak het dan aan of vervang het door een bestaand adres.`,
          'Na 2 tot 4 weken kun je DMARC strenger zetten. Qbicle laat je zien wanneer.',
          ...subdomeinNotitie(ctx, 'DMARC'),
        ],
      });
    }
    case 'dmarc-aanscherpen': {
      const waar = `de TXT-regel op ${dmarcNaam}`;
      const basis = {
        ingreep: 'dns-aanpassen' as const,
        wie: 'it-partner' as const,
        wieTekst: 'Doe dit samen met je IT-partner: die kan in de rapporten zien of al je echte mail goed gaat.',
        duur: 'Ongeveer 10 minuten',
        stappen: dnsStappen(ctx, 'TXT', true),
      };
      if (findingKey === 'dmarc.no_rua') {
        return af(ctx, {
          ...basis,
          wie: 'zelf',
          wieTekst: zelfOfIt(ctx),
          duur: 'Ongeveer 5 minuten',
          wijzigingen: [{ waar, van: 'v=DMARC1; p=…', naar: `v=DMARC1; p=…; rua=${rua}` }],
          waarschuwingen: [`Laat p= staan zoals het is en voeg alleen ; rua=${rua} toe. Bestaat dmarc@${zone} niet, maak het dan aan of gebruik een bestaand adres.`],
        });
      }
      const voorwaarde =
        'Doe dit alleen als de DMARC-rapporten van de afgelopen weken laten zien dat al jullie echte mail (ook nieuwsbrief, webshop en facturen) door SPF of DKIM komt. Anders belandt die mail in de spam.';
      if (findingKey === 'dmarc.partial') {
        return af(ctx, { ...basis, voorwaarde, wijzigingen: [{ waar, van: 'pct=…', naar: '(weghalen, dan geldt het voor alle mail)' }] });
      }
      if (findingKey === 'dmarc.sp_none') {
        return af(ctx, { ...basis, voorwaarde, wijzigingen: [{ waar, van: 'sp=none', naar: 'sp=quarantine' }] });
      }
      return af(ctx, {
        ...basis,
        voorwaarde,
        wijzigingen: [{ waar, van: 'p=none', naar: 'p=quarantine' }],
        waarschuwingen: ['Eerst quarantine (verdachte mail naar de spam). Gaat dat een paar weken goed, dan kan p=reject (weigeren).'],
      });
    }
    case 'mail-dichtzetten': {
      const isSpf = findingKey.startsWith('spf.');
      const naam = isSpf ? ctx.naam : `_dmarc.${ctx.naam}`;
      return af(ctx, {
        ingreep: 'dns-toevoegen',
        wie: 'zelf',
        wieTekst: zelfOfIt(ctx),
        duur: 'Ongeveer 5 minuten',
        stappen: dnsStappen(ctx, 'TXT'),
        regels: [
          isSpf
            ? { type: 'TXT', naam, kort: korteNaam(naam, zone), waarde: 'v=spf1 -all' }
            : { type: 'TXT', naam, kort: korteNaam(naam, zone), waarde: 'v=DMARC1; p=reject;' },
        ],
        voorwaarde: `Alleen als er vanaf ${ctx.naam} nooit mail verstuurd wordt: niet door jullie, en ook niet door een nieuwsbrief, webshop, formulier op de website of factuursoftware. Twijfel je, vraag het dan eerst na; deze regel laat zulke mail weigeren.`,
        waarschuwingen: [
          'We zien geen mailservers op deze naam, maar dat bewijst niet dat er nooit mail vanaf gaat.',
          ...(ctx.zone && ctx.naam !== ctx.zone
            ? [`Verwijst ${ctx.naam} door naar een andere naam (een CNAME, vaak bij www)? Dan kan hier geen TXT-regel staan. Zorg dan dat DMARC op ${ctx.zone} staat; dat geldt ook voor subdomeinen.`]
            : []),
        ],
      });
    }

    // Domein --------------------------------------------------------------------------------
    case 'dnssec-aanzetten': {
      const cloudflare = ctx.dns?.id === 'cloudflare';
      return af(ctx, {
        ingreep: 'instelling',
        wie: 'zelf',
        wieTekst: zelfOfIt(ctx),
        duur: 'Ongeveer 5 minuten, daarna tot een dag wachten',
        stappen: cloudflare
          ? [
              'Log in bij Cloudflare en kies je domein.',
              'Ga naar DNS en dan Settings.',
              'Klik bij DNSSEC op Enable DNSSEC.',
              'Staat de domeinnaam bij een andere partij geregistreerd? Dan toont Cloudflare een DS-record. Vul dat in bij die partij. Staat het domein bij Cloudflare zelf, dan gaat dat vanzelf.',
            ]
          : [
              ctx.dns ? `Log in bij ${ctx.dns.naam}.` : 'Log in bij de partij waar je domein staat.',
              `Kies ${zone} en zoek naar DNSSEC (soms onder Beveiliging of Geavanceerd).`,
              'Zet DNSSEC aan. Bij de meeste Nederlandse partijen is dat één schakelaar.',
              'Zie je geen DNSSEC-knop? Vraag het dan aan via de helpdesk van die partij.',
            ],
        waarschuwingen: [
          'Ga je binnenkort verhuizen naar een andere DNS-partij? Zet DNSSEC dan pas aan na de verhuizing. Een half verhuisde DNSSEC maakt je domein onbereikbaar.',
          ...subdomeinNotitie(ctx, 'DNSSEC'),
        ],
        wachten: 'Na het aanzetten kan het tot een dag duren voordat DNSSEC overal actief is. Laat het daarna controleren.',
      });
    }
    case 'dnssec-repareren':
      return af(ctx, {
        ingreep: 'aanvragen',
        wie: 'it-partner',
        wieTekst: 'Neem vandaag nog contact op met je DNS-partij of IT-partner.',
        duur: 'Direct oppakken',
        stappen: [
          ctx.dns ? `Bel of mail de helpdesk van ${ctx.dns.naam}.` : 'Bel of mail je DNS-partij of IT-partner.',
          `Zeg dat de DNSSEC van ${zone} niet klopt en dat het domein daardoor voor een deel van internet onbereikbaar kan zijn.`,
          'Vraag ze de DNSSEC-sleutels te herstellen, of DNSSEC tijdelijk uit te zetten tot het klopt.',
        ],
        waarschuwingen: ['Dit gebeurt vaak na een verhuizing naar een andere DNS-partij, als de oude DNSSEC-gegevens zijn blijven staan.'],
      });
    case 'caa-instellen':
      return af(ctx, {
        ingreep: 'dns-toevoegen',
        wie: 'it-partner',
        wieTekst: 'Laat dit je IT-partner of webbouwer doen. Weinig urgent: je kunt het ook laten liggen tot je tijd hebt.',
        duur: 'Ongeveer 15 minuten, inclusief uitzoeken',
        stappen: [
          'Vraag je webbouwer, hostingpartij en mailpartij welke certificaatuitgevers zij voor jullie domein gebruiken (vaak Let’s Encrypt, soms Sectigo, DigiCert of Google).',
          `Voeg op ${zone} per uitgever één CAA-regel toe, zoals in het voorbeeld hieronder.`,
          'Controleer na een paar dagen of het verlengen van je certificaten nog goed gaat.',
        ],
        regels: [{ type: 'CAA', naam: zone, kort: '@', waarde: '0 issue "letsencrypt.org"', voorbeeld: true }],
        voorwaarde:
          'Een CAA-regel die een uitgever mist, laat het verlengen van een certificaat weken later stil mislukken. Je website of mail geeft dan een waarschuwing. Zet de regel er alleen in als je zeker weet welke uitgevers je gebruikt.',
        waarschuwingen: [
          'Het voorbeeld is alleen goed als al je certificaten van Let’s Encrypt komen. Partijen als Wix, Cloudflare en Microsoft gebruiken soms meerdere uitgevers.',
          ...subdomeinNotitie(ctx, 'CAA'),
        ],
      });

    // Website -------------------------------------------------------------------------------
    case 'securitytxt-plaatsen':
      return af(ctx, {
        ingreep: 'bestand',
        wie: 'webbouwer',
        wieTekst: 'Je webbouwer of hostingpartij zet dit bestand in een paar minuten online.',
        duur: 'Ongeveer 10 minuten',
        stappen: [
          findingKey === 'web.securitytxt_expired'
            ? 'Het bestand security.txt is verlopen. Zet er een nieuwe datum bij Expires in, zoals hieronder.'
            : 'Maak een tekstbestand met de inhoud hieronder.',
          'Zet het op je website op het adres /.well-known/security.txt.',
          'Zet in je agenda dat je het bestand over een jaar vernieuwt (de datum bij Expires).',
        ],
        bestand: { pad: '/.well-known/security.txt', inhoud: securityTxt(ctx) },
        waarschuwingen: [`Gebruik een adres dat iemand leest. Bestaat security@${zone} niet, vervang het dan door een bestaand adres.`, ...platformNotitie(ctx)],
      });
    case 'website-headers': {
      const headers: WebHeader[] = [];
      if (findingKey === 'web.hsts_missing' || findingKey === 'web.hsts_short') {
        headers.push({
          naam: 'Strict-Transport-Security',
          waarde: 'max-age=31536000',
          uitleg: 'Browsers gaan dan altijd via https. Voeg includeSubDomains pas toe als al je subdomeinen https hebben.',
        });
      } else if (findingKey === 'web.xcto_missing') {
        headers.push({ naam: 'X-Content-Type-Options', waarde: 'nosniff', uitleg: 'Browsers raden dan niet zelf wat een bestand is.' });
      } else if (findingKey === 'web.referrer_missing') {
        headers.push({ naam: 'Referrer-Policy', waarde: 'strict-origin-when-cross-origin', uitleg: 'Andere websites zien dan niet de volledige adressen van je pagina’s.' });
      } else if (findingKey === 'web.framing_unprotected') {
        headers.push({ naam: 'Content-Security-Policy', waarde: "frame-ancestors 'self'", uitleg: 'Andere websites kunnen je pagina’s dan niet onzichtbaar insluiten.' });
      }
      const csp = findingKey === 'web.csp_missing';
      return af(ctx, {
        ingreep: 'instelling',
        wie: 'webbouwer',
        wieTekst: 'Stuur dit door naar je webbouwer of hostingpartij.',
        duur: csp ? 'Een paar uur voor je webbouwer' : 'Ongeveer 15 minuten voor je webbouwer',
        stappen: csp
          ? [
              'Een Content-Security-Policy (CSP) bepaalt welke scripts je website mag laden. Die verschilt per website.',
              'Laat je webbouwer eerst een CSP in de stand Content-Security-Policy-Report-Only zetten. Dan zie je wat er mis zou gaan, zonder dat er iets breekt.',
              'Gaat dat een paar weken goed, laat hem dan echt aanzetten.',
            ]
          : [
              `Laat de webserver of hosting van ${ctx.naam} de header hieronder meesturen.`,
              'Bij veel hostingpartijen en bij Cloudflare kan dat in het beheerscherm; anders in de configuratie van de webserver.',
            ],
        headers,
        waarschuwingen: [
          ...(csp ? ['Zet een CSP nooit in één keer streng aan: dat kan formulieren, betalen of statistieken op je website breken.'] : []),
          ...platformNotitie(ctx),
        ],
      });
    }
    case 'https-afdwingen':
      return af(ctx, {
        ingreep: 'instelling',
        wie: 'webbouwer',
        wieTekst: 'Vaak kun je dit zelf aanzetten in het beheerscherm van je hosting. Anders je webbouwer.',
        duur: 'Ongeveer 5 minuten',
        stappen: ctx.dns?.id === 'cloudflare'
          ? ['Log in bij Cloudflare en kies je domein.', 'Ga naar SSL/TLS en dan Edge Certificates.', 'Zet Always Use HTTPS aan.']
          : [
              'Log in bij je hostingpartij of het beheer van je website.',
              'Zoek naar een instelling als HTTPS forceren, Altijd HTTPS of Doorsturen naar https.',
              'Zet die aan. Werkt je website daarna nog niet via https, vraag het dan aan je webbouwer.',
            ],
      });
    case 'cookies-beveiligen':
      return af(ctx, {
        ingreep: 'aanvragen',
        wie: 'webbouwer',
        wieTekst: 'Stuur dit door naar je webbouwer.',
        duur: 'Ongeveer 30 minuten voor je webbouwer',
        stappen: [
          'Laat cookies van de website de kenmerken Secure en HttpOnly meekrijgen, en SameSite=Lax waar dat kan.',
          'Secure: het cookie gaat alleen over https. HttpOnly: scripts op de pagina kunnen het niet uitlezen.',
        ],
        waarschuwingen: platformNotitie(ctx),
      });
    case 'versies-verbergen':
      return af(ctx, {
        ingreep: 'instelling',
        wie: 'webbouwer',
        wieTekst: 'Stuur dit door naar je webbouwer of hostingpartij.',
        duur: 'Ongeveer 15 minuten voor je webbouwer',
        stappen: [
          'Laat de webserver geen versienummers meer meesturen.',
          'Apache: ServerTokens Prod en ServerSignature Off. Nginx: server_tokens off. PHP: expose_php = Off.',
        ],
        waarschuwingen: ['Verbergen is geen vervanging voor bijwerken: houd de software ook up-to-date.'],
      });
    case 'software-bijwerken':
      return af(ctx, {
        ingreep: 'bijwerken',
        wie: 'webbouwer',
        wieTekst: 'Vaak kan je webbouwer dit snel doen. Gebruik je zelf WordPress of een webshoppakket, dan kun je het soms zelf.',
        duur: 'Van 10 minuten tot een paar uur, afhankelijk van de website',
        stappen: [
          'Maak eerst een back-up van de website (of vraag je hostingpartij of er een is).',
          'Werk de software bij naar de nieuwste versie die nog updates krijgt. In WordPress: Dashboard en dan Updates.',
          'Werk ook plugins en thema’s bij, en controleer daarna of de website, formulieren en betalen nog werken.',
        ],
        waarschuwingen: ['Krijgt de versie helemaal geen updates meer? Dan is een overstap nodig; plan dat met je webbouwer.'],
      });
    case 'cert-vernieuwen':
      return af(ctx, {
        ingreep: 'aanvragen',
        wie: 'webbouwer',
        wieTekst: 'Neem contact op met je webbouwer of hostingpartij.',
        duur: 'Direct oppakken',
        stappen: [
          `Meld dat het certificaat van ${ctx.naam} niet klopt of verlopen is.`,
          'Vraag ze het te vernieuwen en automatisch verlengen aan te zetten (bijvoorbeeld met Let’s Encrypt).',
        ],
      });
    case 'cert-automatisch':
      return af(ctx, {
        ingreep: 'aanvragen',
        wie: 'webbouwer',
        wieTekst: 'Vraag het aan je webbouwer of hostingpartij.',
        duur: 'Ongeveer 10 minuten',
        stappen: [
          `Vraag of het certificaat van ${ctx.naam} automatisch verlengd wordt.`,
          'Zo niet: laat automatisch verlengen aanzetten. Bij de meeste hostingpartijen is dat gratis (Let’s Encrypt).',
        ],
      });

    // Netwerk en accounts --------------------------------------------------------------------
    case 'firmware-bijwerken':
    case 'updates-installeren':
    case 'apparaat-vervangen-of-bijwerken':
      return af(ctx, {
        ingreep: 'bijwerken',
        wie: 'it-partner',
        wieTekst: 'Bij veel routers en apparaten kun je dit zelf via de app. Anders je IT-partner.',
        duur: 'Ongeveer 15 minuten, het apparaat start daarna opnieuw op',
        stappen: [
          `Open de app of beheerpagina van ${ctx.naam}.`,
          'Zoek naar Firmware, Software-update of Systeemupdate en installeer de nieuwste versie.',
          'Zet automatische updates aan als dat kan.',
        ],
        waarschuwingen: ['Doe het op een rustig moment: tijdens de update is het apparaat (en soms internet) even weg.'],
      });
    case 'poort-sluiten':
      return af(ctx, {
        ingreep: 'instelling',
        wie: 'it-partner',
        wieTekst: 'Laat dit je IT-partner doen als je niet weet waarvoor de poort open staat.',
        duur: 'Ongeveer 10 minuten',
        stappen: [
          'Log in op de beheerpagina van je router.',
          'Zoek naar Port forwarding, Poorten doorsturen of Virtuele server.',
          'Verwijder de regel voor dit apparaat. Is toegang op afstand nodig, gebruik dan een VPN.',
        ],
        waarschuwingen: ['Weet eerst waarvoor de poort open staat (bijvoorbeeld een camera of kassasysteem); anders werkt dat daarna niet meer van buitenaf.'],
      });
    case 'upnp-uitzetten':
      return af(ctx, {
        ingreep: 'instelling',
        wie: 'zelf',
        wieTekst: 'Kun je meestal zelf, via de app of beheerpagina van je router.',
        duur: 'Ongeveer 5 minuten',
        stappen: ['Log in op de beheerpagina of app van je router.', 'Zoek naar UPnP (vaak onder Netwerk of Geavanceerd).', 'Zet het uit en sla op.'],
        waarschuwingen: ['Werkt een spelcomputer of camera daarna niet goed meer van buitenaf? Vraag je IT-partner om alleen die ene poort netjes open te zetten.'],
      });
    case 'mfa-aanzetten':
      return af(ctx, {
        ingreep: 'instelling',
        wie: 'it-partner',
        wieTekst: 'Elke beheerder kan het voor zichzelf doen; je IT-partner kan het voor iedereen verplicht maken.',
        duur: 'Ongeveer 5 minuten per persoon',
        stappen: [
          `Laat ${ctx.naam} inloggen op https://aka.ms/mfasetup (Microsoft 365) en een authenticator-app koppelen.`,
          'Laat je IT-partner tweestapsverificatie verplicht maken voor alle beheerders.',
        ],
      });
    case 'apparaat-in-beheer':
    case 'apparaat-vervangen':
      return af(ctx, {
        ingreep: 'aanvragen',
        wie: 'it-partner',
        wieTekst: 'Stuur dit door naar je IT-partner.',
        duur: actionKey === 'apparaat-vervangen' ? 'Plan het in de komende maanden' : 'Ongeveer 15 minuten per apparaat',
        stappen:
          actionKey === 'apparaat-vervangen'
            ? ['Vraag je IT-partner of leverancier om een vervangend apparaat dat nog updates krijgt.', 'Zolang het oude apparaat er nog is: zet het niet open naar internet.']
            : ['Vraag je IT-partner om dit apparaat op te nemen in jullie beheertool, zodat updates en beveiliging bewaakt worden.'],
      });
    default:
      return null;
  }
}

/** Checks die we voor één bevinding opnieuw kunnen draaien (sleutels uit de scanner). */
export const HERCONTROLE_CHECKS = [
  'mail.spf',
  'mail.dmarc',
  'mail.dkim',
  'dns.dnssec',
  'dns.caa',
  'tls.certificate',
  'web.https_redirect',
  'web.headers',
  'web.cookies',
  'web.version_disclosure',
  'web.security_txt',
  'web.software',
] as const;

export function kanHercontroleren(checkKey: string): boolean {
  return (HERCONTROLE_CHECKS as readonly string[]).includes(checkKey);
}
