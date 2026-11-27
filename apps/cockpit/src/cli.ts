import { existsSync } from 'node:fs';
import { SYSTEM_ACTOR } from '@qbicle/platform';
import { cockpitFromEnv } from './from-env.ts';
import { isStaffRole, STAFF_ROLE_LABEL } from './core/roles.ts';
import { addStaff, hasStaff, listStaff, resetStaffMfa } from './core/staff.ts';
import { amsterdamDate, prepareRun } from './core/collections.ts';

/**
 * Beheer van cockpit-medewerkers vanaf de opdrachtregel. Vooral voor de eerste
 * beheerder (daarna kan het in de cockpit zelf, onder Medewerkers).
 *
 *   npm run cockpit:beheer -- toevoegen erik@voorbeeld.nl beheerder
 *   npm run cockpit:beheer -- lijst
 *   npm run cockpit:beheer -- mfa-reset erik@voorbeeld.nl
 *   npm run cockpit:beheer -- heeft-medewerkers     (exitcode 0 = ja, 1 = nee)
 *   npm run cockpit:beheer -- incasso-klaarzetten [JJJJ-MM-DD]   (voor de geplande taak/agent)
 */
if (existsSync('.env')) process.loadEnvFile('.env');

const [cmd, arg1, arg2] = process.argv.slice(2);
const { cockpit } = cockpitFromEnv();
const actor = { ...SYSTEM_ACTOR, kind: 'medewerker' as const };

try {
  switch (cmd) {
    case 'toevoegen': {
      const role = arg2 ?? 'beheerder';
      if (!arg1 || !isStaffRole(role)) throw new Error('Gebruik: toevoegen <e-mail> [beheerder|financieel|support|lezer]');
      await addStaff(cockpit, arg1, role, actor);
      console.log(`${arg1} is toegevoegd als ${STAFF_ROLE_LABEL[role]}. Log in via de cockpit en stel je authenticator in.`);
      break;
    }
    case 'lijst': {
      for (const r of await listStaff(cockpit)) {
        console.log(`${r.email}\t${STAFF_ROLE_LABEL[r.role]}\t${r.revoked_at ? 'ingetrokken' : r.mfa ? 'MFA ingesteld' : 'MFA nog instellen'}`);
      }
      break;
    }
    case 'mfa-reset': {
      const r = (await listStaff(cockpit)).find((s) => s.email === arg1?.toLowerCase() && !s.revoked_at);
      if (!r) throw new Error(`Geen actieve medewerker ${arg1 ?? ''}`);
      await resetStaffMfa(cockpit, r.user_id, actor);
      console.log(`MFA van ${r.email} is gereset. Bij de volgende keer inloggen stelt die opnieuw een authenticator in.`);
      break;
    }
    case 'heeft-medewerkers': {
      const ja = await hasStaff(cockpit);
      await cockpit.p.pool.end();
      process.exit(ja ? 0 : 1);
    }
    case 'incasso-klaarzetten': {
      // Zet een batch klaar; indienen gebeurt nooit automatisch, altijd na controle in de cockpit.
      const date = arg1 ?? amsterdamDate(new Date(Date.now() + 5 * 86_400_000));
      const r = await prepareRun(cockpit.p, { collectionDate: date, source: 'agent' }, { userId: null });
      console.log(r ? `Batch klaargezet met ${r.items} regel(s) voor ${date}: ${cockpit.config.origin}/incasso/${r.runId}` : `Niets te incasseren tot ${date}.`);
      break;
    }
    default:
      console.log('Opdrachten: toevoegen <e-mail> [rol] | lijst | mfa-reset <e-mail> | heeft-medewerkers | incasso-klaarzetten [datum]');
  }
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await cockpit.p.pool.end().catch(() => {});
}
