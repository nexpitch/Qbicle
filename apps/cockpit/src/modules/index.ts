import type { CockpitModule } from '../module.ts';
import { abonnementen } from './abonnementen.tsx';
import { agents } from './agents.tsx';
import { audit } from './audit.tsx';
import { facturen } from './facturen.tsx';
import { gebruik } from './gebruik.tsx';
import { gebruikers } from './gebruikers.tsx';
import { gezondheid } from './gezondheid.tsx';
import { home } from './home.tsx';
import { incasso } from './incasso.tsx';
import { klanten } from './klanten.tsx';
import { medewerkers } from './medewerkers.tsx';
import { placeholder } from './placeholder.tsx';
import { support } from './support.tsx';

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
  incasso,
  facturen,

  // Techniek en support (packages/ops)
  gebruik,
  gezondheid,
  support,
  agents,

  // Beheer
  audit,
  medewerkers,
];
