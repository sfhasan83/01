import { NotFoundError, ValidationError } from '../core/errors.ts';
import { many, one, type Ctx, type Tx } from '../core/db.ts';
import { authorize } from '../iam/authz.ts';
import { company } from './ledger.ts';
import { outstanding } from './documents.ts';

/**
 * A printable invoice or credit note as PDF (A4), written directly: the standard
 * PDF fonts, no library. These fonts carry Latin letters only, so names in Arabic
 * script are shown in the email body and in the e-invoice, not in this PDF.
 */

const W = 595.28, H = 841.89, M = 42;

/** Text in the PDF fonts' encoding (WinAnsi); anything else becomes "?". */
function pdfText(s: string): string {
  const out: string[] = [];
  for (const ch of s.normalize('NFC')) {
    const c = ch.codePointAt(0)!;
    const win = ({ 0x20ac: 0x80, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2013: 0x96, 0x2014: 0x97, 0x2022: 0x95 } as Record<number, number>)[c];
    const b = win ?? (c >= 0x20 && c <= 0x7e ? c : c >= 0xa0 && c <= 0xff ? c : 0x3f);
    out.push(b === 0x28 || b === 0x29 || b === 0x5c ? '\\' + String.fromCharCode(b) : b < 0x80 ? String.fromCharCode(b) : '\\' + b.toString(8).padStart(3, '0'));
  }
  return out.join('');
}

// Helvetica widths (1/1000 em) for the printable ASCII range, to right-align and wrap.
const HELV = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const width = (s: string, size: number, bold = false) => [...s].reduce((w, ch) => { const c = ch.charCodeAt(0); return w + (c >= 32 && c <= 126 ? HELV[c - 32] : 556); }, 0) * size / 1000 * (bold ? 1.06 : 1);
function wrap(s: string, size: number, maxW: number): string[] {
  const words = s.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (width(next, size) <= maxW || !cur) cur = next; else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

class Doc {
  pages: string[][] = [[]];
  get ops() { return this.pages[this.pages.length - 1]; }
  text(x: number, y: number, s: string, size = 9, bold = false, align: 'l' | 'r' = 'l') {
    const tx = align === 'r' ? x - width(s, size, bold) : x;
    this.ops.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${tx.toFixed(2)} ${y.toFixed(2)} Td (${pdfText(s)}) Tj ET`);
  }
  line(x1: number, y1: number, x2: number, y2: number, w = 0.5, gray = 0.75) { this.ops.push(`${gray} G ${w} w ${x1} ${y1} m ${x2} ${y2} l S 0 G`); }
  rect(x: number, y: number, w: number, h: number, gray = 0.94) { this.ops.push(`${gray} g ${x} ${y} ${w} ${h} re f 0 g`); }
  newPage() { this.pages.push([]); }
  bytes(): Buffer {
    const objs: string[] = [];
    const n = this.pages.length;
    // 1 catalog, 2 pages, 3 F1, 4 F2, then a page and its content for each page.
    objs.push('<< /Type /Catalog /Pages 2 0 R >>');
    objs.push(`<< /Type /Pages /Count ${n} /Kids [${this.pages.map((_, i) => `${5 + i * 2} 0 R`).join(' ')}] >>`);
    objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    this.pages.forEach((ops, i) => {
      const stream = ops.join('\n');
      objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${6 + i * 2} 0 R >>`);
      objs.push(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
    });
    let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
    const offsets: number[] = [];
    objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out, 'latin1')); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
    const xref = Buffer.byteLength(out, 'latin1');
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
    out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info << /Producer (BAATS ERP) >> >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(out, 'latin1');
  }
}

const TITLES: Record<string, string> = { sales_invoice: 'Tax Invoice', sales_credit: 'Tax Credit Note', purchase_invoice: 'Supplier Bill', purchase_credit: 'Supplier Credit Note' };

/** What the PDF and the email show about a document. */
export async function invoiceView(tx: Tx, ctx: Ctx, id: string) {
  const inv = await one(tx, `SELECT i.*, p.name AS party_name, p.code AS party_code, p.tax_registration_no AS party_trn, p.attributes AS party_attributes
                               FROM fin.invoices i JOIN mdm.parties p ON p.id = i.party_id WHERE i.id = $1`, [id]);
  if (!inv) throw new NotFoundError('document');
  await authorize(tx, ctx, 'fin.report.read', { unitId: inv.company_id });
  if (inv.status !== 'posted') throw new ValidationError('only a posted document can be printed or sent');
  const c = await company(tx, inv.company_id);
  const lines = await many(tx, `SELECT l.line_no, l.description, l.quantity::float AS quantity, l.unit_price::float AS unit_price, l.discount::float AS discount,
      l.net_amount::float AS net, l.tax_amount::float AS tax, t.code AS tax_code, t.rate::float AS rate
      FROM fin.invoice_lines l JOIN fin.tax_codes t ON t.id = l.tax_code_id WHERE l.invoice_id = $1 ORDER BY l.line_no`, [id]);
  const due = await outstanding(tx, id);
  const link = await one(tx, `SELECT url, expires_at FROM fin.payment_links WHERE invoice_id = $1 AND status = 'open' AND expires_at > now()`, [id]);
  return { inv, company: c, lines, outstanding: due, paymentLink: link ?? null };
}

const money = (n: number, cur: string) => {
  const d = ['KWD', 'BHD', 'OMR', 'JOD', 'TND', 'LYD', 'IQD'].includes(cur) ? 3 : ['JPY', 'KRW'].includes(cur) ? 0 : 2;
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
};
const d10 = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v ?? '')).slice(0, 10);

export async function invoicePdf(tx: Tx, ctx: Ctx, id: string): Promise<{ name: string; pdf: Buffer }> {
  const { inv, company: c, lines, outstanding: due, paymentLink } = await invoiceView(tx, ctx, id);
  const cur = inv.currency;
  const taxLabel = c.country_code === 'AE' ? 'TRN' : 'VAT No.';
  const doc = new Doc();
  let y = H - M;
  // Seller
  doc.text(M, y, c.legal_name, 15, true); y -= 16;
  for (const l of [[c.street, c.city].filter(Boolean).join(', '), c.email ? `${c.email}${c.phone ? '   ' + c.phone : ''}` : c.phone,
    c.tax_registration_no ? `${taxLabel} ${c.tax_registration_no}` : null].filter(Boolean) as string[]) { doc.text(M, y, l, 9); y -= 12; }
  // Title and numbers
  doc.text(W - M, H - M, TITLES[inv.kind] ?? 'Invoice', 17, true, 'r');
  const meta: [string, string][] = [['Number', inv.no], ['Date', d10(inv.date)], ...(inv.due_date ? [['Due', d10(inv.due_date)] as [string, string]] : []), ['Currency', cur]];
  meta.forEach(([k, v], i) => { doc.text(W - M - 110, H - M - 22 - i * 12, k, 9); doc.text(W - M, H - M - 22 - i * 12, v, 9, true, 'r'); });
  y = Math.min(y, H - M - 22 - meta.length * 12) - 14;
  // Buyer
  doc.text(M, y, inv.kind.startsWith('sales') ? 'Bill to' : 'From', 8, true); y -= 13;
  doc.text(M, y, inv.party_name, 11, true); y -= 13;
  const a = inv.party_attributes ?? {};
  for (const l of [[a.street, a.city].filter(Boolean).join(', '), inv.party_trn ? `${taxLabel} ${inv.party_trn}` : null].filter(Boolean) as string[]) { doc.text(M, y, l, 9); y -= 12; }
  y -= 10;
  // Lines
  const cols = { desc: M + 4, qty: 330, price: 395, vat: 450, net: W - M - 4 };
  const header = () => {
    doc.rect(M, y - 4, W - 2 * M, 16);
    doc.text(cols.desc, y, 'Description', 8, true); doc.text(cols.qty, y, 'Qty', 8, true, 'r'); doc.text(cols.price, y, 'Unit price', 8, true, 'r');
    doc.text(cols.vat, y, 'VAT', 8, true, 'r'); doc.text(cols.net, y, `Amount (${cur})`, 8, true, 'r');
    y -= 18;
  };
  header();
  for (const l of lines) {
    const desc = wrap(l.description, 9, cols.qty - cols.desc - 40);
    if (y - desc.length * 11 < M + 140) { doc.text(W - M, M - 10, 'continued', 8, false, 'r'); doc.newPage(); y = H - M; header(); }
    doc.text(cols.qty, y, String(l.quantity), 9, false, 'r');
    doc.text(cols.price, y, money(l.unit_price, cur), 9, false, 'r');
    doc.text(cols.vat, y, `${l.tax_code}${l.rate ? ` ${l.rate}%` : ''}`, 8, false, 'r');
    doc.text(cols.net, y, money(l.net, cur), 9, false, 'r');
    for (const d of desc) { doc.text(cols.desc, y, d, 9); y -= 11; }
    if (l.discount) { doc.text(cols.desc, y, `Discount ${money(l.discount, cur)}`, 8); y -= 11; }
    y -= 3;
    doc.line(M, y + 6, W - M, y + 6, 0.3, 0.85);
  }
  // Totals
  y -= 6;
  const total = (k: string, v: number, bold = false) => { doc.text(W - M - 150, y, k, 9, bold); doc.text(W - M - 4, y, money(v, cur), 9, bold, 'r'); y -= 13; };
  total('Total excluding VAT', Number(inv.net_total));
  total('VAT', Number(inv.tax_total));
  total(`Total ${cur}`, Number(inv.gross_total), true);
  if (inv.kind === 'sales_invoice' && due < Number(inv.gross_total) - 0.0005) total('Still to pay', due, true);
  y -= 12;
  // How to pay
  if (inv.kind === 'sales_invoice' && due > 0.0005) {
    doc.text(M, y, 'How to pay', 9, true); y -= 12;
    if (c.iban) { doc.text(M, y, `Bank transfer to ${c.legal_name}, IBAN ${c.iban}, quoting ${inv.no}`, 9); y -= 12; }
    if (paymentLink) { doc.text(M, y, 'Pay by card online:', 9); y -= 12; for (const l of wrap(paymentLink.url, 8, W - 2 * M)) { doc.text(M, y, l, 8); y -= 10; } }
  }
  if (inv.notes) { y -= 6; for (const l of wrap(inv.notes, 8, W - 2 * M)) { doc.text(M, y, l, 8); y -= 10; } }
  doc.text(M, M - 10, `${c.legal_name} - ${inv.no}`, 7);
  return { name: `${inv.no}.pdf`, pdf: doc.bytes() };
}
