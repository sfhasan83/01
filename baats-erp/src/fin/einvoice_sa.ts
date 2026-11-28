import { createHash } from 'node:crypto';
import { ConflictError, NotFoundError, ValidationError } from '../core/errors.ts';
import { many, one, type Ctx, type Tx } from '../core/db.ts';
import { roundMoney } from './ledger.ts';
import type { Problem } from './einvoice.ts';
import { gstHead, gstinState, IN_STATES, PK_AUTHORITY } from './southasia.ts';

/**
 * E-invoices for India and Pakistan, both JSON.
 *
 * India: the GST e-invoice schema 1.1 that the Invoice Registration Portal (IRP)
 * takes for B2B supplies and exports. The IRP returns the IRN and a signed QR code;
 * reaching it needs a GST Suvidha Provider's API, so BAATS writes the JSON once,
 * keeps it with its SHA-256, and records the IRN and acknowledgement it returns.
 *
 * Pakistan: the FBR digital invoicing (DI) JSON for sales tax on goods, sent
 * through PRAL or a licensed integrator, which returns the FBR invoice number.
 * Provincial services tax is not reported through the FBR and is left out.
 */

export const SA_PROFILES = { in_irp: 'in-irp-1.1', pk_fbr: 'pk-fbr-di-1.12' } as const;
const PK_PROVINCES = ['Punjab', 'Sindh', 'Khyber Pakhtunkhwa', 'Balochistan', 'Islamabad Capital Territory', 'Gilgit-Baltistan', 'Azad Jammu and Kashmir'];
export const isPkProvince = (s: string) => PK_PROVINCES.includes(s);
const d10 = (v: Date | string) => (typeof v === 'string' ? v.slice(0, 10) : v.toISOString().slice(0, 10));
const ddmmyyyy = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
/** UQC (GST unit quantity codes) for the units BAATS uses most. */
const UQC: Record<string, string> = { EA: 'NOS', PCS: 'PCS', PC: 'PCS', UNIT: 'UNT', HR: 'OTH', HOUR: 'OTH', DAY: 'OTH', KG: 'KGS', L: 'LTR', M: 'MTR', BOX: 'BOX', SET: 'SET' };
const PK_UOM: Record<string, string> = { EA: 'Numbers, pieces, units', PCS: 'Numbers, pieces, units', PC: 'Numbers, pieces, units', UNIT: 'Numbers, pieces, units',
  KG: 'KG', L: 'Liter', M: 'Meter', SET: 'SET' };

async function load(tx: Tx, invoiceId: string) {
  const inv = await one(tx, 'SELECT * FROM fin.invoices WHERE id = $1', [invoiceId]);
  if (!inv) throw new NotFoundError('document');
  if (!['sales_invoice', 'sales_credit'].includes(inv.kind)) throw new ValidationError('e-invoices are issued for sales invoices and credit notes');
  if (inv.status !== 'posted') throw new ValidationError('post the document before issuing its e-invoice');
  const c = await one(tx, 'SELECT * FROM fin.companies WHERE unit_id = $1', [inv.company_id]);
  const p = await one(tx, 'SELECT * FROM mdm.parties WHERE id = $1', [inv.party_id]);
  const lines = await many(tx, `SELECT l.*, t.code AS tax_code, t.rate::float AS rate, i.name AS item_name, i.item_type, i.attributes AS item_attributes, u.code AS uom
                                  FROM fin.invoice_lines l JOIN fin.tax_codes t ON t.id = l.tax_code_id
                                  LEFT JOIN mdm.items i ON i.id = l.item_id LEFT JOIN mdm.uoms u ON u.id = i.base_uom_id
                                 WHERE l.invoice_id = $1 ORDER BY l.line_no`, [invoiceId]);
  const orig = inv.credit_of ? await one(tx, 'SELECT no, date FROM fin.invoices WHERE id = $1', [inv.credit_of]) : null;
  return { inv, c, p, a: (p.attributes ?? {}) as Record<string, any>, lines, orig };
}
type Loaded = Awaited<ReturnType<typeof load>>;

/** India: the IRP JSON and what stops it being accepted. */
export function irpJson({ inv, c, p, a, lines }: Loaded): { json: Record<string, unknown>; problems: Problem[] } {
  const problems: Problem[] = [];
  const E = (rule: string, message: string) => problems.push({ rule, message });
  const sellerState = gstinState(c.tax_registration_no);
  if (!sellerState) E('SellerDtls.Gstin', 'Company GSTIN is needed (Finance: e-invoicing, company details)');
  if (!c.street || !c.city) E('SellerDtls.Addr1', 'Company street and city are needed');
  if (!/^[1-9]\d{5}$/.test(String(c.postal_code ?? ''))) E('SellerDtls.Pin', 'Company PIN code (6 digits) is needed');
  const exportSale = p.country_code !== 'IN';
  const buyerGstin = exportSale ? 'URP' : gstinState(p.tax_registration_no) ? String(p.tax_registration_no).toUpperCase() : null;
  if (!buyerGstin) E('BuyerDtls.Gstin', `Customer ${p.name}: e-invoices are for registered customers (B2B) and exports; add the customer's GSTIN`);
  const buyerState = exportSale ? '96' : gstinState(p.tax_registration_no);
  const pin = exportSale ? 999999 : Number(a.postal_code ?? a.pin);
  if (!exportSale && !/^[1-9]\d{5}$/.test(String(a.postal_code ?? a.pin ?? ''))) E('BuyerDtls.Pin', `Customer ${p.name}: PIN code (attribute postal_code, 6 digits) is needed`);
  if (!a.street || !a.city) E('BuyerDtls.Addr1', `Customer ${p.name}: street and city are needed (attributes street, city)`);
  const fx = Number(inv.fx_rate);
  let igst = 0, cgst = 0, sgst = 0, ass = 0;
  const items = lines.map((l, i) => {
    const hsn = String(l.item_attributes?.hsn ?? l.item_attributes?.sac ?? '').replace(/\D/g, '');
    if (!/^\d{4}(\d{2}){0,2}$/.test(hsn)) E('ItemList.HsnCd', `line ${l.line_no}: the item needs an HSN or SAC code of 4, 6 or 8 digits (item attribute hsn)`);
    if (['NIL', 'EX', 'NG'].includes(l.tax_code)) E('ItemList.GstRt', `line ${l.line_no}: nil rated, exempt and non-GST supplies are not e-invoiced; invoice them separately`);
    const net = roundMoney(Number(l.net_amount) * fx), tax = roundMoney(Number(l.tax_amount) * fx);
    const head = gstHead(l.tax_code);
    const li = head === 'igst' || (exportSale && tax) ? tax : 0, lc = head === 'cgst_sgst' ? roundMoney(tax / 2) : 0, ls = head === 'cgst_sgst' ? roundMoney(tax - lc) : 0;
    igst += li; cgst += lc; sgst += ls; ass += net;
    const qty = Number(l.quantity), gross = roundMoney(Number(l.quantity) * Number(l.unit_price) * fx), disc = roundMoney(Number(l.discount) * fx);
    return { SlNo: String(i + 1), PrdDesc: l.description, IsServc: l.item_type === 'service' || hsn.startsWith('99') ? 'Y' : 'N', HsnCd: hsn,
      Qty: qty, Unit: UQC[String(l.uom ?? '').toUpperCase()] ?? 'OTH', UnitPrice: roundMoney(Number(l.unit_price) * fx), TotAmt: gross, Discount: disc,
      AssAmt: net, GstRt: l.rate, IgstAmt: li, CgstAmt: lc, SgstAmt: ls, CesRt: 0, CesAmt: 0, TotItemVal: roundMoney(net + li + lc + ls) };
  });
  const supTyp = !exportSale ? 'B2B' : igst > 0 ? 'EXPWP' : 'EXPWOP';
  const json: Record<string, unknown> = {
    Version: '1.1',
    TranDtls: { TaxSch: 'GST', SupTyp: supTyp, RegRev: 'N', IgstOnIntra: 'N' },
    DocDtls: { Typ: inv.kind === 'sales_credit' ? 'CRN' : 'INV', No: inv.no, Dt: ddmmyyyy(d10(inv.date)) },
    SellerDtls: { Gstin: c.tax_registration_no, LglNm: c.legal_name, Addr1: c.street, Loc: c.city, Pin: Number(c.postal_code), Stcd: sellerState,
      ...(c.phone ? { Ph: String(c.phone).replace(/\D/g, '').slice(-12) } : {}), ...(c.email ? { Em: c.email } : {}) },
    BuyerDtls: { Gstin: buyerGstin, LglNm: p.name, Pos: buyerState, Addr1: a.street, Loc: a.city, Pin: pin, Stcd: buyerState },
    ItemList: items,
    ValDtls: { AssVal: roundMoney(ass), CgstVal: roundMoney(cgst), SgstVal: roundMoney(sgst), IgstVal: roundMoney(igst), CesVal: 0, StCesVal: 0,
      Discount: 0, OthChrg: 0, RndOffAmt: 0, TotInvVal: roundMoney(ass + igst + cgst + sgst), ...(exportSale ? { TotInvValFc: Number(inv.gross_total) } : {}) },
    ...(exportSale ? { ExpDtls: { CntCode: p.country_code, ForCur: inv.currency } } : {}),
  };
  if (Math.abs(roundMoney(ass + igst + cgst + sgst) - roundMoney(Number(inv.gross_total) * fx)) > 1) E('ValDtls.TotInvVal', 'the invoice total does not match its lines');
  if (sellerState && buyerState && !exportSale) {
    const intra = sellerState === buyerState;
    if (intra && igst) E('IgstOnIntra', `the customer is in ${IN_STATES[sellerState]} like the company; the invoice should carry CGST and SGST`);
    if (!intra && (cgst || sgst)) E('Pos', 'an inter-state invoice carries IGST, not CGST and SGST');
  }
  return { json, problems };
}

/** Pakistan: the FBR DI JSON and what stops it being accepted. */
export function fbrJson({ inv, c, p, a, lines, orig }: Loaded): { json: Record<string, unknown>; problems: Problem[] } {
  const problems: Problem[] = [];
  const E = (rule: string, message: string) => problems.push({ rule, message });
  if (!c.tax_registration_no) E('sellerNTNCNIC', 'Company NTN or sales tax registration number is needed');
  if (!c.province) E('sellerProvince', 'Company province is needed (Finance: e-invoicing, company details)');
  if (!c.street) E('sellerAddress', 'Company address is needed');
  const registered = !!p.tax_registration_no;
  const buyerProvince = a.province && isPkProvince(a.province) ? a.province : null;
  if (p.country_code === 'PK' && !buyerProvince) E('buyerProvince', `Customer ${p.name}: province is needed (attribute province, e.g. Sindh, Punjab)`);
  const provincial = lines.filter((l) => PK_AUTHORITY[l.tax_code] && PK_AUTHORITY[l.tax_code] !== 'FBR');
  if (provincial.length) E('items.saleType', `lines ${provincial.map((l) => l.line_no).join(', ')} carry provincial sales tax on services, which is not reported to the FBR; invoice services separately`);
  const fx = Number(inv.fx_rate);
  const items = lines.filter((l) => !provincial.includes(l)).map((l) => {
    const hs = String(l.item_attributes?.hs_code ?? l.item_attributes?.hsn ?? '');
    if (!/^\d{4}\.\d{4}$/.test(hs)) E('items.hsCode', `line ${l.line_no}: the item needs a PCT/HS code like 8471.3010 (item attribute hs_code)`);
    const net = roundMoney(Number(l.net_amount) * fx), tax = roundMoney(Number(l.tax_amount) * fx);
    return { hsCode: hs, productDescription: l.description, rate: l.tax_code === 'EX' ? 'Exempt' : `${l.rate}%`, uoM: PK_UOM[String(l.uom ?? '').toUpperCase()] ?? 'Numbers, pieces, units',
      quantity: Number(l.quantity), totalValues: roundMoney(net + tax), valueSalesExcludingST: net, fixedNotifiedValueOrRetailPrice: 0,
      salesTaxApplicable: tax, salesTaxWithheldAtSource: 0, extraTax: '', furtherTax: 0, sroScheduleNo: '', fedPayable: 0, discount: roundMoney(Number(l.discount) * fx),
      saleType: l.tax_code === 'ZR' ? 'Exports' : l.tax_code === 'EX' ? 'Exempt goods' : 'Goods at standard rate (default)', sroItemSerialNo: '' };
  });
  const json = {
    invoiceType: inv.kind === 'sales_credit' ? 'Debit Note' : 'Sale Invoice',
    invoiceDate: d10(inv.date),
    sellerNTNCNIC: String(c.tax_registration_no ?? '').replace(/-/g, ''), sellerBusinessName: c.legal_name, sellerProvince: c.province, sellerAddress: [c.street, c.city].filter(Boolean).join(', '),
    buyerNTNCNIC: registered ? String(p.tax_registration_no).replace(/-/g, '') : '', buyerBusinessName: p.name, buyerProvince: buyerProvince ?? '',
    buyerAddress: [a.street, a.city].filter(Boolean).join(', '), buyerRegistrationType: registered ? 'Registered' : 'Unregistered',
    invoiceRefNo: orig?.no ?? '',
    items,
  };
  return { json, problems };
}

const build = (l: Loaded, kind: 'in_irp' | 'pk_fbr') => (kind === 'in_irp' ? irpJson(l) : fbrJson(l));

export async function saPreview(tx: Tx, invoiceId: string, kind: 'in_irp' | 'pk_fbr') {
  const { json, problems } = build(await load(tx, invoiceId), kind);
  return { ready: problems.length === 0, problems, profile: SA_PROFILES[kind], format: 'json' as const, xml: problems.length ? null : JSON.stringify(json, null, 2) };
}

/** Write the JSON once and keep it with its hash; the IRN (India) or FBR invoice number is recorded when the portal returns it. */
export async function saIssue(tx: Tx, ctx: Ctx, invoiceId: string, kind: 'in_irp' | 'pk_fbr') {
  const l = await load(tx, invoiceId);
  if (await one(tx, 'SELECT 1 FROM fin.einvoices WHERE invoice_id = $1', [invoiceId])) throw new ConflictError('the e-invoice for this document is already issued');
  const { json, problems } = build(l, kind);
  if (problems.length) throw new ValidationError(`fix before issuing: ${problems.map((p) => `${p.message} [${p.rule}]`).join('; ')}`);
  const body = JSON.stringify(json, null, 2) + '\n';
  return one(tx, `INSERT INTO fin.einvoices (tenant_id, company_id, invoice_id, profile, xml, xml_sha256, created_by)
    VALUES (app.tenant(), $1, $2, $3, $4, $5, $6) RETURNING id, invoice_id, uuid, profile, status, xml_sha256, created_at`,
    [l.inv.company_id, invoiceId, SA_PROFILES[kind], body, createHash('sha256').update(body).digest('hex'), ctx.userId]);
}
