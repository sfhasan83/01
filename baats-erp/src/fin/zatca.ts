import { createHash } from 'node:crypto';
import { ConflictError, NotFoundError, ValidationError } from '../core/errors.ts';
import { many, one, type Ctx, type Tx } from '../core/db.ts';
import { roundMoney } from './ledger.ts';
import { fixed } from '../core/money.ts';

/**
 * Saudi e-invoicing (ZATCA Fatoora, phase 2 data model): a posted sales invoice
 * or credit note becomes UBL 2.1 XML in ZATCA's layout, with
 *   * the invoice counter value (ICV), one sequence per company with no gaps,
 *   * the previous invoice hash (PIH), so each invoice is chained to the one before,
 *   * the invoice hash, SHA-256 over the XML without the QR code, in base64,
 *   * the QR code: TLV fields 1 to 6 (seller, VAT number, time, total, VAT, hash).
 *
 * Cryptographic stamping (an ECDSA signature with a certificate ZATCA issues to
 * each device, QR fields 7 to 9) and sending invoices for clearance or reporting
 * need the taxpayer's onboarding with ZATCA, so they are not done here. ZATCA
 * also hashes a canonical (C14N 1.1) form of the XML; the hash here is over the
 * XML as written, which is stable because the XML is produced the same way each
 * time, but it must be checked with ZATCA's validation tool before going live.
 */

export const ZATCA_PROFILE = 'zatca-phase2-ubl-2.1';
/** ZATCA's documented previous-invoice hash for a company's first invoice: base64 of the hex SHA-256 of "0". */
export const FIRST_PIH = Buffer.from(createHash('sha256').update('0').digest('hex')).toString('base64');

const UNIT_MAP: Record<string, string> = { EA: 'PCE', PCS: 'PCE', PC: 'PCE', UNIT: 'PCE', HR: 'HUR', HOUR: 'HUR', DAY: 'DAY', MON: 'MON', KG: 'KGM', L: 'LTR', M: 'MTR' };
const isVat = (t?: string | null) => !!t && /^3\d{13}3$/.test(t);
const a2 = (n: number) => roundMoney(n).toFixed(2);
const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const d10 = (v: Date | string | null) => (v === null ? null : typeof v === 'string' ? v.slice(0, 10) : v.toISOString().slice(0, 10));

export interface Problem { rule: string; message: string }

export async function zatcaModel(tx: Tx, invoiceId: string) {
  const inv = await one(tx, 'SELECT * FROM fin.invoices WHERE id = $1', [invoiceId]);
  if (!inv) throw new NotFoundError('document');
  if (!['sales_invoice', 'sales_credit'].includes(inv.kind)) throw new ValidationError('e-invoices are issued for sales invoices and credit notes');
  if (inv.status !== 'posted') throw new ValidationError('post the document before issuing its e-invoice');
  const c = await one(tx, 'SELECT * FROM fin.companies WHERE unit_id = $1', [inv.company_id]);
  const p = await one(tx, 'SELECT * FROM mdm.parties WHERE id = $1', [inv.party_id]);
  const lines = await many(tx, `SELECT l.*, t.category, t.rate, trim(t.einvoice_category) AS cat, t.exemption_reason_code, t.exemption_reason,
                                       i.name AS item_name, u.code AS uom
                                  FROM fin.invoice_lines l JOIN fin.tax_codes t ON t.id = l.tax_code_id
                                  LEFT JOIN mdm.items i ON i.id = l.item_id LEFT JOIN mdm.uoms u ON u.id = i.base_uom_id
                                 WHERE l.invoice_id = $1 ORDER BY l.line_no`, [invoiceId]);
  const orig = inv.credit_of ? await one(tx, 'SELECT no, date FROM fin.invoices WHERE id = $1', [inv.credit_of]) : null;
  const a = p.attributes ?? {};
  const abroad = p.country_code !== 'SA';
  // A buyer with a VAT number or a commercial registration, or any export, gets a standard (B2B) tax invoice;
  // anyone else a simplified (B2C) one.
  const standard = abroad || !!p.tax_registration_no || !!a.cr_no;
  const subs = new Map<string, { cat: string; rate: number; base: number; tax: number; code: string | null; reason: string | null }>();
  const mLines = lines.map((l) => {
    const net = Number(l.net_amount), vat = Number(l.tax_amount), qty = Number(l.quantity);
    const key = `${l.cat}|${Number(l.rate)}|${l.exemption_reason_code ?? ''}`;
    const s = subs.get(key) ?? { cat: l.cat, rate: Number(l.rate), base: 0, tax: 0, code: l.exemption_reason_code, reason: l.exemption_reason };
    s.base += net; s.tax += vat; subs.set(key, s);
    return { k: l.line_no, qty, unit: UNIT_MAP[String(l.uom ?? '').toUpperCase()] ?? 'PCE', net, vat, name: l.item_name ?? l.description,
      cat: l.cat as string, rate: Number(l.rate), price: Math.round(net / qty * 1e4) / 1e4,
      code: l.exemption_reason_code as string | null, reason: l.exemption_reason as string | null };
  });
  const lineExt = roundMoney(mLines.reduce((x, l) => x + l.net, 0));
  const tax = roundMoney(mLines.reduce((x, l) => x + l.vat, 0));
  const fx = Number(inv.fx_rate);
  return {
    inv,
    model: {
      no: inv.no as string, date: d10(inv.date)!, supply: d10(inv.tax_date) ?? d10(inv.date)!, credit: inv.kind === 'sales_credit',
      typeName: `0${standard ? 1 : 2}00${abroad ? 1 : 0}00`, standard, cur: inv.currency as string, rate: fx, notes: inv.notes as string | null,
      reason: inv.kind === 'sales_credit' ? (inv.notes as string | null) : null, orig: orig ? { no: orig.no as string, date: d10(orig.date) } : null,
      seller: { name: c.legal_name, vat: c.tax_registration_no, crn: c.trade_licence_no, street: c.street, building: c.building_no, district: c.district,
        city: c.city, postal: c.postal_code, ctry: c.country_code as string },
      buyer: { name: p.name, vat: p.tax_registration_no, crn: a.cr_no, street: a.street, building: a.building_no, district: a.district, city: a.city,
        postal: a.postal_code, ctry: p.country_code as string },
      subs: [...subs.values()].map((s) => ({ ...s, base: roundMoney(s.base), tax: roundMoney(s.tax) })),
      lines: mLines,
      totals: { lineExt, tax, taxIncl: roundMoney(lineExt + tax), payable: Number(inv.gross_total), taxSar: roundMoney(tax * fx), totalSar: roundMoney((lineExt + tax) * fx) },
    },
  };
}
export type ZatcaModel = Awaited<ReturnType<typeof zatcaModel>>['model'];

/** A subset of ZATCA's business rules (BR-KSA), checked before the XML is written. */
export function validateZatca(m: ZatcaModel): Problem[] {
  const out: Problem[] = [];
  const E = (rule: string, message: string) => out.push({ rule, message });
  const s = m.seller, b = m.buyer;
  if (!isVat(s.vat)) E('BR-KSA-39', 'Company VAT number: 15 digits, starting and ending with 3 (Finance: setup)');
  if (!s.crn) E('BR-KSA-08', 'Company commercial registration number is needed (Finance: setup, licence number)');
  if (!s.street || !s.city || !s.district) E('BR-KSA-09', 'Company address: street, district and city are needed (Finance: setup)');
  if (!/^\d{4}$/.test(s.building ?? '')) E('BR-KSA-37', 'Company building number has 4 digits (Finance: setup)');
  if (!/^\d{5}$/.test(s.postal ?? '')) E('BR-KSA-66', 'Company postal code has 5 digits (Finance: setup)');
  if (m.standard) {
    if (!b.name) E('BR-KSA-42', 'A standard tax invoice needs the customer name');
    if (b.ctry === 'SA') {
      if (!b.street || !b.city || !b.district) E('BR-KSA-63', `Customer ${b.name}: street, district and city are needed (customer attributes street, district, city)`);
      if (!/^\d{4}$/.test(b.building ?? '')) E('BR-KSA-63', `Customer ${b.name}: building number has 4 digits (attribute building_no)`);
      if (!/^\d{5}$/.test(b.postal ?? '')) E('BR-KSA-67', `Customer ${b.name}: postal code has 5 digits (attribute postal_code)`);
    }
  }
  if (b.vat && b.ctry === 'SA' && !isVat(b.vat)) E('BR-KSA-44', `Customer ${b.name}: VAT number must be 15 digits starting and ending with 3`);
  if (m.credit && !m.orig?.no) E('BR-KSA-56', 'A credit note must refer to the invoice it credits');
  if (m.credit && !m.reason) E('BR-KSA-17', 'A credit note needs the reason for issuing it (the note on the document)');
  for (const l of m.lines) {
    if (l.cat === 'S' && !(l.rate > 0)) E('BR-KSA-DEC-02', `Line ${l.k}: a standard-rated line needs a VAT rate`);
    if (['Z', 'E', 'O'].includes(l.cat) && (!l.code || !l.reason)) E('BR-KSA-69', `Line ${l.k}: zero-rated, exempt and out-of-scope lines need an exemption reason code (VATEX) on the tax code`);
    if (!l.cat) E('BR-KSA-18', `Line ${l.k}: the tax code has no e-invoice category`);
  }
  if (m.cur !== 'SAR' && !(m.rate > 0)) E('BR-KSA-68', 'An exchange rate to SAR is required');
  if (roundMoney(m.subs.reduce((x, t) => x + t.tax, 0)) !== m.totals.tax) E('BR-CO-14', 'VAT total must equal the sum of the VAT breakdown');
  return out;
}

/** ZATCA QR code: TLV (one-byte tag, one-byte length, UTF-8 value) in base64. */
export function qrTlv(fields: string[]): string {
  const parts: Buffer[] = [];
  fields.forEach((v, i) => {
    const b = Buffer.from(v, 'utf8');
    if (b.length > 255) throw new ValidationError(`QR field ${i + 1} is too long`);
    parts.push(Buffer.from([i + 1, b.length]), b);
  });
  return Buffer.concat(parts).toString('base64');
}
export function readQr(base64: string): string[] {
  const b = Buffer.from(base64, 'base64'); const out: string[] = [];
  for (let i = 0; i < b.length;) { const len = b[i + 1]; out.push(b.subarray(i + 2, i + 2 + len).toString('utf8')); i += 2 + len; }
  return out;
}

const QR_MARK = '<!--QR-->';

/** The invoice XML without the QR reference (which is hashed), with a marker where the QR goes. */
export function zatcaXml(m: ZatcaModel, ids: { uuid: string; counter: number; pih: string; time: string }): string {
  const cur = m.cur, SAR = 'SAR';
  const o: string[] = []; let d = 0;
  const ind = () => '  '.repeat(d);
  const el = (n: string, v: unknown, at?: Record<string, unknown>) => {
    if (v === undefined || v === null || v === '') return;
    o.push(`${ind()}<${n}${at ? Object.entries(at).filter(([, x]) => x !== '' && x != null).map(([k, x]) => ` ${k}="${esc(x)}"`).join('') : ''}>${esc(v)}</${n}>`);
  };
  const open = (n: string, at?: Record<string, string>) => { o.push(`${ind()}<${n}${at ? Object.entries(at).map(([k, x]) => ` ${k}="${esc(x)}"`).join('') : ''}>`); d++; };
  const close = (n: string) => { d--; o.push(`${ind()}</${n}>`); };
  const amt = (n: string, v: number, c = cur) => el(n, fixed(v, c), { currencyID: c });
  const scheme = () => { open('cac:TaxScheme'); el('cbc:ID', 'VAT'); close('cac:TaxScheme'); };
  const addr = (p: ZatcaModel['seller']) => {
    open('cac:PostalAddress'); el('cbc:StreetName', p.street); el('cbc:BuildingNumber', p.building); el('cbc:CitySubdivisionName', p.district);
    el('cbc:CityName', p.city); el('cbc:PostalZone', p.postal); open('cac:Country'); el('cbc:IdentificationCode', p.ctry); close('cac:Country'); close('cac:PostalAddress');
  };
  const party = (tag: string, p: ZatcaModel['seller']) => {
    open(tag); open('cac:Party');
    if (p.crn) { open('cac:PartyIdentification'); el('cbc:ID', p.crn, { schemeID: 'CRN' }); close('cac:PartyIdentification'); }
    addr(p);
    open('cac:PartyTaxScheme'); el('cbc:CompanyID', p.vat); scheme(); close('cac:PartyTaxScheme');
    open('cac:PartyLegalEntity'); el('cbc:RegistrationName', p.name); close('cac:PartyLegalEntity');
    close('cac:Party'); close(tag);
  };
  const cat = (tag: string, c: string, rate: number, code: string | null, reason: string | null) => {
    open(tag); el('cbc:ID', c); el('cbc:Percent', rate.toFixed(2));
    if (['Z', 'E', 'O'].includes(c)) { el('cbc:TaxExemptionReasonCode', code); el('cbc:TaxExemptionReason', reason); }
    scheme(); close(tag);
  };
  o.push('<?xml version="1.0" encoding="UTF-8"?>');
  open('Invoice', { xmlns: 'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2',
    'xmlns:cac': 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2',
    'xmlns:cbc': 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2' });
  el('cbc:ProfileID', 'reporting:1.0'); el('cbc:ID', m.no); el('cbc:UUID', ids.uuid); el('cbc:IssueDate', m.date); el('cbc:IssueTime', ids.time);
  el('cbc:InvoiceTypeCode', m.credit ? '381' : '388', { name: m.typeName });
  if (m.notes) el('cbc:Note', m.notes, { languageID: 'en' });
  el('cbc:DocumentCurrencyCode', cur); el('cbc:TaxCurrencyCode', SAR);
  if (m.orig?.no) { open('cac:BillingReference'); open('cac:InvoiceDocumentReference'); el('cbc:ID', m.orig.no); close('cac:InvoiceDocumentReference'); close('cac:BillingReference'); }
  open('cac:AdditionalDocumentReference'); el('cbc:ID', 'ICV'); el('cbc:UUID', String(ids.counter)); close('cac:AdditionalDocumentReference');
  open('cac:AdditionalDocumentReference'); el('cbc:ID', 'PIH'); open('cac:Attachment'); el('cbc:EmbeddedDocumentBinaryObject', ids.pih, { mimeCode: 'text/plain' }); close('cac:Attachment'); close('cac:AdditionalDocumentReference');
  o.push(QR_MARK);
  party('cac:AccountingSupplierParty', m.seller);
  party('cac:AccountingCustomerParty', m.buyer);
  if (m.standard) { open('cac:Delivery'); el('cbc:ActualDeliveryDate', m.supply); close('cac:Delivery'); }
  open('cac:PaymentMeans'); el('cbc:PaymentMeansCode', '30'); if (m.credit) el('cbc:InstructionNote', m.reason); close('cac:PaymentMeans');
  open('cac:TaxTotal'); amt('cbc:TaxAmount', m.totals.taxSar, SAR); close('cac:TaxTotal');
  open('cac:TaxTotal'); amt('cbc:TaxAmount', m.totals.tax);
  for (const x of m.subs) { open('cac:TaxSubtotal'); amt('cbc:TaxableAmount', x.base); amt('cbc:TaxAmount', x.tax); cat('cac:TaxCategory', x.cat, x.rate, x.code, x.reason); close('cac:TaxSubtotal'); }
  close('cac:TaxTotal');
  open('cac:LegalMonetaryTotal'); amt('cbc:LineExtensionAmount', m.totals.lineExt); amt('cbc:TaxExclusiveAmount', m.totals.lineExt);
  amt('cbc:TaxInclusiveAmount', m.totals.taxIncl); amt('cbc:AllowanceTotalAmount', 0); amt('cbc:PayableAmount', m.totals.payable); close('cac:LegalMonetaryTotal');
  for (const x of m.lines) {
    open('cac:InvoiceLine'); el('cbc:ID', String(x.k)); el('cbc:InvoicedQuantity', String(x.qty), { unitCode: x.unit }); amt('cbc:LineExtensionAmount', x.net);
    open('cac:TaxTotal'); amt('cbc:TaxAmount', x.vat); amt('cbc:RoundingAmount', x.net + x.vat); close('cac:TaxTotal');
    open('cac:Item'); el('cbc:Name', x.name); cat('cac:ClassifiedTaxCategory', x.cat, x.rate, null, null); close('cac:Item');
    open('cac:Price'); el('cbc:PriceAmount', String(x.price), { currencyID: cur }); close('cac:Price');
    close('cac:InvoiceLine');
  }
  close('Invoice');
  return o.join('\n') + '\n';
}

const qrBlock = (qr: string) => `  <cac:AdditionalDocumentReference>\n    <cbc:ID>QR</cbc:ID>\n    <cac:Attachment>\n      <cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">${qr}</cbc:EmbeddedDocumentBinaryObject>\n    </cac:Attachment>\n  </cac:AdditionalDocumentReference>`;
const QR_RE = /\n {2}<cac:AdditionalDocumentReference>\n {4}<cbc:ID>QR<\/cbc:ID>[\s\S]*?<\/cac:AdditionalDocumentReference>/;

/** The hash ZATCA chains on: SHA-256 of the invoice without its QR code, base64. */
export const invoiceHash = (xmlWithoutQr: string) => createHash('sha256').update(xmlWithoutQr, 'utf8').digest('base64');
export const withoutQr = (xml: string) => xml.replace(QR_RE, '');

/** Write the final XML: hash it, then put the QR code (which carries the hash) in its place. */
export function sealZatca(m: ZatcaModel, ids: { uuid: string; counter: number; pih: string; time: string }) {
  const bare = zatcaXml(m, ids).replace(`${QR_MARK}\n`, '');
  const hash = invoiceHash(bare);
  const qr = qrTlv([m.seller.name, m.seller.vat ?? '', `${m.date}T${ids.time}`, a2(m.totals.totalSar), a2(m.totals.taxSar), hash]);
  const xml = zatcaXml(m, ids).replace(QR_MARK, qrBlock(qr));
  return { xml, hash, qr };
}

export async function zatcaPreview(tx: Tx, invoiceId: string) {
  const { model } = await zatcaModel(tx, invoiceId);
  const problems = validateZatca(model);
  const xml = problems.length ? null : sealZatca(model, { uuid: '00000000-0000-0000-0000-000000000000', counter: 0, pih: FIRST_PIH, time: '00:00:00' }).xml;
  return { ready: problems.length === 0, problems, xml, invoiceType: model.standard ? 'standard' : 'simplified' };
}

/** Issue: take the next counter and the previous hash under a per-company lock, so the chain has no gaps or forks. */
export async function zatcaIssue(tx: Tx, ctx: Ctx, invoiceId: string) {
  const { inv, model } = await zatcaModel(tx, invoiceId);
  if (await one(tx, 'SELECT 1 FROM fin.einvoices WHERE invoice_id = $1', [invoiceId])) throw new ConflictError('the e-invoice for this document is already issued');
  const problems = validateZatca(model);
  if (problems.length) throw new ValidationError(`fix before issuing: ${problems.map((p) => `${p.message} [${p.rule}]`).join('; ')}`);
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext('zatca-chain'), hashtext($1::text))`, [inv.company_id]);
  const last = await one(tx, `SELECT counter, invoice_hash FROM fin.einvoices WHERE company_id = $1 AND counter IS NOT NULL ORDER BY counter DESC LIMIT 1`, [inv.company_id]);
  const counter = (last?.counter ?? 0) + 1;
  const pih = last?.invoice_hash ?? FIRST_PIH;
  const uuid = (await one(tx, 'SELECT gen_random_uuid() AS u')).u as string;
  const time = new Date().toISOString().slice(11, 19);
  const { xml, hash, qr } = sealZatca(model, { uuid, counter, pih, time });
  return one(tx, `INSERT INTO fin.einvoices (tenant_id, company_id, invoice_id, uuid, profile, xml, xml_sha256, created_by, counter, invoice_hash, previous_hash, qr, invoice_type)
    VALUES (app.tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    RETURNING id, invoice_id, uuid, profile, status, xml_sha256, counter, invoice_hash, previous_hash, qr, invoice_type, created_at`,
    [inv.company_id, invoiceId, uuid, ZATCA_PROFILE, xml, createHash('sha256').update(xml).digest('hex'), ctx.userId, counter, hash, pih, qr,
      model.standard ? 'standard' : 'simplified']);
}

/**
 * Check a company's whole chain: counters run 1, 2, 3 with no gaps, each stored
 * XML still hashes to its recorded hash, each invoice points at the one before,
 * and each QR code carries its invoice's hash.
 */
export async function verifyZatcaChain(tx: Tx, companyId: string) {
  const rows = await many(tx, `SELECT e.counter, e.xml, e.invoice_hash, e.previous_hash, e.qr, i.no FROM fin.einvoices e JOIN fin.invoices i ON i.id = e.invoice_id
                                WHERE e.company_id = $1 AND e.counter IS NOT NULL ORDER BY e.counter`, [companyId]);
  const problems: string[] = [];
  let prev = FIRST_PIH;
  rows.forEach((r, i) => {
    if (r.counter !== i + 1) problems.push(`counter ${r.counter} found where ${i + 1} was expected`);
    if (r.previous_hash !== prev) problems.push(`${r.no}: previous-invoice hash does not match invoice ${i}`);
    if (invoiceHash(withoutQr(r.xml)) !== r.invoice_hash) problems.push(`${r.no}: the stored XML no longer matches its hash`);
    if (readQr(r.qr)[5] !== r.invoice_hash) problems.push(`${r.no}: the QR code does not carry the invoice hash`);
    if (!r.xml.includes(`<cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">${r.previous_hash}</cbc:EmbeddedDocumentBinaryObject>`)) problems.push(`${r.no}: the XML does not carry its previous-invoice hash`);
    prev = r.invoice_hash;
  });
  return { invoices: rows.length, lastCounter: rows.at(-1)?.counter ?? 0, lastHash: rows.at(-1)?.invoice_hash ?? null, intact: problems.length === 0, problems };
}
