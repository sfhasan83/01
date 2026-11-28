import { createHash } from 'node:crypto';
import { ConflictError, NotFoundError, ValidationError } from '../core/errors.ts';
import { many, one, type Ctx, type Tx } from '../core/db.ts';
import { authorize } from '../iam/authz.ts';
import { roundMoney } from './ledger.ts';
import { fixed } from '../core/money.ts';
import { companyPack } from './country.ts';
import { verifyZatcaChain, zatcaIssue, zatcaPreview } from './zatca.ts';
import { enIssue, enPreview } from './peppol.ts';
import { isPkProvince, saIssue, saPreview } from './einvoice_sa.ts';

/**
 * UAE e-invoicing: PINT AE (Peppol International, UAE specialisation) UBL 2.1, ported
 * from BAATS Accounting pintae.js. A posted sales invoice or credit note becomes the
 * e-invoice data model, is pre-validated against the UAE business rules below, and is
 * written as UBL XML and stored unchanged. The official PINT AE schematron and the
 * accredited service provider (ASP) remain authoritative; sending to an ASP needs a
 * contract with one, so here the status and the ASP's reference are recorded.
 */

/** Profile values, as in BAATS: 'confirmed' against the published rule, 'confirm' still to check with the ASP. */
export const PINT_AE_PROFILE = {
  id: 'pint-ae-1.0.4',
  values: {
    customizationId: { v: 'urn:peppol:pint:billing-1@ae-1', st: 'confirmed', ref: 'aligned-ibrp-001-ae' },
    profileId: { v: 'urn:peppol:bis:billing', st: 'confirmed', ref: 'aligned-ibrp-002-ae' },
    invoiceTypeTax: { v: '380', st: 'confirm', ref: 'UNCL1001' },
    invoiceTypeOutOfScope: { v: '480', st: 'confirmed', ref: 'ibr-134-ae' },
    creditNoteType: { v: '381', st: 'confirmed', ref: 'ibr-158-ae' },
    endpointScheme: { v: '0235', st: 'confirmed', ref: 'ibr-150-ae' },
    taxScheme: { v: 'VAT', st: 'confirmed', ref: 'ibr-133-ae' },
    taxCurrency: { v: 'AED', st: 'confirmed', ref: 'ibr-140-ae' },
    aedTotalDocType: { v: 'aedtotal-incl-vat', st: 'confirmed', ref: 'ibr-175-ae' },
    paymentMeansDefault: { v: '30', st: 'confirmed', ref: 'UNCL4461' },
    emirates: { v: ['AUH', 'DXB', 'SHJ', 'UAQ', 'FUJ', 'AJM', 'RAK'], st: 'confirmed', ref: 'ibr-128-ae' },
  },
} as const;
const V = PINT_AE_PROFILE.values;
const UNIT_MAP: Record<string, string> = { EA: 'EA', PCS: 'H87', PC: 'H87', UNIT: 'C62', HR: 'HUR', HOUR: 'HUR', DAY: 'DAY', MON: 'MON', KG: 'KGM', L: 'LTR', M: 'MTR' };

const isTRN = (t?: string | null) => !!t && /^1\d{12}03$/.test(t);
const a2 = (n: number) => roundMoney(n).toFixed(2);
const pn = (n: number) => { const v = Math.round(n * 1e6) / 1e6; return Number.isInteger(v * 100) ? v.toFixed(2) : String(v); };
const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const d10 = (v: Date | string | null) => (v === null ? null : typeof v === 'string' ? v.slice(0, 10) : v.toISOString().slice(0, 10));

export interface Problem { rule: string; message: string }

/** Build the e-invoice model from the books and list what the user must fix first. */
export async function buildModel(tx: Tx, invoiceId: string) {
  const { inv, model } = await modelFor(tx, invoiceId);
  return { inv, model, problems: validateModel(model) };
}

async function modelFor(tx: Tx, invoiceId: string) {
  const inv = await one(tx, 'SELECT * FROM fin.invoices WHERE id = $1', [invoiceId]);
  if (!inv) throw new NotFoundError('document');
  if (!['sales_invoice', 'sales_credit'].includes(inv.kind)) throw new ValidationError('e-invoices are issued for sales invoices and credit notes');
  if (inv.status !== 'posted') throw new ValidationError('post the document before issuing its e-invoice');
  const c = await one(tx, 'SELECT * FROM fin.companies WHERE unit_id = $1', [inv.company_id]);
  const p = await one(tx, 'SELECT * FROM mdm.parties WHERE id = $1', [inv.party_id]);
  const lines = await many(tx, `SELECT l.*, t.category, t.rate, trim(t.einvoice_category) AS einvoice_category, i.item_type, i.name AS item_name, u.code AS uom
                                  FROM fin.invoice_lines l JOIN fin.tax_codes t ON t.id = l.tax_code_id
                                  LEFT JOIN mdm.items i ON i.id = l.item_id LEFT JOIN mdm.uoms u ON u.id = i.base_uom_id
                                 WHERE l.invoice_id = $1 ORDER BY l.line_no`, [invoiceId]);
  const orig = inv.credit_of ? await one(tx, 'SELECT no, date FROM fin.invoices WHERE id = $1', [inv.credit_of]) : null;
  const fx = Number(inv.fx_rate);
  const credit = inv.kind === 'sales_credit';
  const exportSale = p.country_code !== 'AE';
  const outOfScope = lines.every((l) => l.einvoice_category === 'O');
  const a = p.attributes ?? {};
  const subs = new Map<string, { cat: string; rate: number; base: number; tax: number }>();
  const mLines = lines.map((l) => {
    const net = Number(l.net_amount), vat = Number(l.tax_amount), qty = Number(l.quantity);
    const s = subs.get(l.einvoice_category + l.rate) ?? { cat: l.einvoice_category, rate: Number(l.rate), base: 0, tax: 0 };
    s.base += net; s.tax += vat; subs.set(l.einvoice_category + l.rate, s);
    return {
      k: l.line_no, qty, unit: UNIT_MAP[String(l.uom ?? '').toUpperCase()] ?? 'C62', net, desc: l.description, name: l.item_name ?? l.description,
      itype: l.item_type === 'stock' ? 'G' : l.item_type === 'service' || !l.item_type ? 'S' : 'B',
      cat: l.einvoice_category, rate: Number(l.rate), gross: Number(l.unit_price), discAmt: roundMoney(Number(l.discount) / qty), netp: net / qty,
      vat, totAed: roundMoney((net + vat) * fx), vatAed: roundMoney(vat * fx),
    };
  });
  const lineExt = roundMoney(mLines.reduce((x, l) => x + l.net, 0));
  const tax = roundMoney(mLines.reduce((x, l) => x + l.vat, 0));
  const model = {
    ubl: credit ? 'CreditNote' : 'Invoice', no: inv.no, date: d10(inv.date)!, due: d10(inv.due_date), sdate: d10(inv.tax_date),
    typeCode: credit ? V.creditNoteType.v : outOfScope ? V.invoiceTypeOutOfScope.v : V.invoiceTypeTax.v,
    // BTAE-02 transaction type flags; the last one marks exports.
    tx: exportSale ? '00000001' : '00000000',
    cur: inv.currency, rate: fx, notes: inv.notes,
    reason: credit ? { code: 'VD', text: inv.notes ?? 'Credit note' } : null,
    orig: orig ? { no: orig.no, date: d10(orig.date) } : null,
    seller: { name: c.legal_name, trn: c.tax_registration_no, tin: c.tax_registration_no ? c.tax_registration_no.slice(0, 10) : '', street: c.street, city: c.city,
      sub: c.emirate, ctry: 'AE', email: c.email, phone: c.phone, iban: c.iban, regId: c.trade_licence_no, regType: 'TL', regAuth: c.licence_authority },
    buyer: { name: p.name, trn: p.country_code === 'AE' ? p.tax_registration_no : null, street: a.street, city: a.city, sub: a.emirate, ctry: p.country_code,
      email: a.email, phone: a.phone, contact: a.contact_name,
      endpoint: p.country_code === 'AE' && p.tax_registration_no ? String(p.tax_registration_no).slice(0, 10) : a.peppol_endpoint, endpointScheme: V.endpointScheme.v },
    pm: V.paymentMeansDefault.v, terms: a.payment_terms_days ?? 30,
    subs: [...subs.values()].map((s) => ({ ...s, base: roundMoney(s.base), tax: roundMoney(s.tax) })),
    lines: mLines,
    totals: { lineExt, taxExcl: lineExt, tax, taxIncl: roundMoney(lineExt + tax), payable: Number(inv.gross_total), taxAed: roundMoney(tax * fx), totalAed: roundMoney((lineExt + tax) * fx) },
  };
  return { inv, model };
}

type Model = Awaited<ReturnType<typeof modelFor>>['model'];

/** UAE business rules checked before the XML is written (subset of the PINT AE rules BAATS pre-validates). */
export function validateModel(m: Model): Problem[] {
  const out: Problem[] = [];
  const E = (rule: string, message: string) => out.push({ rule, message });
  const s = m.seller, b = m.buyer;
  if (m.typeCode !== V.invoiceTypeOutOfScope.v && !isTRN(s.trn)) E('ibr-132-ae', 'Company TRN: 15 digits, starting with 1 and ending with 03 (Finance: setup)');
  if (!s.street || !s.city) E('ibr-143-ae', 'Company address: street and city are needed (Finance: setup)');
  if (!s.sub || !V.emirates.v.includes(s.sub)) E('ibr-128-ae', 'Company emirate must be one of AUH, DXB, SHJ, UAQ, FUJ, AJM, RAK');
  if (!s.regId || !s.regAuth) E('ibr-150-ae / ibr-172-ae', 'Company trade licence number and issuing authority are needed');
  if (m.ubl === 'Invoice' && ['30', '58'].includes(m.pm) && !/^AE\d{21}$/.test(s.iban ?? '')) E('ibr-192-ae', 'Company IBAN is needed for payment by credit transfer');
  if (!b.street || !b.city) E('ibr-144-ae', `Customer ${b.name}: street and city are needed (customer attributes street, city)`);
  if (b.ctry === 'AE' && (!b.sub || !V.emirates.v.includes(b.sub))) E('ibr-128-ae', `Customer ${b.name}: emirate (AUH, DXB, SHJ, UAQ, FUJ, AJM, RAK) is needed`);
  if (b.trn && !isTRN(b.trn)) E('ibr-132-ae', `Customer ${b.name}: TRN must be 15 digits starting with 1 and ending with 03`);
  if (!b.endpoint) E('ibr-135-ae', `Customer ${b.name}: needs a UAE TRN, or a Peppol endpoint (attribute peppol_endpoint) for consumers and exports`);
  if (m.ubl === 'Invoice' && m.totals.payable > 0 && !m.due) E('ibr-127-ae', 'A payment due date is required when an amount is due');
  if (m.ubl === 'CreditNote' && !m.orig?.no) E('ibr-158-ae', 'A credit note must refer to the invoice it credits');
  if (m.cur !== 'AED' && !(m.rate > 0)) E('ibr-159-ae', 'An exchange rate to AED is required');
  const sumSubs = roundMoney(m.subs.reduce((x, t) => x + t.tax, 0));
  if (sumSubs !== m.totals.tax) E('IBR-CO-14', 'VAT total must equal the sum of the VAT breakdown');
  if (roundMoney(m.subs.reduce((x, t) => x + t.base, 0)) !== m.totals.taxExcl) E('IBR-CO-13', 'Taxable amounts must add up to the total without VAT');
  return out;
}

/** UBL 2.1 Invoice or CreditNote in PINT AE, laid out as BAATS toXml() does. */
export function toXml(m: Model, uuid: string): string {
  const CN = m.ubl === 'CreditNote', cur = m.cur, AED = V.taxCurrency.v, fx = cur !== AED;
  const o: string[] = []; let d = 0;
  const ind = () => '  '.repeat(d);
  const el = (n: string, v: unknown, at?: Record<string, unknown>) => {
    if (v === undefined || v === null || v === '') return;
    o.push(`${ind()}<${n}${at ? Object.entries(at).filter(([, x]) => x !== '' && x != null).map(([k, x]) => ` ${k}="${esc(x)}"`).join('') : ''}>${esc(v)}</${n}>`);
  };
  const open = (n: string, at?: Record<string, string>) => { o.push(`${ind()}<${n}${at ? Object.entries(at).map(([k, x]) => ` ${k}="${esc(x)}"`).join('') : ''}>`); d++; };
  const close = (n: string) => { d--; o.push(`${ind()}</${n}>`); };
  const amt = (n: string, v: number, c = cur) => el(n, fixed(v, c), { currencyID: c });
  const taxCat = (tag: string, c: string, rate: number) => {
    open(tag); el('cbc:ID', c); if (c !== 'E' && c !== 'O') el('cbc:Percent', pn(rate));
    open('cac:TaxScheme'); el('cbc:ID', V.taxScheme.v); close('cac:TaxScheme'); close(tag);
  };
  const addr = (tag: string, p: { street?: string; city?: string; sub?: string; ctry: string }) => {
    open(tag); el('cbc:StreetName', p.street); el('cbc:CityName', p.city); if (p.ctry === 'AE' || p.sub) el('cbc:CountrySubentity', p.sub);
    open('cac:Country'); el('cbc:IdentificationCode', p.ctry); close('cac:Country'); close(tag);
  };
  o.push('<?xml version="1.0" encoding="UTF-8"?>');
  const root = CN ? 'CreditNote' : 'Invoice';
  open(root, { xmlns: `urn:oasis:names:specification:ubl:schema:xsd:${root}-2`,
    'xmlns:cac': 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2',
    'xmlns:cbc': 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2' });
  el('cbc:CustomizationID', V.customizationId.v); el('cbc:ProfileID', V.profileId.v); el('cbc:ProfileExecutionID', m.tx);
  el('cbc:ID', m.no); el('cbc:UUID', uuid); el('cbc:IssueDate', m.date);
  if (!CN && m.due) el('cbc:DueDate', m.due);
  el(CN ? 'cbc:CreditNoteTypeCode' : 'cbc:InvoiceTypeCode', m.typeCode);
  if (m.notes) el('cbc:Note', m.notes);
  if (!CN && m.sdate && m.sdate < m.date) el('cbc:TaxPointDate', m.sdate);
  el('cbc:DocumentCurrencyCode', cur); if (fx) el('cbc:TaxCurrencyCode', AED);
  if (CN && m.reason) { open('cac:DiscrepancyResponse'); el('cbc:ResponseCode', m.reason.code); el('cbc:Description', m.reason.text); close('cac:DiscrepancyResponse'); }
  if (m.orig?.no) { open('cac:BillingReference'); open('cac:InvoiceDocumentReference'); el('cbc:ID', m.orig.no); el('cbc:IssueDate', m.orig.date); close('cac:InvoiceDocumentReference'); close('cac:BillingReference'); }
  if (fx) { open('cac:AdditionalDocumentReference'); el('cbc:ID', m.no); el('cbc:DocumentTypeCode', V.aedTotalDocType.v); el('cbc:DocumentDescription', a2(m.totals.totalAed)); close('cac:AdditionalDocumentReference'); }
  const s = m.seller;
  open('cac:AccountingSupplierParty'); open('cac:Party');
  el('cbc:EndpointID', s.tin, { schemeID: V.endpointScheme.v });
  addr('cac:PostalAddress', s);
  if (s.trn) { open('cac:PartyTaxScheme'); el('cbc:CompanyID', s.trn); open('cac:TaxScheme'); el('cbc:ID', V.taxScheme.v); close('cac:TaxScheme'); close('cac:PartyTaxScheme'); }
  open('cac:PartyLegalEntity'); el('cbc:RegistrationName', s.name); el('cbc:CompanyID', s.regId, { schemeAgencyID: s.regType, schemeAgencyName: s.regAuth }); close('cac:PartyLegalEntity');
  if (s.email || s.phone) { open('cac:Contact'); el('cbc:Telephone', s.phone); el('cbc:ElectronicMail', s.email); close('cac:Contact'); }
  close('cac:Party'); close('cac:AccountingSupplierParty');
  const b = m.buyer;
  open('cac:AccountingCustomerParty'); open('cac:Party');
  el('cbc:EndpointID', b.endpoint, { schemeID: b.endpointScheme });
  addr('cac:PostalAddress', b);
  if (b.trn) { open('cac:PartyTaxScheme'); el('cbc:CompanyID', b.trn); open('cac:TaxScheme'); el('cbc:ID', V.taxScheme.v); close('cac:TaxScheme'); close('cac:PartyTaxScheme'); }
  open('cac:PartyLegalEntity'); el('cbc:RegistrationName', b.name); close('cac:PartyLegalEntity');
  if (b.contact || b.phone || b.email) { open('cac:Contact'); el('cbc:Name', b.contact); el('cbc:Telephone', b.phone); el('cbc:ElectronicMail', b.email); close('cac:Contact'); }
  close('cac:Party'); close('cac:AccountingCustomerParty');
  if (m.tx.endsWith('1')) { open('cac:Delivery'); open('cac:DeliveryLocation'); addr('cac:Address', b); close('cac:DeliveryLocation'); close('cac:Delivery'); }
  if (!CN) {
    open('cac:PaymentMeans'); el('cbc:PaymentMeansCode', m.pm);
    if (s.iban && ['30', '42', '58'].includes(m.pm)) { open('cac:PayeeFinancialAccount'); el('cbc:ID', s.iban); close('cac:PayeeFinancialAccount'); }
    close('cac:PaymentMeans');
    open('cac:PaymentTerms'); el('cbc:Note', Number(m.terms) ? `Net ${m.terms} days` : 'Due on receipt'); close('cac:PaymentTerms');
  }
  if (fx) { open('cac:TaxExchangeRate'); el('cbc:SourceCurrencyCode', cur); el('cbc:TargetCurrencyCode', AED); el('cbc:CalculationRate', String(m.rate)); el('cbc:MathematicOperatorCode', 'Multiply'); close('cac:TaxExchangeRate'); }
  open('cac:TaxTotal'); amt('cbc:TaxAmount', m.totals.tax);
  for (const x of m.subs) { open('cac:TaxSubtotal'); amt('cbc:TaxableAmount', x.base); amt('cbc:TaxAmount', x.tax); taxCat('cac:TaxCategory', x.cat, x.rate); close('cac:TaxSubtotal'); }
  close('cac:TaxTotal');
  if (fx) { open('cac:TaxTotal'); amt('cbc:TaxAmount', m.totals.taxAed, AED); close('cac:TaxTotal'); }
  open('cac:LegalMonetaryTotal'); amt('cbc:LineExtensionAmount', m.totals.lineExt); amt('cbc:TaxExclusiveAmount', m.totals.taxExcl);
  amt('cbc:TaxInclusiveAmount', m.totals.taxIncl); amt('cbc:PayableAmount', m.totals.payable); close('cac:LegalMonetaryTotal');
  const LT = CN ? 'cac:CreditNoteLine' : 'cac:InvoiceLine', QT = CN ? 'cbc:CreditedQuantity' : 'cbc:InvoicedQuantity';
  for (const x of m.lines) {
    open(LT); el('cbc:ID', String(x.k)); el(QT, String(x.qty), { unitCode: x.unit }); amt('cbc:LineExtensionAmount', x.net);
    open('cac:Item'); el('cbc:Description', x.desc); el('cbc:Name', x.name);
    open('cac:CommodityClassification'); el('cbc:CommodityCode', x.itype); close('cac:CommodityClassification');
    taxCat('cac:ClassifiedTaxCategory', x.cat, x.rate); close('cac:Item');
    open('cac:Price'); el('cbc:PriceAmount', pn(x.netp), { currencyID: cur }); el('cbc:BaseQuantity', '1', { unitCode: x.unit });
    open('cac:AllowanceCharge'); el('cbc:ChargeIndicator', 'false'); el('cbc:Amount', pn(x.discAmt), { currencyID: cur }); el('cbc:BaseAmount', pn(x.gross), { currencyID: cur }); close('cac:AllowanceCharge');
    close('cac:Price');
    open('cac:ItemPriceExtension'); amt('cbc:Amount', x.totAed, AED);
    if (x.cat !== 'E') { open('cac:TaxTotal'); amt('cbc:TaxAmount', x.vatAed, AED); close('cac:TaxTotal'); }
    close('cac:ItemPriceExtension'); close(LT);
  }
  close(root);
  return o.join('\n') + '\n';
}

/** Check a document is ready for e-invoicing, without issuing it. */
export async function preview(tx: Tx, ctx: Ctx, invoiceId: string) {
  const company = await documentCompany(tx, invoiceId);
  const pack = await companyPack(tx, company);
  if (!pack.einvoice) throw new ValidationError(pack.einvoiceGap ?? `${pack.name} has no e-invoicing`);
  if (pack.einvoice === 'zatca') {
    await authorize(tx, ctx, 'fin.einvoice.manage', { unitId: company });
    return zatcaPreview(tx, invoiceId);
  }
  if (pack.einvoice === 'peppol' || pack.einvoice === 'xrechnung') {
    await authorize(tx, ctx, 'fin.einvoice.manage', { unitId: company });
    return enPreview(tx, invoiceId, pack.einvoice);
  }
  if (pack.einvoice === 'in_irp' || pack.einvoice === 'pk_fbr') {
    await authorize(tx, ctx, 'fin.einvoice.manage', { unitId: company });
    return saPreview(tx, invoiceId, pack.einvoice);
  }
  const { inv, model, problems } = await buildModel(tx, invoiceId);
  await authorize(tx, ctx, 'fin.einvoice.manage', { unitId: inv.company_id });
  return { ready: problems.length === 0, problems, xml: problems.length ? null : toXml(model, '00000000-0000-0000-0000-000000000000') };
}

/** Issue the e-invoice: validate, write the XML once and keep it. */
export async function issue(tx: Tx, ctx: Ctx, invoiceId: string) {
  const company = await documentCompany(tx, invoiceId);
  const pack = await companyPack(tx, company);
  if (!pack.einvoice) throw new ValidationError(pack.einvoiceGap ?? `${pack.name} has no e-invoicing`);
  if (pack.einvoice === 'zatca') {
    await authorize(tx, ctx, 'fin.einvoice.manage', { unitId: company });
    return zatcaIssue(tx, ctx, invoiceId);
  }
  if (pack.einvoice === 'peppol' || pack.einvoice === 'xrechnung') {
    await authorize(tx, ctx, 'fin.einvoice.manage', { unitId: company });
    return enIssue(tx, ctx, invoiceId, pack.einvoice);
  }
  if (pack.einvoice === 'in_irp' || pack.einvoice === 'pk_fbr') {
    await authorize(tx, ctx, 'fin.einvoice.manage', { unitId: company });
    return saIssue(tx, ctx, invoiceId, pack.einvoice);
  }
  const { inv, model, problems } = await buildModel(tx, invoiceId);
  await authorize(tx, ctx, 'fin.einvoice.manage', { unitId: inv.company_id });
  if (await one(tx, 'SELECT 1 FROM fin.einvoices WHERE invoice_id = $1', [invoiceId])) throw new ConflictError('the e-invoice for this document is already issued');
  if (problems.length) throw new ValidationError(`fix before issuing: ${problems.map((p) => `${p.message} [${p.rule}]`).join('; ')}`);
  const id = (await one(tx, 'SELECT gen_random_uuid() AS u')).u as string;
  const xml = toXml(model, id);
  return one(tx, `INSERT INTO fin.einvoices (tenant_id, company_id, invoice_id, uuid, profile, xml, xml_sha256, created_by)
    VALUES (app.tenant(), $1, $2, $3, $4, $5, $6, $7) RETURNING id, invoice_id, uuid, profile, status, xml_sha256, created_at`,
    [inv.company_id, invoiceId, id, PINT_AE_PROFILE.id, xml, createHash('sha256').update(xml).digest('hex'), ctx.userId]);
}

async function documentCompany(tx: Tx, invoiceId: string): Promise<string> {
  const r = await one(tx, 'SELECT company_id FROM fin.invoices WHERE id = $1', [invoiceId]);
  if (!r) throw new NotFoundError('document');
  return r.company_id;
}

/** Saudi companies: check the e-invoice hash chain end to end. */
export async function checkChain(tx: Tx, ctx: Ctx, companyId: string) {
  await authorize(tx, ctx, 'fin.report.read', { unitId: companyId });
  if ((await companyPack(tx, companyId)).einvoice !== 'zatca') throw new ValidationError('the hash chain applies to Saudi (ZATCA) e-invoices');
  return verifyZatcaChain(tx, companyId);
}

/** Record what the accredited service provider (UAE) or ZATCA (Saudi Arabia) said about the e-invoice. */
export async function recordAspResponse(tx: Tx, ctx: Ctx, einvoiceId: string, input: { status: 'submitted' | 'accepted' | 'rejected'; reference?: string; message?: string }) {
  const e = await one(tx, 'SELECT * FROM fin.einvoices WHERE id = $1', [einvoiceId]);
  if (!e) throw new NotFoundError('e-invoice');
  await authorize(tx, ctx, 'fin.einvoice.manage', { unitId: e.company_id });
  if (e.status === 'accepted') throw new ConflictError('the e-invoice is already accepted');
  return one(tx, `UPDATE fin.einvoices SET status = $2, asp_reference = coalesce($3, asp_reference), asp_message = $4 WHERE id = $1
    RETURNING id, invoice_id, status, asp_reference, asp_message`, [einvoiceId, input.status, input.reference ?? null, input.message ?? null]);
}

export async function getEinvoice(tx: Tx, ctx: Ctx, einvoiceId: string) {
  const e = await one(tx, 'SELECT * FROM fin.einvoices WHERE id = $1', [einvoiceId]);
  if (!e) throw new NotFoundError('e-invoice');
  await authorize(tx, ctx, 'fin.report.read', { unitId: e.company_id });
  return e;
}

export async function listEinvoices(tx: Tx, ctx: Ctx, companyId: string) {
  await authorize(tx, ctx, 'fin.report.read', { unitId: companyId });
  return many(tx, `SELECT i.id AS invoice_id, i.no, i.kind, i.date, i.gross_total, i.currency, p.name AS party_name,
                          e.id AS einvoice_id, e.status, e.asp_reference, e.created_at AS issued_at, e.counter, e.invoice_type, e.qr, e.profile
                     FROM fin.invoices i JOIN mdm.parties p ON p.id = i.party_id LEFT JOIN fin.einvoices e ON e.invoice_id = i.id
                    WHERE i.company_id = $1 AND i.status = 'posted' AND i.kind IN ('sales_invoice','sales_credit')
                    ORDER BY i.date DESC, i.no DESC`, [companyId]);
}

/**
 * Seller details on the company used by e-invoices: address (with the emirate in
 * the UAE, or the building number, district and postal code of the Saudi national
 * address), licence or commercial registration, IBAN and tax number.
 */
export async function updateCompanyDetails(tx: Tx, ctx: Ctx, companyId: string, d: Record<string, string | undefined>) {
  await authorize(tx, ctx, 'fin.company.manage', { unitId: companyId });
  const pack = await companyPack(tx, companyId);
  if (d.iban && !pack.iban.re.test(d.iban.replace(/\s/g, ''))) throw new ValidationError(pack.iban.message);
  if (pack.country === 'AE' && d.taxRegistrationNo && !isTRN(d.taxRegistrationNo)) throw new ValidationError('a UAE TRN has 15 digits, starts with 1 and ends with 03');
  if (d.taxRegistrationNo && !pack.taxNumber.test(d.taxRegistrationNo)) throw new ValidationError(pack.taxNumber.message);
  if (d.emirate && pack.country !== 'AE') throw new ValidationError('the emirate applies to UAE companies');
  if (pack.region === 'UK' && d.postalCode && !/^[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}$/i.test(d.postalCode)) throw new ValidationError('a UK postcode looks like SW1A 1AA');
  if (d.province && pack.country !== 'PK') throw new ValidationError('the province applies to Pakistani companies');
  if (d.province && !isPkProvince(d.province)) throw new ValidationError('the province is Punjab, Sindh, Khyber Pakhtunkhwa, Balochistan, Islamabad Capital Territory, Gilgit-Baltistan or Azad Jammu and Kashmir');
  if (pack.country === 'IN' && d.postalCode && !/^[1-9]\d{5}$/.test(d.postalCode)) throw new ValidationError('an Indian PIN code has 6 digits');
  if (pack.country === 'SA' && d.buildingNo && !/^\d{4}$/.test(d.buildingNo)) throw new ValidationError('the building number has 4 digits');
  if (pack.country === 'SA' && d.postalCode && !/^\d{5}$/.test(d.postalCode)) throw new ValidationError('the postal code has 5 digits');
  const cols: Record<string, string> = { street: 'street', city: 'city', emirate: 'emirate', email: 'email', phone: 'phone', iban: 'iban',
    tradeLicenceNo: 'trade_licence_no', licenceAuthority: 'licence_authority', taxRegistrationNo: 'tax_registration_no',
    buildingNo: 'building_no', district: 'district', postalCode: 'postal_code', province: 'province' };
  const sets: string[] = []; const vals: unknown[] = [companyId];
  for (const [k, c] of Object.entries(cols)) if (d[k] !== undefined) { vals.push(k === 'iban' ? d[k]!.replace(/\s/g, '') : d[k]); sets.push(`${c} = $${vals.length}`); }
  if (!sets.length) throw new ValidationError('nothing to change');
  return one(tx, `UPDATE fin.companies SET ${sets.join(', ')} WHERE unit_id = $1 RETURNING *`, vals);
}
