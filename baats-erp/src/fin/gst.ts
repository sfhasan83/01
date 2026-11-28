import { fixed } from '../core/money.ts';
import { many, one, type Tx } from '../core/db.ts';
import { roundMoney } from './ledger.ts';
import { totalsByCode, type CodeTotals, type Return } from './vat_europe.ts';
import { gstHead, gstinState, IN_STATES, partyState, PK_AUTHORITY } from './southasia.ts';
import type { VatBox } from './tax.ts';

/**
 * India's GST returns and Pakistan's sales tax returns, from the same ledger totals
 * by tax code as the European returns. In India each box also carries the tax by
 * head (IGST, CGST, SGST), which is how GSTR-3B is filled in; the GST codes say
 * which head (G and RCM codes: half CGST, half SGST; I and RCMI codes: IGST).
 */

const zero = (): VatBox => ({ amount: 0, vat: 0, heads: { igst: 0, cgst: 0, sgst: 0 } });
const split = (code: string, tax: number) => {
  const h = gstHead(code);
  if (h === 'igst') return { igst: tax, cgst: 0, sgst: 0 };
  if (h === 'cgst_sgst') { const half = roundMoney(tax / 2); return { igst: 0, cgst: half, sgst: roundMoney(tax - half) }; }
  return { igst: 0, cgst: 0, sgst: 0 };
};
const add = (b: VatBox, code: string, amount: number, tax: number) => {
  b.amount += amount; b.vat += tax;
  const s = split(code, tax);
  b.heads!.igst += s.igst; b.heads!.cgst += s.cgst; b.heads!.sgst += s.sgst;
};
const tidy = (b: Record<string, VatBox>) => {
  for (const v of Object.values(b)) {
    v.amount = roundMoney(v.amount); v.vat = roundMoney(v.vat);
    if (v.heads) for (const k of ['igst', 'cgst', 'sgst'] as const) v.heads[k] = roundMoney(v.heads[k]);
  }
  return b;
};

export const IN_LABELS: Record<string, string> = {
  '3.1a': 'Outward taxable supplies (other than zero rated, nil rated and exempted)',
  '3.1b': 'Outward taxable supplies (zero rated: exports)',
  '3.1c': 'Other outward supplies (nil rated, exempted)',
  '3.1d': 'Inward supplies (liable to reverse charge)',
  '3.1e': 'Non-GST outward supplies',
  '4A3': 'ITC available: inward supplies liable to reverse charge',
  '4A5': 'ITC available: all other ITC',
  '4C': 'Net ITC available',
  '5': 'Exempt, nil rated and non-GST inward supplies',
  '6.1': 'Tax payable (output tax and reverse charge less ITC)',
};

/** GSTR-3B: the monthly summary return. */
export async function indiaGstr3b(tx: Tx, companyId: string, from: string, to: string): Promise<Return> {
  const t = await totalsByCode(tx, companyId, from, to);
  const b: Record<string, VatBox> = Object.fromEntries(Object.keys(IN_LABELS).map((k) => [k, zero()]));
  for (const [code, s] of t.sales) {
    const box = /^(G|I)\d/.test(code) ? '3.1a' : code === 'EXP' ? '3.1b' : code === 'NIL' || code === 'EX' ? '3.1c' : code === 'NG' ? '3.1e' : '3.1a';
    add(b[box], code, s.net, s.vat);
  }
  for (const [code, p] of t.purchases) {
    if (/^RCM/.test(code)) { add(b['3.1d'], code, p.net, p.vatOut); add(b['4A3'], code, p.net, p.vatIn); }
    else if (code === 'NIL' || code === 'EX' || code === 'NG') b['5'].amount += p.net;
    else add(b['4A5'], code, p.net, p.vatIn);
  }
  for (const k of ['4A3', '4A5']) { b['4C'].amount += b[k].amount; addHeads(b['4C'], b[k]); }
  const output = b['3.1a'].vat + b['3.1b'].vat + b['3.1d'].vat;
  const input = b['4C'].vat;
  b['6.1'].vat = output - input;
  for (const h of ['igst', 'cgst', 'sgst'] as const) {
    b['6.1'].heads![h] = b['3.1a'].heads![h] + b['3.1b'].heads![h] + b['3.1d'].heads![h] - b['4C'].heads![h];
  }
  return { boxes: tidy(b), labels: IN_LABELS, outputTax: roundMoney(output), inputTax: roundMoney(input), netPayable: roundMoney(output - input), notes: [
    'Each box shows the taxable value, the tax, and the tax by head (IGST, CGST, SGST) as the GSTR-3B form asks.',
    'Credit is set off on the GST portal in the order the law sets (IGST credit first against IGST, then CGST and SGST); the 6.1 heads are before set-off.',
    'Cess, interest and late fees are not computed. File GSTR-1 (the invoice detail) before GSTR-3B; download it below.',
  ] };
}
function addHeads(to: VatBox, from: VatBox) {
  to.vat += from.vat;
  for (const h of ['igst', 'cgst', 'sgst'] as const) to.heads![h] += from.heads![h];
}

/**
 * GSTR-1: outward supplies invoice by invoice. B2B for customers with a GSTIN, B2CL
 * for inter-state invoices above INR 1 lakh to unregistered customers, B2CS (summed
 * by state and rate) for other unregistered sales, EXP for exports, CDNR for credit
 * notes to registered customers.
 */
export async function indiaGstr1(tx: Tx, companyId: string, from: string, to: string) {
  const c = await one(tx, 'SELECT tax_registration_no FROM fin.companies WHERE unit_id = $1', [companyId]);
  const ours = gstinState(c?.tax_registration_no);
  const lines = await many(tx, `
    SELECT i.id, i.kind, i.no, i.date::text AS date, i.gross_total::float * i.fx_rate::float AS invoice_value, p.name AS customer, p.country_code,
           p.tax_registration_no, p.attributes, t.code, t.rate::float AS rate,
           sum(l.net_amount * i.fx_rate)::float AS taxable, sum(l.tax_amount * i.fx_rate)::float AS tax
      FROM fin.invoices i JOIN fin.invoice_lines l ON l.invoice_id = i.id JOIN fin.tax_codes t ON t.id = l.tax_code_id
      JOIN mdm.parties p ON p.id = i.party_id
     WHERE i.company_id = $1 AND i.status = 'posted' AND i.kind IN ('sales_invoice','sales_credit') AND coalesce(i.tax_date, i.date) BETWEEN $2 AND $3
     GROUP BY i.id, p.id, t.code, t.rate ORDER BY i.date, i.no, t.rate`, [companyId, from, to]);
  type Row = { section: string; gstin: string; customer: string; invoice: string; date: string; value: number; placeOfSupply: string; rate: number;
    taxable: number; igst: number; cgst: number; sgst: number };
  const rows: Row[] = [];
  const b2cs = new Map<string, Row>();
  const problems: string[] = [];
  for (const l of lines) {
    if (['NIL', 'EX', 'NG'].includes(l.code)) continue; // reported in the nil/exempt table of the portal, from GSTR-3B 3.1(c) and (e)
    const sign = l.kind === 'sales_credit' ? -1 : 1;
    const state = partyState(l);
    const pos = l.country_code !== 'IN' ? '96' : state ?? '';
    const h = split(l.code, roundMoney(l.tax));
    const gstin = l.country_code === 'IN' && gstinState(l.tax_registration_no) ? l.tax_registration_no : '';
    const base = { gstin, customer: l.customer, invoice: l.no ?? '', date: l.date, value: roundMoney(sign * l.invoice_value), placeOfSupply: pos ? `${pos}-${IN_STATES[pos] ?? 'Other Countries'}` : '',
      rate: l.rate, taxable: roundMoney(sign * l.taxable), igst: sign * h.igst, cgst: sign * h.cgst, sgst: sign * h.sgst };
    if (!pos) problems.push(`invoice ${l.no}: ${l.customer} has no state; add a GSTIN or state_code`);
    const section = l.country_code !== 'IN' || l.code === 'EXP' ? 'EXP' : gstin ? (sign < 0 ? 'CDNR' : 'B2B')
      : pos !== ours && l.invoice_value > 100000 && sign > 0 ? 'B2CL' : 'B2CS';
    if (section === 'B2CS') {
      const key = `${pos}|${l.rate}`;
      const r = b2cs.get(key) ?? { ...base, section, gstin: '', customer: '', invoice: '', date: '', value: 0, taxable: 0, igst: 0, cgst: 0, sgst: 0 };
      r.taxable += base.taxable; r.igst += base.igst; r.cgst += base.cgst; r.sgst += base.sgst;
      b2cs.set(key, r);
    } else rows.push({ section, ...base });
  }
  for (const r of b2cs.values()) rows.push({ ...r, taxable: roundMoney(r.taxable), igst: roundMoney(r.igst), cgst: roundMoney(r.cgst), sgst: roundMoney(r.sgst) });
  const q = (s: string) => `"${String(s).replace(/"/g, '""')}"`;
  const csv = ['Section,GSTIN of recipient,Recipient,Invoice number,Invoice date,Invoice value,Place of supply,Rate,Taxable value,IGST,CGST,SGST',
    ...rows.map((r) => [r.section, r.gstin, q(r.customer), r.invoice, r.date, fixed(r.value), q(r.placeOfSupply), r.rate, fixed(r.taxable), fixed(r.igst), fixed(r.cgst), fixed(r.sgst)].join(','))]
    .join('\r\n') + '\r\n';
  return { from, to, rows, csv, fileName: `gstr1-${from}-${to}.csv`, problems };
}

export const PK_AUTH_NAMES: Record<string, string> = {
  FBR: 'FBR sales tax return (goods, Sales Tax Act 1990)', SRB: 'Sindh Revenue Board (SST-03)', PRA: 'Punjab Revenue Authority',
  KPRA: 'Khyber Pakhtunkhwa Revenue Authority', BRA: 'Balochistan Revenue Authority',
};

/**
 * Pakistan: one return per authority. Sales tax on goods is declared to the FBR
 * with zero rated and exempt supplies; each province's services tax to its own
 * authority. Input tax goes to the authority of the code it was charged under:
 * provincial credit cannot be set off against federal tax and the other way round.
 */
export async function pakistanSalesTaxReturn(tx: Tx, companyId: string, from: string, to: string): Promise<Return> {
  const t: CodeTotals = await totalsByCode(tx, companyId, from, to);
  const b: Record<string, VatBox> = {}, labels: Record<string, string> = {};
  const box = (k: string, label: string) => (b[k] ??= ((labels[k] = label), { amount: 0, vat: 0 }));
  const auths = new Set<string>(['FBR']);
  for (const code of [...t.sales.keys(), ...t.purchases.keys()]) if (PK_AUTHORITY[code]) auths.add(PK_AUTHORITY[code]);
  let output = 0, input = 0;
  const notes: string[] = [];
  for (const a of ['FBR', 'SRB', 'PRA', 'KPRA', 'BRA'].filter((x) => auths.has(x))) {
    const codes = Object.keys(PK_AUTHORITY).filter((c) => PK_AUTHORITY[c] === a);
    const out = box(`${a}-1`, `${a}: taxable ${a === 'FBR' ? 'supplies of goods' : 'services'} and output tax`);
    const inp = box(`${a}-2`, `${a}: purchases and input tax`);
    for (const c of codes) {
      const s = t.sales.get(c), p = t.purchases.get(c);
      if (s && c !== 'ZR' && c !== 'EX') { out.amount += s.net; out.vat += s.vat; }
      if (p && c !== 'ZR' && c !== 'EX') { inp.amount += p.net; inp.vat += p.vatIn; }
    }
    if (a === 'FBR') {
      box('FBR-3', 'FBR: zero rated supplies').amount += t.sales.get('ZR')?.net ?? 0;
      box('FBR-4', 'FBR: exempt supplies').amount += t.sales.get('EX')?.net ?? 0;
    }
    const net = box(`${a}-9`, `${a}: tax payable (or carried forward)`);
    net.vat = out.vat - inp.vat;
    output += out.vat; input += inp.vat;
    notes.push(`${PK_AUTH_NAMES[a]}: ${fixed(roundMoney(net.vat))} ${net.vat >= 0 ? 'to pay' : 'to carry forward'}.`);
  }
  notes.push('Each authority\'s return is filed on its own portal (IRIS for the FBR, e-SRB, e-PRA, KPRA and BRA). Further tax, extra tax and withholding by agents are not computed.');
  for (const v of Object.values(b)) { v.amount = roundMoney(v.amount); v.vat = roundMoney(v.vat); }
  return { boxes: b, labels, outputTax: roundMoney(output), inputTax: roundMoney(input), netPayable: roundMoney(output - input), notes };
}

export const SOUTH_ASIA_RETURNS = { IN: indiaGstr3b, PK: pakistanSalesTaxReturn };
