import { supplierLines, type Invoice } from '@qbicle/platform';

/**
 * Factuur als echte pdf, zonder externe bibliotheek. Eén A4-pagina met de
 * standaardletters Helvetica (zit in elke pdf-lezer), WinAnsi-codering zodat
 * €, ë en é goed staan. Bewust simpel: de factuur moet leesbaar en archiefvast
 * zijn, niet mooi opgemaakt.
 */

const W = 595.28;
const H = 841.89;
const M = 56;

/** Tekst naar een pdf-string in WinAnsi (cp1252). Onbekende tekens worden '?'. */
function pdfText(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    let b: number;
    if (ch === '€') b = 0x80;
    else if (ch === '‘' || ch === '’') b = 0x27;
    else if (ch === '“' || ch === '”') b = 0x22;
    else if (ch === '–' || ch === '—') b = 0x2d;
    else if (c >= 0x20 && c <= 0x7e) b = c;
    else if (c >= 0xa0 && c <= 0xff) b = c;
    else b = 0x3f;
    if (b === 0x28 || b === 0x29 || b === 0x5c) out += '\\' + String.fromCharCode(b);
    else if (b < 0x20 || b > 0x7e) out += '\\' + b.toString(8).padStart(3, '0');
    else out += String.fromCharCode(b);
  }
  return `(${out})`;
}

// Breedtes van Helvetica (per 1000 eenheden) voor rechts uitlijnen van bedragen.
const DIGIT = 556;
function textWidth(s: string, size: number, bold = false): number {
  let w = 0;
  for (const ch of s) {
    if (/[0-9]/.test(ch)) w += DIGIT;
    else if (ch === ',' || ch === '.' || ch === ' ') w += 278;
    else if (ch === '€') w += 556;
    else if (ch === '-') w += 333;
    else w += bold ? 611 : 556;
  }
  return (w * size) / 1000;
}

const euroFmt = new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' });
const euro = (c: number) => euroFmt.format(c / 100).replace(/ /g, ' ');
const datum = (d: Date | string) =>
  new Date(d).toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Amsterdam' });

export function invoicePdf(inv: Invoice, opts: { status: string; test: boolean }): Uint8Array {
  const ops: string[] = [];
  const text = (x: number, y: number, s: string, size = 10, bold = false) =>
    ops.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${x.toFixed(2)} ${y.toFixed(2)} Td ${pdfText(s)} Tj ET`);
  const right = (xr: number, y: number, s: string, size = 10, bold = false) => text(xr - textWidth(s, size, bold), y, s, size, bold);
  const line = (y: number, gray = 0.85) => ops.push(`${gray} G 0.6 w ${M} ${y.toFixed(2)} m ${(W - M).toFixed(2)} ${y.toFixed(2)} l S`);
  const c = inv.customer;

  // Kop
  ops.push('0.012 0.302 0.424 rg');
  text(M, H - M - 10, 'Qbicle', 24, true);
  ops.push('0.043 0.165 0.231 rg');
  right(W - M, H - M - 4, 'Factuur', 20, true);
  right(W - M, H - M - 22, inv.number, 10);

  // Klant en factuurgegevens
  let y = H - M - 80;
  text(M, y, 'Aan', 9, true);
  const klant = [
    c.naam ?? c.organisatie,
    c.adres ?? '',
    [c.postcode, c.plaats].filter(Boolean).join(' ') + (c.land && c.land !== 'NL' ? `  ${c.land}` : ''),
    c.kvk ? `KvK ${c.kvk}` : '',
    inv.customerVatNumber ?? c.btwNummer ? `Btw ${inv.customerVatNumber ?? c.btwNummer}` : '',
  ].filter((s) => s.trim());
  klant.forEach((s, i) => text(M, y - 14 - i * 13, s.slice(0, 80)));
  const meta: [string, string][] = [
    ['Factuurdatum', datum(inv.issuedAt)],
    ['Factuurnummer', inv.number],
    ['Status', opts.status],
  ];
  if (c.referentie) meta.push(['Uw referentie', c.referentie]);
  meta.forEach(([k, v], i) => {
    text(330, y - i * 14, k, 9, true);
    text(420, y - i * 14, v.slice(0, 40));
  });

  // Regels
  y -= Math.max(klant.length * 13 + 14, meta.length * 14) + 36;
  text(M, y, 'Omschrijving', 9, true);
  right(400, y, 'Aantal', 9, true);
  right(W - M, y, 'Bedrag excl. btw', 9, true);
  line(y - 6, 0.6);
  y -= 22;
  for (const l of inv.lines) {
    text(M, y, l.omschrijving.slice(0, 70));
    right(400, y, String(l.aantal));
    right(W - M, y, euro(l.totaalExclCenten));
    y -= 18;
  }
  line(y + 8);
  y -= 8;
  right(440, y, 'Subtotaal');
  right(W - M, y, euro(inv.amountExclCents));
  y -= 16;
  right(440, y, inv.reverseCharge ? 'Btw verlegd (0%)' : `Btw ${inv.vatRate.toLocaleString('nl-NL')}%`);
  right(W - M, y, euro(inv.vatCents));
  y -= 20;
  right(440, y, 'Totaal', 11, true);
  right(W - M, y, euro(inv.amountInclCents), 11, true);

  if (inv.reverseCharge) {
    y -= 30;
    text(M, y, 'Btw verlegd / reverse charge (art. 196 Btw-richtlijn 2006/112/EG). De afnemer voldoet de btw.', 9, true);
    text(M, y - 13, `Btw-nummer afnemer: ${inv.customerVatNumber ?? ''}   Btw-nummer ${inv.supplier?.naam ?? 'leverancier'}: ${inv.supplierVatNumber ?? 'nog niet ingesteld'}`.slice(0, 110), 9);
  }

  // Voet
  ops.push('0.31 0.41 0.46 rg');
  if (opts.test) text(M, M + 30, 'Testfactuur: er is geen geld afgeschreven.', 8);
  if (inv.supplier) {
    const sl = supplierLines(inv.supplier);
    text(M, M + 14, sl.regels.join('  ·  ').slice(0, 120), 8);
    if (sl.ontbreekt.length) text(M, M + 22, `Nog in te stellen: ${sl.ontbreekt.join(', ')}`, 8);
  }
  text(M, M, 'Qbicle - gegevens opgeslagen in de EU', 8);

  const content = ops.join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
    `<< /Title ${pdfText(`Factuur ${inv.number}`)} /Producer (Qbicle) >>`,
  ];
  let pdf = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info 7 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(pdf, 'latin1'));
}
