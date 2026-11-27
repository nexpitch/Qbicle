import { ACTIONS, FALLBACK_WEIGHT, WEIGHTS, type ForWho } from '@qbicle/score';
import type { Actor } from './audit.ts';
import { audit } from './audit.ts';
import type { Platform } from './context.ts';
import { getDashboard, type DashboardAction, type DashboardAssetRef, type Level } from './dashboard.ts';
import { many, one, withTransaction, type Queryable } from './db.ts';
import { PlatformError } from './errors.ts';
import { authorize } from './organizations.ts';
import { can } from './roles.ts';

/**
 * Afvinkbare acties ("checklist"). De acties zelf komen uit het scoremodel (zie
 * dashboard.ts); hier staat wat de klant ermee deed: opgepakt, afgevinkt, bewust
 * niet, toegewezen aan zijn IT-partner. De scan heeft het laatste woord:
 * - afgevinkt en de volgende scan ziet het niet meer  -> "Bevestigd door scan"
 * - afgevinkt maar de volgende scan ziet het nog       -> "Nog niet opgelost"
 * - bevestigd en het komt later terug                   -> weer open
 * Elke wijziging komt in action_task_log, zodat je later kunt laten zien wie wat
 * wanneer deed (rapportage, verzekeraar).
 */

type UserActor = Actor & { userId: string };

export const TASK_STATUSES = ['open', 'bezig', 'gedaan', 'bevestigd', 'genegeerd'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
/** Wat een gebruiker zelf mag kiezen; "bevestigd" zet alleen de scan. */
export const USER_TASK_STATUSES = ['open', 'bezig', 'gedaan', 'genegeerd'] as const;
export type UserTaskStatus = (typeof USER_TASK_STATUSES)[number];

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  open: 'Nog niet opgepakt',
  bezig: 'Opgepakt',
  gedaan: 'Afgevinkt, wacht op controle',
  bevestigd: 'Bevestigd door scan',
  genegeerd: 'Bewust niet opgepakt',
};

const ASSIGNEES = ['zelf', 'it-partner', 'webbouwer'] as const;

/** Bij welke actie hoort een bevinding (zelfde regel als het scoremodel). */
export function actionKeyFor(findingKey: string): string {
  return (WEIGHTS[findingKey] ?? FALLBACK_WEIGHT).action;
}

export interface TaskLogEntry {
  at: Date;
  /** E-mailadres van wie het deed, of null als het de scan was. */
  who: string | null;
  kind: 'status' | 'notitie' | 'toewijzing' | 'scan';
  fromStatus: TaskStatus | null;
  toStatus: TaskStatus | null;
  text: string | null;
}

export interface ChecklistItem {
  key: string;
  title: string;
  why: string;
  forWho: ForWho;
  /** Ernst volgens het dashboard; "ok" als de scan hem niet meer ziet. */
  level: Level;
  /** Open bevindingen die bij deze actie horen. */
  findingCount: number;
  assets: DashboardAssetRef[];
  status: TaskStatus;
  /** Afgevinkt maar de laatste scan zag het nog. */
  nogNietOpgelost: boolean;
  /** Status in gewone taal, met "Nog niet opgelost" als de scan het nog zag. */
  statusLabel: string;
  note: string | null;
  reason: string | null;
  assignedTo: ForWho | null;
  assigneeName: string | null;
  updatedAt: Date | null;
  updatedBy: string | null;
  doneAt: Date | null;
  doneBy: string | null;
  stillSeenAt: Date | null;
  confirmedAt: Date | null;
  log: TaskLogEntry[];
}

export interface ChecklistSummary {
  /** Alle acties op de lijst behalve "bewust niet". */
  total: number;
  /** Afgevinkt of bevestigd (en niet "nog niet opgelost"). */
  done: number;
  bevestigd: number;
  wachtOpScan: number;
  nogNietOpgelost: number;
  bezig: number;
  open: number;
  genegeerd: number;
}

export interface Checklist {
  items: ChecklistItem[];
  summary: ChecklistSummary;
  /** Mag deze gebruiker afvinken (beheerder of eigenaar, ook via een IT-partner)? */
  magBijwerken: boolean;
}

interface TaskRow {
  action_key: string;
  status: TaskStatus;
  note: string | null;
  reason: string | null;
  assigned_to: ForWho | null;
  assignee_name: string | null;
  updated_at: Date;
  updated_by_email: string | null;
  done_at: Date | null;
  done_by_email: string | null;
  still_seen_at: Date | null;
  confirmed_at: Date | null;
}

interface LogRow {
  action_key: string;
  at: Date;
  who: string | null;
  kind: TaskLogEntry['kind'];
  from_status: TaskStatus | null;
  to_status: TaskStatus | null;
  text: string | null;
}

/** Bevestigde acties blijven zo lang op de lijst staan, als bewijs van wat je oploste. */
export const CONFIRMED_VISIBLE_DAYS = 90;
const DAY = 24 * 60 * 60 * 1000;

const ORDER: Record<TaskStatus, number> = { open: 0, bezig: 0, gedaan: 1, genegeerd: 2, bevestigd: 3 };

/** Zet de acties van het dashboard en wat de klant vastlegde samen tot één lijst. Puur, voor tests. */
export function buildChecklist(actions: DashboardAction[], tasks: TaskRow[], logs: LogRow[], now = new Date()): Omit<Checklist, 'magBijwerken'> {
  const byKey = new Map(tasks.map((t) => [t.action_key, t]));
  const logsByKey = new Map<string, TaskLogEntry[]>();
  for (const l of logs) {
    const list = logsByKey.get(l.action_key) ?? [];
    list.push({ at: l.at, who: l.who, kind: l.kind, fromStatus: l.from_status, toStatus: l.to_status, text: l.text });
    logsByKey.set(l.action_key, list);
  }
  const item = (a: Omit<DashboardAction, 'weight'>, t: TaskRow | undefined, fallback: TaskStatus): ChecklistItem => {
    let status = t?.status ?? fallback;
    // Staat de actie (weer) op het dashboard maar was hij bevestigd, dan is hij open; de scan zet dit ook zelf recht.
    if (status === 'bevestigd' && a.findingCount > 0) status = 'open';
    const nogNietOpgelost = status === 'gedaan' && Boolean(t?.still_seen_at);
    return {
      key: a.key,
      title: a.title,
      why: a.why,
      forWho: a.forWho,
      level: a.level,
      findingCount: a.findingCount,
      assets: a.assets,
      status,
      nogNietOpgelost,
      statusLabel: nogNietOpgelost ? 'Nog niet opgelost' : TASK_STATUS_LABELS[status],
      note: t?.note ?? null,
      reason: t?.reason ?? null,
      assignedTo: t?.assigned_to ?? null,
      assigneeName: t?.assignee_name ?? null,
      updatedAt: t?.updated_at ?? null,
      updatedBy: t?.updated_by_email ?? null,
      doneAt: t?.done_at ?? null,
      doneBy: t?.done_by_email ?? null,
      stillSeenAt: nogNietOpgelost ? t!.still_seen_at : null,
      confirmedAt: status === 'bevestigd' ? (t?.confirmed_at ?? null) : null,
      log: logsByKey.get(a.key) ?? [],
    };
  };

  const items: ChecklistItem[] = actions.map((a) => item(a, byKey.get(a.key), 'open'));
  const onList = new Set(actions.map((a) => a.key));
  // Wat de scan niet meer ziet en bevestigd is: blijft een tijd zichtbaar als "opgelost".
  for (const t of tasks) {
    if (onList.has(t.action_key) || t.status !== 'bevestigd') continue;
    if (t.confirmed_at && now.getTime() - t.confirmed_at.getTime() > CONFIRMED_VISIBLE_DAYS * DAY) continue;
    const def = ACTIONS[t.action_key] ?? { title: 'Bevinding laten beoordelen', why: '', forWho: 'it-partner' as const };
    items.push(item({ key: t.action_key, title: def.title, why: def.why, forWho: def.forWho, level: 'ok', findingCount: 0, assets: [] }, t, 'bevestigd'));
  }
  // Stabiel sorteren: eerst wat nog moet (in de volgorde van het dashboard), dan afgevinkt, dan de rest.
  const idx = new Map(items.map((x, i) => [x, i]));
  items.sort((x, y) => ORDER[x.status] - (x.nogNietOpgelost ? 1 : 0) - (ORDER[y.status] - (y.nogNietOpgelost ? 1 : 0)) || idx.get(x)! - idx.get(y)!);

  const count = (f: (x: ChecklistItem) => boolean) => items.filter(f).length;
  const summary: ChecklistSummary = {
    total: count((x) => x.status !== 'genegeerd'),
    done: count((x) => x.status === 'bevestigd' || (x.status === 'gedaan' && !x.nogNietOpgelost)),
    bevestigd: count((x) => x.status === 'bevestigd'),
    wachtOpScan: count((x) => x.status === 'gedaan' && !x.nogNietOpgelost),
    nogNietOpgelost: count((x) => x.nogNietOpgelost),
    bezig: count((x) => x.status === 'bezig'),
    open: count((x) => x.status === 'open'),
    genegeerd: count((x) => x.status === 'genegeerd'),
  };
  return { items, summary };
}

async function loadTasks(q: Queryable, organizationId: string): Promise<{ tasks: TaskRow[]; logs: LogRow[] }> {
  const [tasks, logs] = await Promise.all([
    many<TaskRow>(
      q,
      `SELECT t.action_key, t.status, t.note, t.reason, t.assigned_to, t.assignee_name, t.updated_at,
              ub.email::text AS updated_by_email, t.done_at, db.email::text AS done_by_email, t.still_seen_at, t.confirmed_at
         FROM action_task t
         LEFT JOIN app_user ub ON ub.id = t.updated_by
         LEFT JOIN app_user db ON db.id = t.done_by
        WHERE t.organization_id = $1`,
      [organizationId],
    ),
    many<LogRow>(
      q,
      `SELECT l.action_key, l.at, u.email::text AS who, l.kind, l.from_status, l.to_status, l.text
         FROM action_task_log l LEFT JOIN app_user u ON u.id = l.actor_user_id
        WHERE l.organization_id = $1 ORDER BY l.at DESC, l.id LIMIT 500`,
      [organizationId],
    ),
  ]);
  return { tasks, logs };
}

/**
 * De checklist van een organisatie. Geef `actions` mee als je het dashboard al
 * hebt opgehaald (scheelt een tweede berekening).
 */
export async function getChecklist(p: Platform, userId: string, organizationId: string, actions?: DashboardAction[]): Promise<Checklist> {
  const access = await authorize(p.pool, userId, organizationId, 'bevindingen:lezen');
  const acts = actions ?? (await getDashboard(p, userId, organizationId)).actions;
  const { tasks, logs } = await loadTasks(p.pool, organizationId);
  return { ...buildChecklist(acts, tasks, logs), magBijwerken: can(access, 'bevindingen:accepteren') };
}

export interface TaskInput {
  status?: UserTaskStatus;
  note?: string | null;
  reason?: string | null;
  assignedTo?: ForWho | null;
  assigneeName?: string | null;
}

const ACTION_KEY = /^[a-z0-9][a-z0-9-]{0,99}$/;

function clean(s: string | null | undefined, max: number): string | null {
  if (s === undefined || s === null) return null;
  const t = s.replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, max) : null;
}

/** Status, notitie of toewijzing van één actie bijwerken. Beheerder of eigenaar. */
export async function updateTask(p: Platform, actor: UserActor, organizationId: string, actionKey: string, input: TaskInput): Promise<void> {
  await authorize(p.pool, actor.userId, organizationId, 'bevindingen:accepteren');
  if (!ACTION_KEY.test(actionKey) || !(actionKey in ACTIONS || actionKey === FALLBACK_WEIGHT.action)) {
    throw new PlatformError('niet_gevonden', 'Deze actie bestaat niet.');
  }
  if (input.status !== undefined && !(USER_TASK_STATUSES as readonly string[]).includes(input.status)) {
    throw new PlatformError('ongeldige_invoer', 'Onbekende status.');
  }
  if (input.assignedTo !== undefined && input.assignedTo !== null && !(ASSIGNEES as readonly string[]).includes(input.assignedTo)) {
    throw new PlatformError('ongeldige_invoer', 'Onbekend aan wie je de actie toewijst.');
  }
  await withTransaction(p.pool, async (q) => {
    const cur = await one<{ status: TaskStatus; note: string | null; reason: string | null; assigned_to: ForWho | null; assignee_name: string | null }>(
      q,
      'SELECT status, note, reason, assigned_to, assignee_name FROM action_task WHERE organization_id = $1 AND action_key = $2 FOR UPDATE',
      [organizationId, actionKey],
    );
    const from: TaskStatus = cur?.status ?? 'open';
    const to: TaskStatus = input.status ?? from;
    const note = input.note === undefined ? (cur?.note ?? null) : clean(input.note, 2000);
    const reasonIn = input.reason === undefined ? (cur?.reason ?? null) : clean(input.reason, 2000);
    if (to === 'genegeerd' && (!reasonIn || reasonIn.length < 3)) {
      throw new PlatformError('ongeldige_invoer', 'Schrijf kort op waarom je deze actie bewust niet oppakt.');
    }
    const reason = to === 'genegeerd' ? reasonIn : null;
    const assignedTo = input.assignedTo === undefined ? (cur?.assigned_to ?? null) : input.assignedTo;
    const assigneeName = input.assigneeName === undefined ? (cur?.assignee_name ?? null) : clean(input.assigneeName, 200);
    const statusChanged = to !== from;

    await q.query(
      `INSERT INTO action_task AS t (organization_id, action_key, status, note, reason, assigned_to, assignee_name, updated_by, updated_at,
                                     done_at, done_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), CASE WHEN $3 = 'gedaan' THEN now() END, CASE WHEN $3 = 'gedaan' THEN $8::uuid END)
       ON CONFLICT (organization_id, action_key) DO UPDATE SET
         status = EXCLUDED.status, note = EXCLUDED.note, reason = EXCLUDED.reason, assigned_to = EXCLUDED.assigned_to,
         assignee_name = EXCLUDED.assignee_name, updated_by = EXCLUDED.updated_by, updated_at = now(),
         done_at = CASE WHEN $9 THEN EXCLUDED.done_at ELSE t.done_at END,
         done_by = CASE WHEN $9 THEN EXCLUDED.done_by ELSE t.done_by END,
         still_seen_at = CASE WHEN $9 THEN NULL ELSE t.still_seen_at END,
         still_seen_scan = CASE WHEN $9 THEN NULL ELSE t.still_seen_scan END,
         confirmed_at = CASE WHEN $9 THEN NULL ELSE t.confirmed_at END,
         confirmed_scan = CASE WHEN $9 THEN NULL ELSE t.confirmed_scan END`,
      [organizationId, actionKey, to, note, reason, assignedTo, assigneeName, actor.userId, statusChanged],
    );
    const log = (kind: TaskLogEntry['kind'], text: string | null, f: TaskStatus | null = null, t: TaskStatus | null = null) =>
      q.query(
        `INSERT INTO action_task_log (organization_id, action_key, actor_user_id, kind, from_status, to_status, text, at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, clock_timestamp())`,
        [organizationId, actionKey, actor.userId, kind, f, t, text],
      );
    if (statusChanged) await log('status', to === 'genegeerd' ? reason : null, from, to);
    if (note !== (cur?.note ?? null) && note) await log('notitie', note);
    if (assignedTo !== (cur?.assigned_to ?? null) || assigneeName !== (cur?.assignee_name ?? null)) {
      const wie = assignedTo ? ({ zelf: 'Zelf', 'it-partner': 'IT-partner', webbouwer: 'Webbouwer' } as const)[assignedTo] : 'niemand';
      await log('toewijzing', assigneeName ? `${wie}: ${assigneeName}` : wie);
    }
    await audit(q, actor, {
      organizationId,
      action: 'actie.bijgewerkt',
      subject: actionKey,
      detail: { van: from, naar: to, toegewezen: assignedTo, ...(assigneeName ? { aan: assigneeName } : {}) },
    });
  });
}

export interface VerifyResult {
  bevestigd: string[];
  nogNietOpgelost: string[];
  terug: string[];
}

/**
 * Na elke scan (in dezelfde transactie als het opslaan): wat zegt de scan over de
 * afgevinkte acties? We oordelen alleen over wat deze scan echt zag:
 * - "nog niet opgelost" alleen als deze scan de bevinding opnieuw zag en de scan
 *   begon nadat er werd afgevinkt (anders was het werk misschien nog niet gedaan);
 * - "bevestigd" alleen als er bij de hele organisatie geen open bevinding meer is
 *   voor die actie (een actie kan over meerdere domeinen gaan).
 */
export async function verifyChecklistAfterScan(q: Queryable, organizationId: string, scanId: string): Promise<VerifyResult> {
  const scan = await one<{ started_at: Date | null }>(q, 'SELECT started_at FROM scan WHERE id = $1', [scanId]);
  const startedAt = scan?.started_at ?? new Date(0);
  const findings = await many<{ finding_key: string; open: boolean; seen_now: boolean; resolved_now: boolean }>(
    q,
    `SELECT f.finding_key,
            (f.resolved_at IS NULL AND f.accepted_at IS NULL AND a.status = 'actief') AS open,
            (f.resolved_at IS NULL AND f.last_scan_id = $2) AS seen_now,
            (f.resolved_scan_id = $2) AS resolved_now
       FROM finding f JOIN asset a ON a.id = f.asset_id
      WHERE a.organization_id = $1 AND (f.resolved_at IS NULL OR f.resolved_scan_id = $2)`,
    [organizationId, scanId],
  );
  const per = new Map<string, { open: number; seenNow: boolean; resolvedNow: boolean }>();
  for (const f of findings) {
    const k = actionKeyFor(f.finding_key);
    const x = per.get(k) ?? { open: 0, seenNow: false, resolvedNow: false };
    if (f.open) x.open++;
    x.seenNow ||= f.open && f.seen_now;
    x.resolvedNow ||= f.resolved_now;
    per.set(k, x);
  }
  const tasks = await many<{ action_key: string; status: TaskStatus; done_at: Date | null }>(
    q,
    'SELECT action_key, status, done_at FROM action_task WHERE organization_id = $1 FOR UPDATE',
    [organizationId],
  );
  const byKey = new Map(tasks.map((t) => [t.action_key, t]));
  const keys = new Set([...byKey.keys(), ...[...per.entries()].filter(([, v]) => v.resolvedNow).map(([k]) => k)]);
  const out: VerifyResult = { bevestigd: [], nogNietOpgelost: [], terug: [] };
  const log = (key: string, from: TaskStatus | null, to: TaskStatus | null, text: string) =>
    q.query(
      `INSERT INTO action_task_log (organization_id, action_key, kind, from_status, to_status, text, scan_id, at)
       VALUES ($1, $2, 'scan', $3, $4, $5, $6, clock_timestamp())`,
      [organizationId, key, from, to, text, scanId],
    );

  for (const key of keys) {
    const t = byKey.get(key);
    const s = per.get(key) ?? { open: 0, seenNow: false, resolvedNow: false };
    if (s.open === 0) {
      if (t?.status === 'bevestigd') continue;
      // Open of opgepakt zonder afvinken: alleen bevestigen als deze scan het oplossen zag.
      const confirm = t?.status === 'gedaan' || s.resolvedNow;
      if (!confirm) continue;
      await q.query(
        `INSERT INTO action_task AS t (organization_id, action_key, status, confirmed_at, confirmed_scan, updated_at)
         VALUES ($1, $2, 'bevestigd', now(), $3, now())
         ON CONFLICT (organization_id, action_key) DO UPDATE SET status = 'bevestigd', reason = NULL, confirmed_at = now(),
           confirmed_scan = $3, still_seen_at = NULL, still_seen_scan = NULL, updated_at = now()`,
        [organizationId, key, scanId],
      );
      await log(key, t?.status ?? 'open', 'bevestigd', 'De scan ziet dit niet meer. Opgelost.');
      out.bevestigd.push(key);
    } else if (t?.status === 'gedaan' && s.seenNow && t.done_at && t.done_at < startedAt) {
      await q.query(
        'UPDATE action_task SET still_seen_at = now(), still_seen_scan = $3 WHERE organization_id = $1 AND action_key = $2',
        [organizationId, key, scanId],
      );
      await log(key, 'gedaan', 'gedaan', 'Afgevinkt, maar de scan ziet het nog. Vraag wie het deed om het na te kijken.');
      out.nogNietOpgelost.push(key);
    } else if (t?.status === 'bevestigd' && s.seenNow) {
      await q.query(
        `UPDATE action_task SET status = 'open', confirmed_at = NULL, confirmed_scan = NULL, done_at = NULL, done_by = NULL, updated_at = now()
          WHERE organization_id = $1 AND action_key = $2`,
        [organizationId, key],
      );
      await log(key, 'bevestigd', 'open', 'Dit probleem is terug. De scan ziet het weer.');
      out.terug.push(key);
    }
  }
  return out;
}
