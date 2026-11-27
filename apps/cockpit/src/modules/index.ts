import type { CockpitModule } from '../module.ts';
import { abonnementen } from './abonnementen.tsx';
import { audit } from './audit.tsx';
import { facturen } from './facturen.tsx';
import { gebruikers } from './gebruikers.tsx';
import { home } from './home.tsx';
import { klanten } from './klanten.tsx';
import { medewerkers } from './medewerkers.tsx';
import { placeholder } from './placeholder.tsx';

/**
 * Alle onderdelen van de cockpit. Een nieuw onderdeel: maak src/modules/<naam>.tsx
 * met een CockpitModule en zet hem hier in de lijst (zie docs/cockpit.md).
 */
export const MODULES: CockpitModule[] = [
  home,

  // Klanten
  klanten,
  gebruikers,

  // Financiën
  abonnementen,
  placeholder({ key: 'incasso', label: "Incasso's", href: '/incasso', icon: 'incasso', group: 'financien', order: 20 }, [
    'Incassobatch automatisch klaargezet per periode',
    'Controleren, regels uitsluiten of aanpassen, daarna met één knop indienen',
    'Mislukte incasso’s (storno, geen dekking, mandaat ingetrokken) met voorgestelde vervolgactie',
  ]),
  facturen,

  // Techniek en support (worden gebouwd in de thread voor gebruik, support en agents)
  placeholder({ key: 'gebruik', label: 'Gebruik', href: '/gebruik', icon: 'gebruik', group: 'techniek', order: 10 }, [
    'Gebruik per klant: scans, assets, tokens en kosten',
  ]),
  placeholder({ key: 'gezondheid', label: 'Gezondheid', href: '/gezondheid', icon: 'gezondheid', group: 'techniek', order: 20 }, [
    'Status van scanners, wachtrijen, mail en betaalprovider',
  ]),
  placeholder({ key: 'support', label: 'Support', href: '/support', icon: 'support', group: 'techniek', order: 30, permission: 'cockpit.lezen' }, [
    'Supportvragen van klanten, met voorstel voor antwoord door een agent',
  ]),
  placeholder({ key: 'agents', label: 'Agents', href: '/agents', icon: 'agent', group: 'techniek', order: 40 }, [
    'Wat de agents doen en voorstellen die op goedkeuring wachten',
  ]),

  // Beheer
  audit,
  medewerkers,
];
