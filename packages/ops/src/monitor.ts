import { many } from '@qbicle/platform';
import { ensureAgent, expireProposals, finishRun, propose, startRun } from './agents.ts';
import type { OpsContext } from './context.ts';
import { listScanJobs, recordError } from './health.ts';
import { detectUsageSignals } from './usage.ts';

export const BEWAKER = {
  key: 'ops-bewaker',
  name: 'Bewaker',
  description:
    'Bewaakt het platform: zet vastgelopen scans opnieuw in de wachtrij, opent interne meldingen bij afwijkend gebruik en herhaalde fouten, en stelt voor klanten te waarschuwen die hun limiet naderen. Mailt nooit zelf.',
} as const;

const actor = { kind: 'agent', agentKey: BEWAKER.key } as const;

/**
 * Eén ronde van de bewakingsagent. Regelgebaseerd (geen AI nodig), zodat hij
 * goedkoop elke paar minuten kan draaien. Alles loopt via voorstellen.
 */
export async function runBewaker(ctx: OpsContext): Promise<{ runId: string; stats: Record<string, number> }> {
  await ensureAgent(ctx.pool, BEWAKER);
  const runId = await startRun(ctx.pool, BEWAKER.key);
  const stats = { verlopen: 0, scansOpnieuw: 0, scanMeldingen: 0, gebruikMeldingen: 0, limietBerichten: 0, foutMeldingen: 0 };
  try {
    stats.verlopen = await expireProposals(ctx.pool);

    // 1. Vastgelopen scans: opnieuw proberen, na 3 pogingen een mens laten kijken.
    for (const s of await listScanJobs(ctx, 'vast', { limit: 100 })) {
      if (s.attempts < 3) {
        const r = await propose(ctx, actor, {
          kind: 'scan.opnieuw',
          title: `Scan ${s.domain} opnieuw in de wachtrij`,
          rationale: `De scan staat sinds ${s.started_at?.toISOString() ?? 'onbekend'} op 'bezig' en lijkt vast te zitten (poging ${s.attempts + 1} van 3).`,
          payload: { scanId: s.id },
          organizationId: s.organization_id,
          refId: s.id,
          dedupeKey: `scan.opnieuw:${s.id}:${s.attempts}`,
          runId,
        });
        if (r.created) stats.scansOpnieuw++;
      } else {
        const r = await propose(ctx, actor, {
          kind: 'ticket.melding',
          title: `Scan ${s.domain} blijft vastlopen`,
          rationale: 'Na 3 pogingen blijft de scan hangen; een mens moet kijken.',
          payload: {
            subject: `Scan ${s.domain} (${s.organization_name}) blijft vastlopen`,
            body: `Scan ${s.id} is 3 keer opnieuw geprobeerd en blijft op 'bezig' staan. Laatste fout: ${s.error ?? 'geen'}.`,
            priority: 'hoog',
            category: 'scan',
          },
          organizationId: s.organization_id,
          refId: s.id,
          dedupeKey: `scan.vast:${s.id}`,
          runId,
        });
        if (r.created) stats.scanMeldingen++;
      }
    }

    // 2. Gebruik: afwijkend = interne melding; limiet bijna/over = één bericht per klant
    //    (alle limieten samen), dat een mens goedkeurt.
    const day = new Date().toISOString().slice(0, 10);
    const month = day.slice(0, 7);
    const signals = await detectUsageSignals(ctx);
    for (const sig of signals.filter((s) => s.kind === 'afwijkend')) {
      const r = await propose(ctx, actor, {
        kind: 'ticket.melding',
        title: `Afwijkend gebruik bij ${sig.organizationName}`,
        rationale: sig.message,
        payload: { subject: `Afwijkend gebruik: ${sig.organizationName}`, body: `${sig.message} Controleer of dit klopt of op misbruik wijst.`, priority: 'normaal', category: 'overig' },
        organizationId: sig.organizationId,
        dedupeKey: `gebruik.afwijkend:${sig.organizationId}:${sig.metric}:${day}`,
        runId,
      });
      if (r.created) stats.gebruikMeldingen++;
    }
    const perOrg = new Map<string, typeof signals>();
    for (const sig of signals.filter((s) => s.kind !== 'afwijkend')) {
      perOrg.set(sig.organizationId, [...(perOrg.get(sig.organizationId) ?? []), sig]);
    }
    for (const [orgId, list] of perOrg) {
      const over = list.some((s) => s.kind === 'limiet_over');
      const name = list[0]!.organizationName;
      const lines = list.map((s) => `- ${s.message.replace(`${name}: `, '')}`).join('\n');
      const r = await propose(ctx, actor, {
        kind: 'klant.bericht',
        title: `${name} ${over ? 'zit over' : 'nadert'} de limiet van het pakket`,
        rationale: `${list.map((s) => s.message).join(' ')} Voorstel: de eigenaar laten weten dat de limiet ${over ? 'bereikt is' : 'bijna bereikt is'}, met de optie om over te stappen.`,
        payload: {
          subject: over ? 'Je hebt de limiet van je Qbicle-pakket bereikt' : 'Je nadert de limiet van je Qbicle-pakket',
          body: `Hallo,\n\nJullie gebruik deze maand:\n${lines}\n\nWil je meer ruimte? Kijk in je account bij Abonnement voor een groter pakket, of beantwoord deze mail.`,
        },
        organizationId: orgId,
        dedupeKey: `gebruik.${over ? 'limiet_over' : 'limiet_bijna'}:${orgId}:${month}`,
        runId,
      });
      if (r.created) stats.limietBerichten++;
    }

    // 3. Herhaalde fouten zonder melding.
    const errors = await many<{ id: string; source: string; message: string; occurrences: number; organization_id: string | null }>(
      ctx.pool,
      `SELECT id, source, message, occurrences, organization_id FROM system_error
        WHERE resolved_at IS NULL AND occurrences >= 10 AND last_seen > now() - interval '24 hours'
        ORDER BY occurrences DESC LIMIT 20`,
    );
    for (const e of errors) {
      const r = await propose(ctx, actor, {
        kind: 'ticket.melding',
        title: `Herhaalde fout (${e.source}): ${e.message.slice(0, 120)}`,
        rationale: `Deze fout is ${e.occurrences} keer opgetreden en nog niet opgelost.`,
        payload: { subject: `Fout ${e.source}: ${e.message.slice(0, 150)}`, body: `${e.message}\n\n${e.occurrences} keer gezien. Fout-id ${e.id}.`, priority: 'hoog', category: 'overig' },
        organizationId: e.organization_id,
        refId: e.id,
        dedupeKey: `fout:${e.id}`,
        runId,
      });
      if (r.created) stats.foutMeldingen++;
    }

    const total = stats.scansOpnieuw + stats.scanMeldingen + stats.gebruikMeldingen + stats.limietBerichten + stats.foutMeldingen;
    await finishRun(ctx.pool, runId, {
      status: 'klaar',
      summary: total === 0 ? 'Niets bijzonders gezien.' : `${total} nieuwe actie(s) of voorstel(len).`,
      stats,
    });
    return { runId, stats };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await finishRun(ctx.pool, runId, { status: 'mislukt', summary: msg, stats });
    await recordError(ctx.pool, { source: 'agent', message: `Bewaker mislukt: ${msg}` });
    throw err;
  }
}
