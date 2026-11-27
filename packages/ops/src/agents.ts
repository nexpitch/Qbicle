import { createHash } from 'node:crypto';
import type pg from 'pg';
import { isUniqueViolation, many, notFound, one, PlatformError, withTransaction, type Queryable } from '@qbicle/platform';
import { opsAudit } from './audit.ts';
import type { OpsActor, OpsContext, StaffRole } from './context.ts';
import { recordError } from './health.ts';

/**
 * Agents in de cockpit: veilig samenwerken met mensen.
 *
 * Regels (afgedwongen in code én database):
 * 1. Een agent kan alleen lezen en voorstellen doen (propose). Hij kan nooit zelf goedkeuren.
 * 2. Wat een voorstel doet, staat vast in een geregistreerde soort (ProposalKind) met
 *    eigen validatie en uitvoering. Een agent kan geen nieuwe acties verzinnen.
 * 3. Impact 'klant' of 'financieel' vraagt altijd een besluit van een medewerker met de
 *    juiste rol. Alleen impact 'geen' (intern en omkeerbaar) mag automatisch.
 * 4. De inhoud van een voorstel is na aanmaken bevroren (trigger + sha256); uitgevoerd
 *    wordt precies wat is goedgekeurd. Een voorstel verloopt na 7 dagen.
 * 5. Alles komt in het audit-log; voorstellen worden nooit verwijderd.
 * 6. Noodrem per agent (enabled) en een maximum aan openstaande voorstellen.
 */

export type Impact = 'geen' | 'klant' | 'financieel';
export type ProposalStatus = 'voorgesteld' | 'goedgekeurd' | 'afgewezen' | 'bezig' | 'uitgevoerd' | 'mislukt' | 'verlopen' | 'ingetrokken';

export interface Proposal {
  id: string;
  agent_key: string;
  agent_name?: string;
  run_id: string | null;
  kind: string;
  ref_id: string | null;
  organization_id: string | null;
  organization_name?: string | null;
  title: string;
  rationale: string;
  payload: Record<string, unknown>;
  payload_sha256: string;
  impact: Impact;
  amount_cents: string | null;
  status: ProposalStatus;
  dedupe_key: string | null;
  expires_at: Date;
  decided_by: string | null;
  decided_by_email?: string | null;
  decided_at: Date | null;
  decision_note: string | null;
  decided_via: 'medewerker' | 'automatisch' | null;
  executed_at: Date | null;
  result: Record<string, unknown> | null;
  created_at: Date;
}

export interface ProposalKind<P = Record<string, unknown>> {
  /** 'domein.actie', bijv. 'scan.opnieuw' of 'incasso.batch'. */
  kind: string;
  /** Korte Nederlandse naam voor de cockpit. */
  label: string;
  impact: Impact;
  /** Rollen die mogen goedkeuren; 'beheerder' mag altijd. */
  approvers: StaffRole[];
  /** Alleen bij impact 'geen': zonder mens goedkeuren en uitvoeren. */
  autoApprove?: boolean;
  /** Moet aan een klant hangen (organization_id verplicht). */
  requiresOrganization?: boolean;
  /** Controleert en normaliseert de payload; gooit PlatformError bij ongeldige invoer. */
  parse(payload: unknown): P;
  /** Extra controle tegen de database bij het voorstellen (bestaat het onderwerp?). */
  check?(q: Queryable, input: { payload: P; organizationId: string | null; refId: string | null }): Promise<void>;
  /** Voert het goedgekeurde voorstel uit. Geeft een korte uitkomst terug voor het log. */
  execute(ctx: OpsContext, run: { proposal: Proposal; payload: P; approvedBy: string | null }): Promise<Record<string, unknown>>;
}

const KINDS = new Map<string, ProposalKind<any>>();

/** Registreert een soort voorstel. Andere modules (bijv. incasso) gebruiken dit voor hun eigen acties. */
export function registerProposalKind<P>(def: ProposalKind<P>): void {
  if (!/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(def.kind)) throw new Error(`Ongeldige soortnaam: ${def.kind}`);
  if (def.autoApprove && def.impact !== 'geen') {
    throw new Error(`${def.kind}: automatisch goedkeuren mag alleen bij impact 'geen'`);
  }
  if (def.approvers.includes('lezer')) throw new Error(`${def.kind}: een lezer kan niet goedkeuren`);
  KINDS.set(def.kind, def);
}

export function getProposalKind(kind: string): ProposalKind | undefined {
  return KINDS.get(kind);
}

export function listProposalKinds(): Array<Pick<ProposalKind, 'kind' | 'label' | 'impact' | 'approvers' | 'autoApprove'>> {
  return [...KINDS.values()].map(({ kind, label, impact, approvers, autoApprove }) => ({ kind, label, impact, approvers, autoApprove: !!autoApprove }));
}

/** Mag deze rol dit soort voorstel goedkeuren? */
export function canApprove(role: StaffRole, def: Pick<ProposalKind, 'approvers'>): boolean {
  if (role === 'lezer') return false;
  return role === 'beheerder' || def.approvers.includes(role);
}

/** JSON met gesorteerde sleutels, zodat de hash niet afhangt van de volgorde in jsonb. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(',')}}`;
}

export function payloadHash(payload: unknown): string {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PROPOSAL_SELECT = `SELECT p.*, p.amount_cents::text AS amount_cents, a.name AS agent_name, o.name AS organization_name,
  u.email::text AS decided_by_email
  FROM agent_proposal p JOIN agent a ON a.key = p.agent_key
  LEFT JOIN organization o ON o.id = p.organization_id
  LEFT JOIN app_user u ON u.id = p.decided_by`;

// Agents en runs ------------------------------------------------------------------

export interface AgentDef {
  key: string;
  name: string;
  description: string;
  maxOpenProposals?: number;
}

/** Maakt een agent aan of werkt naam/omschrijving bij. Laat de noodrem ongemoeid. */
export async function ensureAgent(q: Queryable, def: AgentDef): Promise<void> {
  await q.query(
    `INSERT INTO agent (key, name, description, max_open_proposals) VALUES ($1, $2, $3, $4)
     ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description`,
    [def.key, def.name, def.description, def.maxOpenProposals ?? 50],
  );
}

export async function startRun(q: Queryable, agentKey: string): Promise<string> {
  const a = await one<{ enabled: boolean }>(q, 'SELECT enabled FROM agent WHERE key = $1', [agentKey]);
  if (!a) throw notFound('Deze agent');
  if (!a.enabled) throw new PlatformError('geen_toegang', 'Deze agent is gepauzeerd.');
  const r = await one<{ id: string }>(q, 'INSERT INTO agent_run (agent_key) VALUES ($1) RETURNING id', [agentKey]);
  return r!.id;
}

export async function finishRun(
  q: Queryable,
  runId: string,
  outcome: { status: 'klaar' | 'mislukt'; summary: string; stats?: Record<string, unknown> },
): Promise<void> {
  await q.query(
    `UPDATE agent_run SET status = $2, summary = $3, stats = $4, finished_at = now() WHERE id = $1 AND status = 'bezig'`,
    [runId, outcome.status, outcome.summary.slice(0, 2000), outcome.stats ? JSON.stringify(outcome.stats) : null],
  );
}

/** Noodrem: alleen een beheerder pauzeert of hervat een agent. */
export async function setAgentEnabled(
  q: Queryable,
  actor: Extract<OpsActor, { kind: 'medewerker' }>,
  agentKey: string,
  enabled: boolean,
  reason?: string,
): Promise<void> {
  if (actor.role !== 'beheerder') throw new PlatformError('geen_toegang', 'Alleen een beheerder kan een agent pauzeren of hervatten.');
  const r = await q.query(
    `UPDATE agent SET enabled = $2, paused_reason = CASE WHEN $2 THEN NULL ELSE $3 END,
            paused_by = CASE WHEN $2 THEN NULL ELSE $4::uuid END WHERE key = $1`,
    [agentKey, enabled, reason?.slice(0, 400) ?? null, actor.userId],
  );
  if (!r.rowCount) throw notFound('Deze agent');
  await opsAudit(q, actor, { action: enabled ? 'ops.agent_hervat' : 'ops.agent_gepauzeerd', subject: agentKey, detail: reason ? { reden: reason } : {} });
}

// Voorstellen ---------------------------------------------------------------------

export interface ProposeInput {
  kind: string;
  title: string;
  rationale: string;
  payload: unknown;
  organizationId?: string | null;
  refId?: string | null;
  amountCents?: number | null;
  dedupeKey?: string | null;
  runId?: string | null;
  expiresInHours?: number;
}

/**
 * Een agent doet een voorstel. Bestaat er al een voorstel met dezelfde
 * dedupeKey dat niet verlopen, ingetrokken of mislukt is, dan komt dat terug (created: false). Bij een soort met
 * autoApprove wordt het meteen uitgevoerd.
 */
export async function propose(
  ctx: OpsContext,
  actor: Extract<OpsActor, { kind: 'agent' }>,
  input: ProposeInput,
): Promise<{ proposal: Proposal; created: boolean }> {
  if (actor.kind !== 'agent') throw new PlatformError('geen_toegang', 'Alleen agents doen voorstellen.');
  const def = KINDS.get(input.kind);
  if (!def) throw new PlatformError('ongeldige_invoer', `Onbekende soort voorstel: ${input.kind}`);
  const title = input.title.trim();
  const rationale = input.rationale.trim();
  if (!title || title.length > 200) throw new PlatformError('ongeldige_invoer', 'Titel moet 1 tot 200 tekens zijn.');
  if (!rationale || rationale.length > 4000) throw new PlatformError('ongeldige_invoer', 'Onderbouwing moet 1 tot 4000 tekens zijn.');
  const organizationId = input.organizationId ?? null;
  if (organizationId && !UUID.test(organizationId)) throw notFound('Deze organisatie');
  if (def.requiresOrganization && !organizationId) throw new PlatformError('ongeldige_invoer', `${def.label}: kies een klant.`);
  const hours = Math.min(Math.max(input.expiresInHours ?? 24 * 7, 1), 24 * 30);
  const payload = def.parse(input.payload) as Record<string, unknown>;
  const refId = input.refId ?? null;

  const agent = await one<{ enabled: boolean; max_open_proposals: number }>(
    ctx.pool,
    'SELECT enabled, max_open_proposals FROM agent WHERE key = $1',
    [actor.agentKey],
  );
  if (!agent) throw notFound('Deze agent');
  if (!agent.enabled) throw new PlatformError('geen_toegang', 'Deze agent is gepauzeerd.');
  if (def.check) await def.check(ctx.pool, { payload: payload as never, organizationId, refId });

  // Zelfde sleutel al open, uitgevoerd of afgewezen: niet opnieuw voorstellen (een
  // afgewezen voorstel komt dus niet elke ronde terug). Na verlopen, intrekken of mislukken wel.
  if (input.dedupeKey) {
    const existing = await one<Proposal>(
      ctx.pool,
      `${PROPOSAL_SELECT} WHERE p.dedupe_key = $1 AND p.status NOT IN ('verlopen', 'ingetrokken', 'mislukt')
        ORDER BY p.created_at DESC LIMIT 1`,
      [input.dedupeKey],
    );
    if (existing) return { proposal: existing, created: false };
  }
  const open = await one<{ n: string }>(
    ctx.pool,
    "SELECT count(*) AS n FROM agent_proposal WHERE agent_key = $1 AND status = 'voorgesteld'",
    [actor.agentKey],
  );
  if (Number(open?.n ?? 0) >= agent.max_open_proposals) {
    throw new PlatformError('te_veel_verzoeken', 'Deze agent heeft te veel openstaande voorstellen. Handel eerst de wachtrij af.');
  }

  let id: string;
  try {
    id = await withTransaction(ctx.pool, async (c) => {
      const r = await one<{ id: string }>(
        c,
        `INSERT INTO agent_proposal (agent_key, run_id, kind, ref_id, organization_id, title, rationale, payload,
                                     payload_sha256, impact, amount_cents, dedupe_key, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now() + make_interval(hours => $13))
         RETURNING id`,
        [
          actor.agentKey,
          input.runId ?? null,
          def.kind,
          refId,
          organizationId,
          title,
          rationale,
          JSON.stringify(payload),
          payloadHash(payload),
          def.impact,
          input.amountCents ?? null,
          input.dedupeKey ?? null,
          hours,
        ],
      );
      await opsAudit(c, actor, {
        action: 'ops.voorstel_gedaan',
        organizationId,
        subject: r!.id,
        detail: { soort: def.kind, titel: title, impact: def.impact },
      });
      return r!.id;
    });
  } catch (err) {
    if (isUniqueViolation(err) && input.dedupeKey) {
      const existing = await one<Proposal>(
        ctx.pool,
        `${PROPOSAL_SELECT} WHERE p.dedupe_key = $1 AND p.status IN ('voorgesteld', 'goedgekeurd', 'bezig')`,
        [input.dedupeKey],
      );
      if (existing) return { proposal: existing, created: false };
    }
    throw err;
  }

  if (def.autoApprove && def.impact === 'geen') {
    await ctx.pool.query(
      `UPDATE agent_proposal SET status = 'goedgekeurd', decided_at = now(), decided_via = 'automatisch'
        WHERE id = $1 AND status = 'voorgesteld'`,
      [id],
    );
    await opsAudit(ctx.pool, actor, { action: 'ops.voorstel_automatisch_goedgekeurd', organizationId, subject: id, detail: { soort: def.kind } });
    return { proposal: await executeProposal(ctx, actor, id), created: true };
  }
  return { proposal: (await getProposal(ctx.pool, id))!, created: true };
}

export async function getProposal(q: Queryable, id: string): Promise<Proposal | undefined> {
  if (!UUID.test(id)) return undefined;
  return one<Proposal>(q, `${PROPOSAL_SELECT} WHERE p.id = $1`, [id]);
}

/**
 * Een medewerker keurt goed of wijst af. Met execute (standaard) wordt een
 * goedgekeurd voorstel direct uitgevoerd: "één druk op de knop".
 */
export async function decideProposal(
  ctx: OpsContext,
  actor: Extract<OpsActor, { kind: 'medewerker' }>,
  id: string,
  decision: { approve: boolean; note?: string; execute?: boolean },
): Promise<Proposal> {
  // Expliciet: alleen een ingelogde medewerker beslist, nooit een agent of het systeem.
  if ((actor as OpsActor).kind !== 'medewerker' || !actor.userId) {
    throw new PlatformError('geen_toegang', 'Alleen een medewerker kan een voorstel goedkeuren of afwijzen.');
  }
  if (!UUID.test(id)) throw notFound('Dit voorstel');
  const note = decision.note?.trim().slice(0, 1000) || null;
  const result = await withTransaction(ctx.pool, async (c) => {
    const p = await one<Proposal & { expired: boolean }>(
      c,
      'SELECT *, expires_at <= now() AS expired FROM agent_proposal WHERE id = $1 FOR UPDATE',
      [id],
    );
    if (!p) throw notFound('Dit voorstel');
    if (p.status !== 'voorgesteld') throw new PlatformError('conflict', `Over dit voorstel is al besloten (${p.status}).`);
    if (p.expired) {
      await c.query("UPDATE agent_proposal SET status = 'verlopen' WHERE id = $1", [id]);
      return { expired: true as const };
    }
    const def = KINDS.get(p.kind);
    if (!def) throw new PlatformError('conflict', `Deze soort voorstel (${p.kind}) is niet meer bekend in deze versie.`);
    if (decision.approve && !canApprove(actor.role, def)) {
      throw new PlatformError('geen_toegang', `Je rol (${actor.role}) mag "${def.label}" niet goedkeuren.`);
    }
    if (!decision.approve && actor.role === 'lezer') {
      throw new PlatformError('geen_toegang', 'Een lezer kan geen voorstellen afwijzen.');
    }
    await c.query(
      `UPDATE agent_proposal SET status = $2, decided_by = $3, decided_at = now(), decided_via = 'medewerker', decision_note = $4
        WHERE id = $1`,
      [id, decision.approve ? 'goedgekeurd' : 'afgewezen', actor.userId, note],
    );
    await opsAudit(c, actor, {
      action: decision.approve ? 'ops.voorstel_goedgekeurd' : 'ops.voorstel_afgewezen',
      organizationId: p.organization_id,
      subject: id,
      detail: { soort: p.kind, agent: p.agent_key, ...(note ? { toelichting: note } : {}) },
    });
    return { expired: false as const };
  });
  if (result.expired) throw new PlatformError('verlopen', 'Dit voorstel is verlopen. Laat de agent een nieuw voorstel doen.');
  if (decision.approve && (decision.execute ?? true)) return executeProposal(ctx, actor, id);
  return (await getProposal(ctx.pool, id))!;
}

/**
 * Voert een goedgekeurd voorstel uit. Precies één keer: de status gaat
 * atomair van 'goedgekeurd' naar 'bezig'. Controleert vooraf de hash.
 */
export async function executeProposal(ctx: OpsContext, actor: OpsActor, id: string): Promise<Proposal> {
  const claimed = await one<Proposal>(
    ctx.pool,
    `UPDATE agent_proposal SET status = 'bezig' WHERE id = $1 AND status = 'goedgekeurd' RETURNING *`,
    [id],
  );
  if (!claimed) {
    const p = await getProposal(ctx.pool, id);
    if (!p) throw notFound('Dit voorstel');
    throw new PlatformError('conflict', `Dit voorstel kan nu niet worden uitgevoerd (${p.status}).`);
  }
  // Een agent mag alleen voorstellen uitvoeren die automatisch zijn goedgekeurd.
  if (actor.kind === 'agent' && claimed.decided_via !== 'automatisch') {
    await ctx.pool.query("UPDATE agent_proposal SET status = 'goedgekeurd' WHERE id = $1 AND status = 'bezig'", [id]);
    throw new PlatformError('geen_toegang', 'Een agent kan een door een mens goedgekeurd voorstel niet zelf uitvoeren.');
  }
  const def = KINDS.get(claimed.kind);
  let status: 'uitgevoerd' | 'mislukt' = 'uitgevoerd';
  let result: Record<string, unknown>;
  try {
    if (!def) throw new Error(`Onbekende soort ${claimed.kind}`);
    if (payloadHash(claimed.payload) !== claimed.payload_sha256) throw new Error('Inhoud wijkt af van wat is voorgesteld');
    if (claimed.decided_via === 'automatisch' && (def.impact !== 'geen' || !def.autoApprove)) {
      throw new Error('Automatisch goedgekeurd, maar deze soort vraagt een mens');
    }
    const payload = def.parse(claimed.payload);
    result = await def.execute(ctx, { proposal: claimed, payload, approvedBy: claimed.decided_by });
  } catch (err) {
    status = 'mislukt';
    const msg = err instanceof Error ? err.message : String(err);
    result = { fout: msg.slice(0, 1000) };
    await recordError(ctx.pool, {
      source: 'agent',
      message: `Voorstel ${claimed.kind} mislukt: ${msg}`,
      organizationId: claimed.organization_id,
      context: { voorstel: id, agent: claimed.agent_key },
    });
  }
  await ctx.pool.query(
    `UPDATE agent_proposal SET status = $2, result = $3, executed_at = now() WHERE id = $1 AND status = 'bezig'`,
    [id, status, JSON.stringify(result)],
  );
  await opsAudit(ctx.pool, actor, {
    action: status === 'uitgevoerd' ? 'ops.voorstel_uitgevoerd' : 'ops.voorstel_mislukt',
    organizationId: claimed.organization_id,
    subject: id,
    detail: { soort: claimed.kind, agent: claimed.agent_key, uitkomst: result },
  });
  return (await getProposal(ctx.pool, id))!;
}

/** Een agent trekt zijn eigen open voorstel in (bijv. omdat het probleem vanzelf is opgelost). */
export async function withdrawProposal(pool: pg.Pool, actor: Extract<OpsActor, { kind: 'agent' }>, id: string, reason: string): Promise<boolean> {
  const r = await one<{ organization_id: string | null }>(
    pool,
    `UPDATE agent_proposal SET status = 'ingetrokken', result = $3
      WHERE id = $1 AND agent_key = $2 AND status = 'voorgesteld' RETURNING organization_id`,
    [id, actor.agentKey, JSON.stringify({ reden: reason.slice(0, 400) })],
  );
  if (!r) return false;
  await opsAudit(pool, actor, { action: 'ops.voorstel_ingetrokken', organizationId: r.organization_id, subject: id, detail: { reden: reason } });
  return true;
}

/** Zet verlopen voorstellen op 'verlopen'. Geeft het aantal terug. */
export async function expireProposals(q: Queryable): Promise<number> {
  const r = await q.query("UPDATE agent_proposal SET status = 'verlopen' WHERE status = 'voorgesteld' AND expires_at <= now()");
  return r.rowCount ?? 0;
}

/**
 * De wachtrij en geschiedenis. Open voorstellen: eerst financieel, dan klant,
 * dan op bedrag en leeftijd.
 */
export async function listProposals(
  q: Queryable,
  opts: { status?: ProposalStatus | 'open'; agentKey?: string; kind?: string; organizationId?: string; limit?: number } = {},
): Promise<Proposal[]> {
  return many<Proposal>(
    q,
    `${PROPOSAL_SELECT}
      WHERE ($1::text IS NULL OR ($1 = 'open' AND p.status = 'voorgesteld' AND p.expires_at > now()) OR p.status = $1)
        AND ($2::text IS NULL OR p.agent_key = $2) AND ($3::text IS NULL OR p.kind = $3)
        AND ($4::uuid IS NULL OR p.organization_id = $4)
      ORDER BY (p.status = 'voorgesteld') DESC,
               CASE p.impact WHEN 'financieel' THEN 0 WHEN 'klant' THEN 1 ELSE 2 END,
               p.amount_cents DESC NULLS LAST, p.created_at DESC
      LIMIT $5`,
    [opts.status ?? null, opts.agentKey ?? null, opts.kind ?? null, opts.organizationId ?? null, Math.min(Math.max(opts.limit ?? 50, 1), 500)],
  );
}

export interface AgentOverviewRow {
  key: string;
  name: string;
  description: string;
  enabled: boolean;
  paused_reason: string | null;
  last_run_at: Date | null;
  last_run_status: string | null;
  last_run_summary: string | null;
  runs_24h: number;
  failed_runs_24h: number;
  open_proposals: number;
  approved_30d: number;
  rejected_30d: number;
  auto_30d: number;
  executed_30d: number;
  failed_30d: number;
}

/** Per agent: wat deed hij, hoe vaak keurt een mens zijn voorstellen goed, wat mislukte. */
export async function agentOverview(q: Queryable): Promise<AgentOverviewRow[]> {
  const rows = await many<Record<string, unknown>>(
    q,
    `SELECT a.key, a.name, a.description, a.enabled, a.paused_reason,
            lr.started_at AS last_run_at, lr.status AS last_run_status, lr.summary AS last_run_summary,
            (SELECT count(*) FROM agent_run r WHERE r.agent_key = a.key AND r.started_at > now() - interval '24 hours') AS runs_24h,
            (SELECT count(*) FROM agent_run r WHERE r.agent_key = a.key AND r.status = 'mislukt' AND r.started_at > now() - interval '24 hours') AS failed_runs_24h,
            count(p.*) FILTER (WHERE p.status = 'voorgesteld' AND p.expires_at > now()) AS open_proposals,
            count(p.*) FILTER (WHERE p.decided_via = 'medewerker' AND p.status IN ('goedgekeurd', 'bezig', 'uitgevoerd', 'mislukt') AND p.created_at > now() - interval '30 days') AS approved_30d,
            count(p.*) FILTER (WHERE p.status = 'afgewezen' AND p.created_at > now() - interval '30 days') AS rejected_30d,
            count(p.*) FILTER (WHERE p.decided_via = 'automatisch' AND p.created_at > now() - interval '30 days') AS auto_30d,
            count(p.*) FILTER (WHERE p.status = 'uitgevoerd' AND p.created_at > now() - interval '30 days') AS executed_30d,
            count(p.*) FILTER (WHERE p.status = 'mislukt' AND p.created_at > now() - interval '30 days') AS failed_30d
       FROM agent a
       LEFT JOIN LATERAL (SELECT started_at, status, summary FROM agent_run r WHERE r.agent_key = a.key
                           ORDER BY started_at DESC LIMIT 1) lr ON true
       LEFT JOIN agent_proposal p ON p.agent_key = a.key
      GROUP BY a.key, lr.started_at, lr.status, lr.summary
      ORDER BY a.name`,
  );
  return rows.map((r) => ({
    ...(r as unknown as AgentOverviewRow),
    runs_24h: Number(r.runs_24h),
    failed_runs_24h: Number(r.failed_runs_24h),
    open_proposals: Number(r.open_proposals),
    approved_30d: Number(r.approved_30d),
    rejected_30d: Number(r.rejected_30d),
    auto_30d: Number(r.auto_30d),
    executed_30d: Number(r.executed_30d),
    failed_30d: Number(r.failed_30d),
  }));
}

export async function listRuns(q: Queryable, opts: { agentKey?: string; limit?: number } = {}) {
  return many<{ id: string; agent_key: string; status: string; summary: string | null; stats: Record<string, unknown> | null; started_at: Date; finished_at: Date | null }>(
    q,
    `SELECT id, agent_key, status, summary, stats, started_at, finished_at FROM agent_run
      WHERE ($1::text IS NULL OR agent_key = $1) ORDER BY started_at DESC LIMIT $2`,
    [opts.agentKey ?? null, Math.min(Math.max(opts.limit ?? 50, 1), 500)],
  );
}
