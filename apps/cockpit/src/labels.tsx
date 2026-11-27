/** @jsxImportSource hono/jsx */
import type { Catalog } from '@qbicle/platform';
import { Status, type StatusKind } from './layout.tsx';

/** Leesbare namen en statuskleuren die meerdere onderdelen delen. */

export const SUB_STATUS: Record<string, [string, StatusKind]> = {
  proef: ['Proef', 'info'],
  actief: ['Actief', 'ok'],
  achterstallig: ['Achterstallig', 'crit'],
  opgezegd: ['Opgezegd', 'warn'],
  beeindigd: ['Beëindigd', 'unk'],
};

export const PAYMENT_STATUS: Record<string, [string, StatusKind]> = {
  open: ['Openstaand', 'warn'],
  betaald: ['Betaald', 'ok'],
  mislukt: ['Mislukt', 'crit'],
  verlopen: ['Verlopen', 'unk'],
  geannuleerd: ['Geannuleerd', 'unk'],
};

export const ORG_KIND: Record<string, string> = { klant: 'Klant', 'it-partner': 'IT-partner', adviseur: 'Adviseur' };

export function SubStatus(props: { status: string | null }) {
  if (!props.status) return <Status kind="unk">Geen abonnement</Status>;
  const [label, kind] = SUB_STATUS[props.status] ?? [props.status, 'unk'];
  return <Status kind={kind}>{label}</Status>;
}

export function PayStatus(props: { status: string }) {
  const [label, kind] = PAYMENT_STATUS[props.status] ?? [props.status, 'unk'];
  return <Status kind={kind}>{label}</Status>;
}

export function planName(catalog: Catalog, id: string | null): string {
  if (!id) return '—';
  return catalog.plans.find((p) => p.id === id)?.naam ?? id;
}

export const METHOD_LABEL: Record<string, string> = { incasso: 'Incasso', factuur: 'Factuur' };

/** Status van een betaling, met terugbetaling erbij. */
export function PayStatusFull(props: { status: string; refundedAt: Date | null; refundedCents?: number; amountCents?: number }) {
  if (props.refundedAt) {
    const deel = props.refundedCents !== undefined && props.amountCents !== undefined && props.refundedCents < props.amountCents;
    return <Status kind="unk">{deel ? 'Deels terugbetaald' : 'Terugbetaald'}</Status>;
  }
  return <PayStatus status={props.status} />;
}
