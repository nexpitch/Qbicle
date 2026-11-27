import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryMailer, PlatformError } from '@qbicle/platform';
import { createTestPlatform, hasDb, type TestPlatform } from '../../platform/test/support/db.ts';
import {
  addTicketMessage,
  agentOverview,
  aiCostMicros,
  applyBrevoEvent,
  assertAiBudget,
  createTicket,
  decideProposal,
  detectUsageSignals,
  ensureAgent,
  getTicket,
  healthSummary,
  limitStatus,
  listErrors,
  listOpsActivity,
  listProposals,
  listScanJobs,
  loadUsageConfig,
  LoggingMailer,
  meteredAiCall,
  parseUsageConfig,
  propose,
  recordAiCall,
  recordError,
  recordUsage,
  registerProposalKind,
  replyToCustomer,
  runBewaker,
  setAgentEnabled,
  ticketContext,
  usageOverview,
  usageTotals,
  usageTrend,
  type OpsContext,
} from '../src/index.ts';

const config = loadUsageConfig();

describe('kosten van AI-aanroepen', () => {
  it('rekent per miljoen tokens in dollars om naar micro-euro', () => {
    // 1M invoer x $4 + 100k uitvoer x $20 = $6 -> x 0,92 = 5,52 euro
    expect(aiCostMicros(config, 'claude-opus-5-5', { input_tokens: 1_000_000, output_tokens: 100_000 })).toBe(5_520_000);
    expect(aiCostMicros(config, 'claude-haiku-5-5', { input_tokens: 1000, output_tokens: 0, cache_read_input_tokens: 1000 })).toBe(Math.ceil(110 * 0.92));
  });
  it('rekent een onbekend model met het duurste tarief', () => {
    const known = aiCostMicros(config, 'claude-opus-5-5', { input_tokens: 0, output_tokens: 1000 });
    expect(aiCostMicros(config, 'iets-nieuws', { input_tokens: 0, output_tokens: 1000 })).toBe(known);
  });
  it('weigert een config zonder gratis-limieten', () => {
    const raw = JSON.parse(JSON.stringify({ ...config, limieten: { mkb: config.limieten.mkb } }));
    expect(() => parseUsageConfig(raw)).toThrow(/gratis/);
  });
});

describe.skipIf(!hasDb)('cockpit: gebruik, gezondheid, support en agents', () => {
  let p: TestPlatform;
  let ctx: OpsContext;
  let mailer: MemoryMailer;
  let orgId: string;
  let ownerId: string;
  let staffId: string;
  let domainId: string;
  const support = () => ({ kind: 'medewerker' as const, userId: staffId, role: 'support' as const });
  const beheerder = () => ({ kind: 'medewerker' as const, userId: staffId, role: 'beheerder' as const });
  const financieel = () => ({ kind: 'medewerker' as const, userId: staffId, role: 'financieel' as const });
  const agent = { kind: 'agent' as const, agentKey: 'test-agent' };

  async function scan(status: string, opts: { startedMinutesAgo?: number; attempts?: number } = {}): Promise<string> {
    const r = await p.pool.query(
      `INSERT INTO scan (domain_id, trigger, status, started_at, attempts)
       VALUES ($1, 'handmatig', $2, CASE WHEN $3::int IS NULL THEN NULL ELSE now() - make_interval(mins => $3::int) END, $4) RETURNING id`,
      [domainId, status, opts.startedMinutesAgo ?? null, opts.attempts ?? 0],
    );
    return r.rows[0].id;
  }

  beforeAll(async () => {
    p = await createTestPlatform();
    mailer = new MemoryMailer();
    ctx = { pool: p.pool, config, mailer };
    const o = await p.pool.query("INSERT INTO organization (name, kind) VALUES ('Bakkerij Jansen', 'klant') RETURNING id");
    orgId = o.rows[0].id;
    const u = await p.pool.query("INSERT INTO app_user (email) VALUES ('eigenaar@jansen.nl') RETURNING id");
    ownerId = u.rows[0].id;
    await p.pool.query("INSERT INTO membership (organization_id, user_id, role) VALUES ($1, $2, 'eigenaar')", [orgId, ownerId]);
    const s = await p.pool.query("INSERT INTO app_user (email) VALUES ('erik@qbicle.test') RETURNING id");
    staffId = s.rows[0].id;
    const d = await p.pool.query(
      "INSERT INTO domain (organization_id, name, verification_token) VALUES ($1, 'jansen.nl', 'x') RETURNING id",
      [orgId],
    );
    domainId = d.rows[0].id;
    await p.pool.query(
      `INSERT INTO subscription (organization_id, plan, billing_interval, monthly_price_cents, status, current_period_start, current_period_end)
       VALUES ($1, 'mkb', 'jaar', 4900, 'actief', now(), now() + interval '1 year')`,
      [orgId],
    );
    await ensureAgent(p.pool, { key: 'test-agent', name: 'Testagent', description: 'Voor tests', maxOpenProposals: 5 });
  });
  afterAll(async () => p?.close());

  describe('gebruiksmeting', () => {
    it('legt AI-aanroepen per klant en functie vast en telt op per dag', async () => {
      await recordAiCall(ctx, { organizationId: orgId, feature: 'samenvatting', model: 'claude-haiku-5-5', usage: { input_tokens: 1000, output_tokens: 200 } });
      await recordAiCall(ctx, { organizationId: orgId, feature: 'samenvatting', model: 'claude-haiku-5-5', usage: { input_tokens: 500, output_tokens: 100 } });
      await recordUsage(p.pool, { organizationId: orgId, metric: 'api', feature: 'GET /domeinen', quantity: 3 });
      const today = new Date().toISOString().slice(0, 10);
      const t = await usageTotals(p.pool, orgId, '2000-01-01', '2999-01-01');
      expect(t).toMatchObject({ aiCalls: 2, aiInputTokens: 1500, aiOutputTokens: 300, apiCalls: 3 });
      expect(t.aiCostMicros).toBeGreaterThan(0);
      const trend = await usageTrend(p.pool, orgId, 3);
      expect(trend).toHaveLength(3);
      expect(trend.at(-1)!.ai_tokens + trend.at(-2)!.ai_tokens).toBe(1800);
      expect(today).toMatch(/^\d{4}/);
    });

    it('telt scans uit de scantabel en berekent marge per klant', async () => {
      await scan('klaar');
      const rows = await usageOverview(ctx, '2000-01-01', '2999-01-01');
      const r = rows.find((x) => x.organization_id === orgId)!;
      expect(r).toMatchObject({ name: 'Bakkerij Jansen', plan: 'mkb', mrr_cents: 4900, ai_tokens: 1800, domains: 1 });
      expect(r.scans).toBeGreaterThanOrEqual(1);
      expect(r.cost_micros).toBeGreaterThan(0);
      expect(r.margin_cents).toBeLessThanOrEqual(4900);
    });

    it('waarschuwt bij limieten en blokkeert AI boven het budget', async () => {
      await assertAiBudget(ctx, orgId);
      await recordAiCall(ctx, { organizationId: orgId, feature: 'actielijst', model: 'claude-haiku-5-5', usage: { input_tokens: 850_000, output_tokens: 0 } });
      let s = await limitStatus(ctx, orgId);
      expect(s.find((x) => x.metric === 'ai_tokens_maand')!.status).toBe('waarschuwing');
      const signals = await detectUsageSignals(ctx);
      expect(signals.some((x) => x.organizationId === orgId && x.kind === 'limiet_bijna' && x.metric === 'ai_tokens_maand')).toBe(true);
      await recordAiCall(ctx, { organizationId: orgId, feature: 'actielijst', model: 'claude-haiku-5-5', usage: { input_tokens: 200_000, output_tokens: 0 } });
      s = await limitStatus(ctx, orgId);
      expect(s.find((x) => x.metric === 'ai_tokens_maand')!.status).toBe('over');
      await expect(assertAiBudget(ctx, orgId)).rejects.toThrow(/AI-limiet/);
      // meteredAiCall roept het model dan niet aan, maar legt de weigering wel vast.
      let called = false;
      await expect(
        meteredAiCall(ctx, { organizationId: orgId, feature: 'actielijst', model: 'claude-haiku-5-5' }, async () => {
          called = true;
          return { usage: { input_tokens: 1, output_tokens: 1 } };
        }),
      ).rejects.toBeInstanceOf(PlatformError);
      expect(called).toBe(false);
      const r = await p.pool.query("SELECT count(*)::int AS n FROM ai_call WHERE outcome = 'begrensd'");
      expect(r.rows[0].n).toBe(1);
    });
  });

  describe('voorstellen en goedkeuring', () => {
    it('agent kan voorstellen, maar een financieel voorstel vraagt de juiste rol', async () => {
      const { proposal, created } = await propose(ctx, agent, {
        kind: 'limiet.aanpassen',
        title: 'Meer AI-tokens voor Bakkerij Jansen',
        rationale: 'Klant zit over de limiet; tijdelijk verhogen.',
        payload: { metric: 'ai_tokens_maand', limit: 2_000_000, reason: 'Tijdelijk, afgesproken met klant' },
        organizationId: orgId,
        dedupeKey: 'limiet:jansen',
      });
      expect(created).toBe(true);
      expect(proposal).toMatchObject({ status: 'voorgesteld', impact: 'financieel', organization_name: 'Bakkerij Jansen' });

      // Zelfde dedupeKey: geen tweede voorstel.
      const again = await propose(ctx, agent, {
        kind: 'limiet.aanpassen',
        title: 'Nogmaals',
        rationale: 'x',
        payload: { metric: 'ai_tokens_maand', limit: 3_000_000, reason: 'x' },
        organizationId: orgId,
        dedupeKey: 'limiet:jansen',
      });
      expect(again).toMatchObject({ created: false, proposal: { id: proposal.id } });

      // Een agent kan niet beslissen, ook niet met een gefingeerde actor.
      await expect(decideProposal(ctx, agent as never, proposal.id, { approve: true })).rejects.toThrow(/medewerker/);
      // Support mag geen financieel voorstel goedkeuren.
      await expect(decideProposal(ctx, support(), proposal.id, { approve: true })).rejects.toThrow(/mag/);
      // Lezer mag niets.
      await expect(
        decideProposal(ctx, { kind: 'medewerker', userId: staffId, role: 'lezer' }, proposal.id, { approve: true }),
      ).rejects.toThrow();

      // Inhoud is bevroren.
      await expect(p.pool.query(`UPDATE agent_proposal SET payload = '{"metric":"ai_tokens_maand","limit":null}' WHERE id = $1`, [proposal.id])).rejects.toThrow(
        /niet worden gewijzigd/,
      );
      await expect(p.pool.query('DELETE FROM agent_proposal WHERE id = $1', [proposal.id])).rejects.toThrow(/bewaard/);

      // Financieel keurt goed en voert in één keer uit.
      const done = await decideProposal(ctx, financieel(), proposal.id, { approve: true, note: 'Akkoord' });
      expect(done).toMatchObject({ status: 'uitgevoerd', decided_via: 'medewerker', decided_by: staffId });
      const s = await limitStatus(ctx, orgId);
      expect(s.find((x) => x.metric === 'ai_tokens_maand')).toMatchObject({ limit: 2_000_000, status: 'ok' });

      // Een besluit is definitief.
      await expect(decideProposal(ctx, beheerder(), proposal.id, { approve: false })).rejects.toThrow(/al besloten/);
      await expect(p.pool.query('UPDATE agent_proposal SET decided_by = NULL WHERE id = $1', [proposal.id])).rejects.toThrow(/definitief|niet worden gewijzigd/);

      const log = await listOpsActivity(p.pool, { limit: 20 });
      const actions = log.filter((l) => l.subject === proposal.id).map((l) => l.action);
      expect(actions).toEqual(expect.arrayContaining(['ops.voorstel_gedaan', 'ops.voorstel_goedgekeurd', 'ops.voorstel_uitgevoerd']));
      expect(log.find((l) => l.action === 'ops.voorstel_gedaan')!.actor).toBe('agent:test-agent');
    });

    it('afwijzen voert niets uit; verlopen voorstellen kunnen niet meer goedgekeurd worden', async () => {
      const a = await propose(ctx, agent, {
        kind: 'klant.bericht', title: 'Mail klant', rationale: 'Test', payload: { subject: 'Hoi', body: 'Test' }, organizationId: orgId,
      });
      const rejected = await decideProposal(ctx, support(), a.proposal.id, { approve: false, note: 'Niet nodig' });
      expect(rejected.status).toBe('afgewezen');
      expect(mailer.sent).toHaveLength(0);

      const b = await propose(ctx, agent, {
        kind: 'klant.bericht', title: 'Mail klant', rationale: 'Test', payload: { subject: 'Hoi', body: 'Test' }, organizationId: orgId, expiresInHours: 1,
      });
      await p.pool.query("UPDATE agent_proposal SET expires_at = now() - interval '1 minute' WHERE id = $1", [b.proposal.id]);
      await expect(decideProposal(ctx, support(), b.proposal.id, { approve: true })).rejects.toThrow(/verlopen/);
    });

    it('klant.bericht mailt alleen de eigenaren', async () => {
      const a = await propose(ctx, agent, {
        kind: 'klant.bericht', title: 'Limiet', rationale: 'Test', payload: { subject: 'Je limiet', body: 'Bijna op' }, organizationId: orgId,
      });
      await decideProposal(ctx, support(), a.proposal.id, { approve: true });
      expect(mailer.sent.map((m) => m.to)).toEqual(['eigenaar@jansen.nl']);
    });

    it('noodrem: een gepauzeerde agent kan niets voorstellen; alleen een beheerder pauzeert', async () => {
      await expect(setAgentEnabled(p.pool, support(), 'test-agent', false)).rejects.toThrow(/beheerder/);
      await setAgentEnabled(p.pool, beheerder(), 'test-agent', false, 'Test');
      await expect(
        propose(ctx, agent, { kind: 'ticket.melding', title: 'x', rationale: 'x', payload: { subject: 'x', body: 'x' } }),
      ).rejects.toThrow(/gepauzeerd/);
      await setAgentEnabled(p.pool, beheerder(), 'test-agent', true);
    });

    it('weigert onbekende soorten, ongeldige payloads en automatisch goedkeuren met impact', async () => {
      await expect(propose(ctx, agent, { kind: 'geld.overmaken', title: 'x', rationale: 'x', payload: {} })).rejects.toThrow(/Onbekende soort/);
      await expect(
        propose(ctx, agent, { kind: 'limiet.aanpassen', title: 'x', rationale: 'x', payload: { metric: 'alles', limit: 1, reason: 'x' }, organizationId: orgId }),
      ).rejects.toThrow(/Onbekende limiet/);
      expect(() =>
        registerProposalKind({ kind: 'test.fout', label: 'x', impact: 'financieel', approvers: ['financieel'], autoApprove: true, parse: (x) => x as never, execute: async () => ({}) }),
      ).toThrow(/impact 'geen'/);
    });

    it('generiek: een andere module (bijv. incasso) hangt eigen soorten met ref_id aan de wachtrij', async () => {
      const executed: string[] = [];
      registerProposalKind<{ runId: string }>({
        kind: 'incasso.batch',
        label: 'Incassobatch indienen',
        impact: 'financieel',
        approvers: ['financieel'],
        parse: (x) => ({ runId: String((x as { runId: string }).runId) }),
        execute: async (_c, { payload }) => {
          executed.push(payload.runId);
          return { ingediend: 3 };
        },
      });
      const { proposal } = await propose(ctx, agent, {
        kind: 'incasso.batch', title: 'Incasso december', rationale: '3 abonnementen', payload: { runId: 'run-1' }, refId: 'run-1', amountCents: 14700,
      });
      const open = await listProposals(p.pool, { status: 'open' });
      expect(open[0]!.id).toBe(proposal.id); // financieel bovenaan
      await decideProposal(ctx, financieel(), proposal.id, { approve: true });
      expect(executed).toEqual(['run-1']);
    });
  });

  describe('gezondheid en bewakingsagent', () => {
    it('ziet vastgelopen scans en zet ze automatisch opnieuw in de wachtrij', async () => {
      const stuck = await scan('bezig', { startedMinutesAgo: 90 });
      const busy = await scan('bezig', { startedMinutesAgo: 2 });
      const vast = await listScanJobs(ctx, 'vast');
      expect(vast.map((s) => s.id)).toContain(stuck);
      expect(vast.map((s) => s.id)).not.toContain(busy);
      expect((await healthSummary(ctx)).redenen.join(' ')).toMatch(/hangen/);

      const { stats } = await runBewaker(ctx);
      expect(stats.scansOpnieuw).toBe(1);
      const r = await p.pool.query('SELECT status, attempts FROM scan WHERE id = $1', [stuck]);
      expect(r.rows[0]).toEqual({ status: 'wachtrij', attempts: 1 });
      const auto = await listProposals(p.pool, { kind: 'scan.opnieuw' });
      expect(auto[0]).toMatchObject({ status: 'uitgevoerd', decided_via: 'automatisch', decided_by: null });

      // Na 3 pogingen: interne melding in plaats van opnieuw proberen.
      const hopeless = await scan('bezig', { startedMinutesAgo: 90, attempts: 3 });
      await runBewaker(ctx);
      const t = await p.pool.query("SELECT subject, channel, priority FROM support_ticket WHERE subject LIKE 'Scan jansen.nl%'");
      expect(t.rows[0]).toMatchObject({ channel: 'agent', priority: 'hoog' });
      expect((await p.pool.query('SELECT status FROM scan WHERE id = $1', [hopeless])).rows[0].status).toBe('bezig');

      // Tweede ronde: geen dubbele meldingen.
      const second = await runBewaker(ctx);
      expect(second.stats.scanMeldingen).toBe(0);
      const ov = await agentOverview(p.pool);
      expect(ov.find((a) => a.key === 'ops-bewaker')).toMatchObject({ enabled: true, last_run_status: 'klaar' });
    });

    it('groepeert gelijke fouten', async () => {
      await recordError(p.pool, { source: 'scanner', message: 'Timeout na 3000 ms voor 192.0.2.1', organizationId: orgId });
      await recordError(p.pool, { source: 'scanner', message: 'Timeout na 5000 ms voor 192.0.2.7', organizationId: orgId });
      const e = await listErrors(p.pool, { source: 'scanner' });
      expect(e).toHaveLength(1);
      expect(e[0]).toMatchObject({ occurrences: 2, organization_name: 'Bakkerij Jansen' });
    });

    it('logt mails en verwerkt bezorgstatus van Brevo', async () => {
      const inner = new MemoryMailer();
      const lm = new LoggingMailer(inner, p.pool, 'brevo');
      await lm.send({ to: 'eigenaar@jansen.nl', subject: 'Je inloglink', text: 'x' });
      expect(inner.sent).toHaveLength(1);
      expect(await applyBrevoEvent(p.pool, { event: 'hard_bounce', email: 'eigenaar@jansen.nl', subject: 'Je inloglink', reason: 'mailbox bestaat niet' })).toBe(true);
      // Een latere 'delivered' zet een bounce niet terug.
      await applyBrevoEvent(p.pool, { event: 'delivered', email: 'eigenaar@jansen.nl', subject: 'Je inloglink' });
      const m = await p.pool.query("SELECT status, error FROM mail_event WHERE subject = 'Je inloglink'");
      expect(m.rows[0]).toEqual({ status: 'gebounced', error: 'mailbox bestaat niet' });
      const failing = new LoggingMailer({ send: async () => { throw new Error('Brevo 401'); } }, p.pool, 'brevo');
      await expect(failing.send({ to: 'x@y.nl', subject: 'Test', text: 'x' })).rejects.toThrow();
      expect((await listErrors(p.pool, { source: 'mail' })).length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('support', () => {
    it('koppelt een ticket via het mailadres aan de klant en geeft context', async () => {
      const t = await createTicket(p.pool, { kind: 'klant', userId: null }, {
        channel: 'mail', requesterEmail: 'Eigenaar@Jansen.nl', subject: 'Scan loopt niet', body: 'Mijn scan blijft hangen', category: 'scan',
      });
      expect(t).toMatchObject({ organization_id: orgId, organization_name: 'Bakkerij Jansen', status: 'open', number: expect.any(Number) });
      const c = await ticketContext(ctx, t.id);
      expect(c.organisatie).toMatchObject({ name: 'Bakkerij Jansen', plan: 'mkb', abonnement_status: 'actief' });
      expect(c.domeinen!.map((d) => d.name)).toEqual(['jansen.nl']);
      expect(c.laatsteScans!.length).toBeGreaterThan(0);
      expect(c.fouten!.length).toBeGreaterThan(0);
      expect(c.mails.length).toBeGreaterThan(0);
    });

    it('agent schrijft alleen interne notities; zijn antwoord aan de klant gaat via goedkeuring', async () => {
      const t = await createTicket(p.pool, { kind: 'klant', userId: null }, {
        channel: 'mail', requesterEmail: 'eigenaar@jansen.nl', subject: 'Factuur kwijt', body: 'Waar vind ik mijn factuur?',
      });
      const note = await addTicketMessage(p.pool, agent, t.id, { body: 'Klant heeft 1 factuur', internal: false });
      expect(note.internal).toBe(true);
      const before = mailer.sent.length;
      const { proposal } = await propose(ctx, agent, {
        kind: 'ticket.antwoord', title: 'Antwoord: factuur', rationale: 'Standaardvraag',
        payload: { ticketId: t.id, body: 'Je vindt je facturen in je account onder Abonnement.' }, organizationId: orgId, refId: t.id,
      });
      expect(mailer.sent.length).toBe(before);
      await decideProposal(ctx, support(), proposal.id, { approve: true });
      expect(mailer.last('eigenaar@jansen.nl')!.subject).toContain(`#${t.number}`);
      const { ticket, messages } = await getTicket(p.pool, t.id);
      expect(ticket.status).toBe('wacht_op_klant');
      expect(ticket.first_response_at).not.toBeNull();
      expect(messages.filter((m) => !m.internal).map((m) => m.author_kind)).toEqual(['klant', 'agent']);

      // Medewerker antwoordt zelf; klant reageert: ticket weer open.
      await replyToCustomer(ctx, support(), t.id, 'Gevonden?');
      await addTicketMessage(p.pool, { kind: 'klant', userId: ownerId }, t.id, { body: 'Ja, dank je' });
      expect((await getTicket(p.pool, t.id)).ticket.status).toBe('open');
    });

    it('antwoord-voorstel moet bij de klant van het ticket horen', async () => {
      const t = await createTicket(p.pool, { kind: 'klant', userId: null }, { channel: 'mail', requesterEmail: 'onbekend@elders.nl', subject: 'Vraag', body: 'Hallo' });
      await expect(
        propose(ctx, agent, { kind: 'ticket.antwoord', title: 'x', rationale: 'x', payload: { ticketId: t.id, body: 'x' }, organizationId: orgId }),
      ).rejects.toThrow(/hoort niet/);
    });
  });
});
