import { loadUsageConfig, type OpsActor, type OpsContext, type UsageConfig } from '@qbicle/ops';
import type { Cockpit } from './staff.ts';
import type { CockpitContext } from '../module.ts';

let config: UsageConfig | undefined;

/** Context voor packages/ops (gebruik, gezondheid, support, agents) vanuit de cockpit. */
export function opsContext(cockpit: Cockpit): OpsContext {
  config ??= loadUsageConfig();
  return { pool: cockpit.p.pool, config, mailer: cockpit.p.mailer };
}

/** De ingelogde medewerker als actor voor packages/ops. */
export function opsActor(c: CockpitContext): Extract<OpsActor, { kind: 'medewerker' }> {
  const s = c.get('staff');
  return { kind: 'medewerker', userId: s.user.id, role: s.role, ip: c.get('actor').ip ?? null };
}

const nf = new Intl.NumberFormat('nl-NL');
const nfKort = new Intl.NumberFormat('nl-NL', { notation: 'compact', maximumFractionDigits: 1 });
const eur = new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' });
const eurFijn = new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 4 });

export const getal = (n: number) => nf.format(n);
export const getalKort = (n: number) => (Math.abs(n) >= 10_000 ? nfKort.format(n) : nf.format(n));
/** Micro-euro's als bedrag; kleine bedragen met meer decimalen. */
export const microEuro = (m: number) => (m !== 0 && Math.abs(m) < 10_000 ? eurFijn.format(m / 1e6) : eur.format(m / 1e6));

/** 'YYYY-MM-DD' voor een datum in Nederlandse tijd. */
export function dag(d: Date): string {
  return d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
}

export type Periode = 'maand' | 'vorige' | '30d';
export function periode(p: string | undefined): { key: Periode; from: string; to: string; label: string } {
  const now = new Date();
  const today = dag(now);
  const [y, m] = today.split('-').map(Number) as [number, number];
  const first = (yy: number, mm: number) => `${yy}-${String(mm).padStart(2, '0')}-01`;
  const next = m === 12 ? first(y + 1, 1) : first(y, m + 1);
  const prev = m === 1 ? first(y - 1, 12) : first(y, m - 1);
  const tomorrow = dag(new Date(now.getTime() + 86_400_000));
  if (p === 'vorige') return { key: 'vorige', from: prev, to: first(y, m), label: 'vorige maand' };
  if (p === '30d') return { key: '30d', from: dag(new Date(now.getTime() - 29 * 86_400_000)), to: tomorrow, label: 'laatste 30 dagen' };
  return { key: 'maand', from: first(y, m), to: next, label: 'deze maand' };
}
