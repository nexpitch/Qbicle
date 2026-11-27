import { createHash, randomBytes } from 'node:crypto';
import { beoordeelCloud } from './google/cloud.ts';
import { testRuwCloud, testRuwWorkspace, TEST_NU } from './google/testmodus.ts';
import { beoordeelWorkspace } from './google/workspace.ts';
import { inPakket, vindKoppeling, type Koppeling, type KoppelingId, type VoorbeeldBevinding } from './catalogus.ts';

/**
 * Testmodus voor koppelingen. Er wordt niets met een echte dienst verbonden:
 * de stand staat in het geheugen van het proces (weg na een herstart) en de
 * "toestemming" van IT wordt nagebootst. Zo kunnen we de hele route voor de klant
 * bouwen en testen voordat er een Entra-app, AWS-rol of BV is.
 *
 * De echte versie (bouwplan stap 2) zet dit in de database met een logboek per
 * ophaalactie en versleutelde tokens; de vorm van KoppelingStand blijft gelijk.
 */

export type KoppelingStatus = 'niet_gekoppeld' | 'wacht_op_it' | 'actief' | 'let_op' | 'fout' | 'ingetrokken';
export type TestUitkomst = 'gelukt' | 'te_veel_rechten' | 'mislukt';

export interface LogRegel {
  tijd: Date;
  tekst: string;
}

export interface KoppelingStand {
  id: KoppelingId;
  status: KoppelingStatus;
  gestartOp: Date | null;
  gekoppeldOp: Date | null;
  laatsteRonde: Date | null;
  ingetrokkenOp: Date | null;
  /** Uitleg bij let_op of fout, in gewone taal. */
  melding: string | null;
  /** Rechten zoals ze bij de dienst echt verleend zijn (testmodus: nagebootst). */
  verleendeRechten: string[];
  bevindingen: VoorbeeldBevinding[];
  logboek: LogRegel[];
  interesse: boolean;
}

export class KoppelingFout extends Error {
  constructor(
    readonly code: 'niet_gevonden' | 'niet_beschikbaar' | 'niet_in_pakket' | 'verkeerde_stap' | 'verlopen',
    message: string,
  ) {
    super(message);
  }
}

export interface DeelLink {
  token: string;
  verlooptOp: Date;
}

interface Gedeeld {
  organizationId: string;
  koppeling: KoppelingId;
  verlooptOp: Date;
}

/** Nagebootst "te veel" recht per koppeling, in de taal van die dienst. */
const TE_VEEL_TEST: Partial<Record<KoppelingId, string>> = { 'google-workspace': 'drive.readonly', 'google-cloud': 'roles/storage.objectViewer' };

const DEEL_DAGEN = 7;
const DEEL_PREFIX = 'qbk_';
const MAX_LOG = 50;
const MAX_ORGS = 5_000;

const hash = (t: string) => createHash('sha256').update(t).digest('hex');

function leeg(id: KoppelingId): KoppelingStand {
  return {
    id,
    status: 'niet_gekoppeld',
    gestartOp: null,
    gekoppeldOp: null,
    laatsteRonde: null,
    ingetrokkenOp: null,
    melding: null,
    verleendeRechten: [],
    bevindingen: [],
    logboek: [],
    interesse: false,
  };
}

/** Google: de echte beoordeling op voorbeelddata. Andere koppelingen: de voorbeelden uit de catalogus. */
function testBevindingen(k: Koppeling): VoorbeeldBevinding[] {
  const u = k.id === 'google-workspace' ? beoordeelWorkspace(testRuwWorkspace(), TEST_NU) : k.id === 'google-cloud' ? beoordeelCloud(testRuwCloud()) : null;
  if (!u) return structuredClone(k.voorbeeldBevindingen);
  return u.bevindingen.map(({ urgentie, titel, actie }) => ({ urgentie, titel, actie }));
}

export class KoppelingenTeststand {
  private readonly orgs = new Map<string, Map<KoppelingId, KoppelingStand>>();
  /** Deellinks op hash van het token: het token zelf bewaren we niet. */
  private readonly links = new Map<string, Gedeeld>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  private koppeling(id: string): Koppeling {
    const k = vindKoppeling(id);
    if (!k) throw new KoppelingFout('niet_gevonden', 'Deze koppeling bestaat niet.');
    return k;
  }

  private stand(org: string, id: KoppelingId): KoppelingStand {
    let m = this.orgs.get(org);
    if (!m) {
      if (this.orgs.size >= MAX_ORGS) this.orgs.delete(this.orgs.keys().next().value!);
      m = new Map();
      this.orgs.set(org, m);
    }
    let s = m.get(id);
    if (!s) {
      s = leeg(id);
      m.set(id, s);
    }
    return s;
  }

  private log(s: KoppelingStand, tekst: string) {
    s.logboek.unshift({ tijd: this.now(), tekst });
    if (s.logboek.length > MAX_LOG) s.logboek.length = MAX_LOG;
  }

  lijst(org: string): KoppelingStand[] {
    const m = this.orgs.get(org);
    return [...(m?.values() ?? [])].map((s) => structuredClone(s));
  }

  get(org: string, id: string): KoppelingStand {
    const k = this.koppeling(id);
    return structuredClone(this.orgs.get(org)?.get(k.id) ?? leeg(k.id));
  }

  /** Klant kiest de koppeling: daarna is het wachten op IT. */
  starten(org: string, id: string, plan: string | null, door: string): KoppelingStand {
    const k = this.koppeling(id);
    if (k.beschikbaarheid !== 'testmodus') throw new KoppelingFout('niet_beschikbaar', `${k.naam} komt binnenkort. Je kunt laten weten dat je hem wilt gebruiken.`);
    if (!inPakket(k, plan)) throw new KoppelingFout('niet_in_pakket', `${k.naam} zit in Qbicle Business.`);
    const s = this.stand(org, k.id);
    if (s.status === 'actief' || s.status === 'let_op') throw new KoppelingFout('verkeerde_stap', 'Deze koppeling is al actief.');
    Object.assign(s, { ...leeg(k.id), interesse: s.interesse, logboek: s.logboek });
    s.status = 'wacht_op_it';
    s.gestartOp = this.now();
    this.log(s, `Koppeling gestart door ${door}. Wacht op toestemming van IT.`);
    return structuredClone(s);
  }

  /** Link met het stappenplan voor de IT-beheerder, 7 dagen geldig, zonder klantgegevens. */
  deelLink(org: string, id: string, door: string): DeelLink {
    const k = this.koppeling(id);
    const s = this.stand(org, k.id);
    if (s.status !== 'wacht_op_it') throw new KoppelingFout('verkeerde_stap', 'Start eerst de koppeling.');
    const token = DEEL_PREFIX + randomBytes(24).toString('base64url');
    const verlooptOp = new Date(this.now().getTime() + DEEL_DAGEN * 86_400_000);
    this.opruimen();
    this.links.set(hash(token), { organizationId: org, koppeling: k.id, verlooptOp });
    this.log(s, `Stappenplan gedeeld met IT door ${door} (link geldig tot ${verlooptOp.toLocaleDateString('nl-NL', { timeZone: 'Europe/Amsterdam' })}).`);
    return { token, verlooptOp };
  }

  /** Voor de openbare IT-pagina. Geeft alleen de koppeling terug, geen organisatie. */
  openDeelLink(token: string): { koppeling: Koppeling; verlooptOp: Date } {
    if (typeof token !== 'string' || !token.startsWith(DEEL_PREFIX) || token.length > 64) throw new KoppelingFout('niet_gevonden', 'Deze link bestaat niet.');
    const g = this.links.get(hash(token));
    if (!g) throw new KoppelingFout('niet_gevonden', 'Deze link bestaat niet.');
    if (g.verlooptOp <= this.now()) throw new KoppelingFout('verlopen', 'Deze link is verlopen. Vraag om een nieuwe.');
    return { koppeling: this.koppeling(g.koppeling), verlooptOp: g.verlooptOp };
  }

  /** Testmodus: doe alsof IT toestemming gaf bij de dienst en de eerste ronde draait. */
  testToestemming(org: string, id: string, uitkomst: TestUitkomst): KoppelingStand {
    const k = this.koppeling(id);
    const s = this.stand(org, k.id);
    if (s.status !== 'wacht_op_it' && s.status !== 'fout') throw new KoppelingFout('verkeerde_stap', 'Start eerst de koppeling.');
    const nu = this.now();
    if (uitkomst === 'mislukt') {
      s.status = 'fout';
      s.melding = 'We vonden geen toestemming. Controleer of de stappen helemaal zijn doorlopen, of deel het stappenplan opnieuw met IT.';
      this.log(s, 'Controle mislukt: geen toestemming gevonden.');
      return structuredClone(s);
    }
    s.verleendeRechten = k.rechten.map((r) => r.naam);
    s.status = 'actief';
    s.melding = null;
    if (uitkomst === 'te_veel_rechten') {
      s.status = 'let_op';
      s.verleendeRechten.push(TE_VEEL_TEST[k.id] ?? (k.categorie === 'cloud' ? 'AdministratorAccess' : 'Directory.ReadWrite.All'));
      s.melding = 'Er zijn meer rechten gegeven dan Qbicle nodig heeft. We gebruiken ze niet, maar haal ze voor de zekerheid weg.';
    }
    s.gekoppeldOp = nu;
    s.laatsteRonde = nu;
    s.bevindingen = testBevindingen(k);
    this.log(s, 'Toestemming gevonden. Rechten gecontroleerd.');
    this.log(s, `Eerste ronde: instellingen gelezen, ${s.bevindingen.length} bevindingen.`);
    return structuredClone(s);
  }

  intrekken(org: string, id: string, door: string): KoppelingStand {
    const k = this.koppeling(id);
    const s = this.stand(org, k.id);
    if (s.status === 'niet_gekoppeld' || s.status === 'ingetrokken') throw new KoppelingFout('verkeerde_stap', 'Deze koppeling is niet actief.');
    s.status = 'ingetrokken';
    s.ingetrokkenOp = this.now();
    s.verleendeRechten = [];
    s.bevindingen = [];
    s.melding = null;
    for (const [h, g] of this.links) if (g.organizationId === org && g.koppeling === k.id) this.links.delete(h);
    this.log(s, `Ingetrokken door ${door}. Sleutels en tokens gewist; opgehaalde instellingen worden binnen 30 dagen verwijderd.`);
    return structuredClone(s);
  }

  /** "Laat me weten" bij een koppeling die nog niet beschikbaar is. */
  interesse(org: string, id: string): KoppelingStand {
    const k = this.koppeling(id);
    const s = this.stand(org, k.id);
    s.interesse = true;
    return structuredClone(s);
  }

  private opruimen() {
    const nu = this.now();
    for (const [h, g] of this.links) if (g.verlooptOp <= nu) this.links.delete(h);
  }
}

const perPlatform = new WeakMap<object, KoppelingenTeststand>();

/** Eén teststand per platform-instantie (gedeeld door API en web-app in hetzelfde proces). */
export function teststandVoor(platform: object): KoppelingenTeststand {
  let t = perPlatform.get(platform);
  if (!t) {
    t = new KoppelingenTeststand();
    perPlatform.set(platform, t);
  }
  return t;
}
