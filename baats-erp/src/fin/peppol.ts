import { createHash } from 'node:crypto';
import { ConflictError, NotFoundError, ValidationError } from '../core/errors.ts';
import { many, one, type Ctx, type Tx } from '../core/db.ts';
import { fixed } from '../core/money.ts';
import { roundMoney } from './ledger.ts';
import type { Problem } from './einvoice.ts';

/**
 * EN 16931 e-invoices in UBL 2.1 for the EU packs: Peppol BIS Billing 3.0
 * (Ireland, the Netherlands) and XRechnung 3.0 (Germany, its national CIUS of
 * EN 16931). A posted sales invoice or credit note is written once, after the
 * main business rules are checked, and kept unchanged with its SHA-256. Sending
 * it needs a Peppol access point; its reference and status are recorded like the
 * UAE ASP's. The official schematron remains the final check.
 */

export const PROFILES = {
  peppol: { id: 'peppol-bis-3.0', customizationId: 'urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0',
    profileId: 'urn:fdc:peppol.eu:2017:poacc:billing:01:1.0' },
  xrechnung: { id: 'xrechnung-3.0', customizationId: 'urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0',
    profileId: 'urn:fdc:peppol.eu:2017:poacc:billing:01:1.0' },
} as const;
export type EnProfile = keyof typeof PROFILES;

/** Peppol participant schemes for VAT numbers (ISO 6523 ICD). */
const VAT_SCHEME: Record<string, string> = { IE: '9935', NL: '9944', DE: '9930', FR: '9957', ES: '9920', IT: '0211', GB: '9932', BE: '9925', AT: '9915' };
const VATEX: Record<string, string> = { K: 'VATEX-EU-IC', G: 'VATEX-EU-G', AE: 'VATEX-EU-AE', O: 'VATEX-EU-O' };
const UNIT_MAP: Record<string, string> = { EA: 'H87', PCS: 'H87', PC: 'H87', UNIT: 'C62', HR: 'HUR', HOUR: 'HUR', DAY: 'DAY', MON: 'MON', KG: 'KGM', L: 'LTR', M: 'MTR' };
const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const d10 = (v: Date | string | null) => (v === null ? null : typeof v === 'string' ? v.slice(0, 10) : v.toISOString().slice(0, 10));
const vatId = (country: string, no: string | null) => (!no ? null : /^[A-Z]{2}/.test(no) ? no.replace(/\s/g, '') : `${country}${no.replace(/\s/g, '')}`);
/** An endpoint "scheme:id" from the attribute, else the VAT number, else (XRechnung) the email address. */
const endpoint = (raw: string | null | undefined, country: string, vat: string | null, email: string | null | undefined, profile: EnProfile) => {
  if (raw && /^\d{4}:.+$/.test(raw)) { const [scheme, ...id] = raw.split(':'); return { scheme, id: id.join(':') }; }
  if (vat && VAT_SCHEME[country]) return { scheme: VAT_SCHEME[country], id: vat };
  if (profile === 'xrechnung' && email) return { scheme: 'EM', id: email };
  return null;
};

export async function enModel(tx: Tx, invoiceId: string, profile: EnProfile) {
  const inv = await one(tx, 'SELECT * FROM fin.invoices WHERE id = $1', [invoiceId]);
  if (!inv) throw new NotFoundError('document');
  if (!['sales_invoice', 'sales_credit'].includes(inv.kind)) throw new ValidationError('e-invoices are issued for sales invoices and credit notes');
  if (inv.status !== 'posted') throw new ValidationError('post the document before issuing its e-invoice');
  const c = await one(tx, 'SELECT * FROM fin.companies WHERE unit_id = $1', [inv.company_id]);
  const p = await one(tx, 'SELECT * FROM mdm.parties WHERE id = $1', [inv.party_id]);
  const a = p.attributes ?? {};
  const lines = await many(tx, `SELECT l.*, t.rate::float AS rate, trim(t.einvoice_category) AS cat, t.exemption_reason_code, t.exemption_reason, i.name AS item_name, u.code AS uom
                                  FROM fin.invoice_lines l JOIN fin.tax_codes t ON t.id = l.tax_code_id
                                  LEFT JOIN mdm.items i ON i.id = l.item_id LEFT JOIN mdm.uoms u ON u.id = i.base_uom_id
                                 WHERE l.invoice_id = $1 ORDER BY l.line_no`, [invoiceId]);
  const orig = inv.credit_of ? await one(tx, 'SELECT no, date FROM fin.invoices WHERE id = $1', [inv.credit_of]) : null;
  const subs = new Map<string, { cat: string; rate: number; base: number; tax: number; code: string | null; reason: string | null }>();
  const mLines = lines.map((l) => {
    const net = Number(l.net_amount), qty = Number(l.quantity);
    const key = `${l.cat}|${l.rate}`;
    const s = subs.get(key) ?? { cat: l.cat, rate: l.rate, base: 0, tax: 0, code: l.exemption_reason_code ?? VATEX[l.cat] ?? null, reason: l.exemption_reason ?? null };
    s.base += net; s.tax += Number(l.tax_amount); subs.set(key, s);
    return { k: l.line_no, qty, unit: UNIT_MAP[String(l.uom ?? '').toUpperCase()] ?? 'C62', net, name: l.item_name ?? l.description, desc: l.description,
      price: qty ? net / qty : 0, cat: l.cat as string, rate: l.rate as number };
  });
  const lineExt = roundMoney(mLines.reduce((x, l) => x + l.net, 0));
  const tax = roundMoney([...subs.values()].reduce((x, s) => x + s.tax, 0));
  const sellerVat = vatId(c.country_code, c.tax_registration_no), buyerVat = vatId(p.country_code, p.tax_registration_no);
  return {
    inv, profile,
    m: {
      credit: inv.kind === 'sales_credit', no: inv.no, date: d10(inv.date)!, due: d10(inv.due_date), cur: inv.currency, notes: inv.notes,
      buyerRef: a.buyer_reference ?? p.code ?? inv.no, orig: orig ? { no: orig.no, date: d10(orig.date) } : null,
      seller: { name: c.legal_name, vat: sellerVat, street: c.street, city: c.city, zip: c.postal_code, ctry: c.country_code, email: c.email, phone: c.phone, iban: c.iban,
        endpoint: endpoint(null, c.country_code, sellerVat, c.email, profile) },
      buyer: { name: p.name, vat: buyerVat, street: a.street, city: a.city, zip: a.postal_code, ctry: p.country_code, email: a.email,
        endpoint: endpoint(a.peppol_endpoint, p.country_code, buyerVat, a.email, profile) },
      subs: [...subs.values()].map((s) => ({ ...s, base: roundMoney(s.base), tax: roundMoney(s.tax) })),
      lines: mLines,
      totals: { lineExt, tax, incl: roundMoney(lineExt + tax), payable: Number(inv.gross_total) },
    },
  };
}
type EnM = Awaited<ReturnType<typeof enModel>>['m'];

/** The EN 16931 business rules (and XRechnung's BR-DE) that BAATS can check from the books. */
export function validateEn(m: EnM, profile: EnProfile): Problem[] {
  const out: Problem[] = [];
  const E = (rule: string, message: string) => out.push({ rule, message });
  const s = m.seller, b = m.buyer;
  if (!s.vat) E('BR-CO-26', 'Company VAT number is needed (Finance: setup)');
  if (!s.city || !s.zip || !s.street) E('BR-08 / BR-DE-3 / BR-DE-4', 'Company street, city and postal code are needed (Finance: e-invoicing, company details)');
  if (!s.endpoint) E('PEPPOL-EN16931-R020', 'Company electronic address: a VAT number (or, for XRechnung, an email address) is needed');
  if (!b.city || !b.street) E('BR-10', `Customer ${b.name}: street and city are needed (customer attributes street, city, postal_code)`);
  if (!b.endpoint) E('PEPPOL-EN16931-R010', `Customer ${b.name}: needs a VAT number, a Peppol id (attribute peppol_endpoint as scheme:id)${profile === 'xrechnung' ? ' or an email address' : ''}`);
  if (profile === 'xrechnung') {
    if (!s.phone || !s.email) E('BR-DE-6 / BR-DE-7', 'Company phone and email are needed for XRechnung');
    if (!b.zip) E('BR-DE-9', `Customer ${b.name}: postal code is needed for XRechnung`);
    if (!m.credit && !s.iban) E('BR-DE-23', 'Company IBAN is needed for payment by credit transfer');
  }
  for (const x of m.subs) {
    if (['K', 'AE'].includes(x.cat) && !b.vat) E(x.cat === 'K' ? 'BR-IC-04' : 'BR-AE-04', `Customer ${b.name}: an EU supply needs the customer's VAT number`);
    if (x.cat === 'K' && b.ctry === s.ctry) E('BR-IC-12', 'An intra-community supply goes to a customer in another EU state');
  }
  if (m.credit && !m.orig?.no) E('BR-55', 'A credit note must refer to the invoice it credits');
  if (!m.credit && m.totals.payable > 0 && !m.due) E('BR-CO-25', 'A due date is needed when an amount is due');
  if (roundMoney(m.subs.reduce((x, t) => x + t.base, 0)) !== m.totals.lineExt) E('BR-CO-13', 'Taxable amounts must add up to the total without VAT');
  return out;
}

export function enXml(m: EnM, profile: EnProfile): string {
  const P = PROFILES[profile], CN = m.credit, cur = m.cur, root = CN ? 'CreditNote' : 'Invoice';
  const o: string[] = []; let d = 0;
  const ind = () => '  '.repeat(d);
  const el = (n: string, v: unknown, at?: Record<string, unknown>) => {
    if (v === undefined || v === null || v === '') return;
    o.push(`${ind()}<${n}${at ? Object.entries(at).map(([k, x]) => ` ${k}="${esc(x)}"`).join('') : ''}>${esc(v)}</${n}>`);
  };
  const open = (n: string) => { o.push(`${ind()}<${n}>`); d++; };
  const close = (n: string) => { d--; o.push(`${ind()}</${n}>`); };
  const amt = (n: string, v: number) => el(n, fixed(v, cur), { currencyID: cur });
  const pct = (r: number) => String(Math.round(r * 100) / 100);
  const party = (tag: string, x: EnM['seller'] | EnM['buyer'], seller: boolean) => {
    open(tag); open('cac:Party');
    if (x.endpoint) el('cbc:EndpointID', x.endpoint.id, { schemeID: x.endpoint.scheme });
    open('cac:PostalAddress'); el('cbc:StreetName', x.street); el('cbc:CityName', x.city); el('cbc:PostalZone', x.zip);
    open('cac:Country'); el('cbc:IdentificationCode', x.ctry); close('cac:Country'); close('cac:PostalAddress');
    if (x.vat) { open('cac:PartyTaxScheme'); el('cbc:CompanyID', x.vat); open('cac:TaxScheme'); el('cbc:ID', 'VAT'); close('cac:TaxScheme'); close('cac:PartyTaxScheme'); }
    open('cac:PartyLegalEntity'); el('cbc:RegistrationName', x.name); close('cac:PartyLegalEntity');
    if (seller && (('phone' in x && x.phone) || x.email)) { open('cac:Contact'); el('cbc:Name', x.name); el('cbc:Telephone', 'phone' in x ? x.phone : null); el('cbc:ElectronicMail', x.email); close('cac:Contact'); }
    close('cac:Party'); close(tag);
  };
  const cat = (tag: string, c: string, rate: number, reason?: { code: string | null; reason: string | null }) => {
    open(tag); el('cbc:ID', c); if (c !== 'O') el('cbc:Percent', pct(rate));
    if (reason && !['S', 'Z'].includes(c)) { el('cbc:TaxExemptionReasonCode', reason.code); if (!reason.code) el('cbc:TaxExemptionReason', reason.reason ?? 'Exempt'); }
    open('cac:TaxScheme'); el('cbc:ID', 'VAT'); close('cac:TaxScheme'); close(tag);
  };
  o.push('<?xml version="1.0" encoding="UTF-8"?>');
  o.push(`<${root} xmlns="urn:oasis:names:specification:ubl:schema:xsd:${root}-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">`);
  d = 1;
  el('cbc:CustomizationID', P.customizationId); el('cbc:ProfileID', P.profileId);
  el('cbc:ID', m.no); el('cbc:IssueDate', m.date); if (!CN && m.due) el('cbc:DueDate', m.due);
  el(CN ? 'cbc:CreditNoteTypeCode' : 'cbc:InvoiceTypeCode', CN ? '381' : '380');
  if (m.notes) el('cbc:Note', m.notes);
  el('cbc:DocumentCurrencyCode', cur); el('cbc:BuyerReference', m.buyerRef);
  if (m.orig?.no) { open('cac:BillingReference'); open('cac:InvoiceDocumentReference'); el('cbc:ID', m.orig.no); el('cbc:IssueDate', m.orig.date); close('cac:InvoiceDocumentReference'); close('cac:BillingReference'); }
  party('cac:AccountingSupplierParty', m.seller, true);
  party('cac:AccountingCustomerParty', m.buyer, false);
  if (m.subs.some((x) => x.cat === 'K')) { open('cac:Delivery'); el('cbc:ActualDeliveryDate', m.date); open('cac:DeliveryLocation'); open('cac:Address'); el('cbc:CityName', m.buyer.city); open('cac:Country'); el('cbc:IdentificationCode', m.buyer.ctry); close('cac:Country'); close('cac:Address'); close('cac:DeliveryLocation'); close('cac:Delivery'); }
  if (!CN && m.seller.iban) { open('cac:PaymentMeans'); el('cbc:PaymentMeansCode', '58'); el('cbc:PaymentID', m.no); open('cac:PayeeFinancialAccount'); el('cbc:ID', m.seller.iban); close('cac:PayeeFinancialAccount'); close('cac:PaymentMeans'); }
  open('cac:TaxTotal'); amt('cbc:TaxAmount', m.totals.tax);
  for (const x of m.subs) { open('cac:TaxSubtotal'); amt('cbc:TaxableAmount', x.base); amt('cbc:TaxAmount', x.tax); cat('cac:TaxCategory', x.cat, x.rate, x); close('cac:TaxSubtotal'); }
  close('cac:TaxTotal');
  open('cac:LegalMonetaryTotal'); amt('cbc:LineExtensionAmount', m.totals.lineExt); amt('cbc:TaxExclusiveAmount', m.totals.lineExt);
  amt('cbc:TaxInclusiveAmount', m.totals.incl); amt('cbc:PayableAmount', m.totals.payable); close('cac:LegalMonetaryTotal');
  const LT = CN ? 'cac:CreditNoteLine' : 'cac:InvoiceLine', QT = CN ? 'cbc:CreditedQuantity' : 'cbc:InvoicedQuantity';
  for (const x of m.lines) {
    open(LT); el('cbc:ID', String(x.k)); el(QT, String(x.qty), { unitCode: x.unit }); amt('cbc:LineExtensionAmount', x.net);
    open('cac:Item'); if (x.desc && x.desc !== x.name) el('cbc:Description', x.desc); el('cbc:Name', x.name); cat('cac:ClassifiedTaxCategory', x.cat, x.rate); close('cac:Item');
    open('cac:Price'); el('cbc:PriceAmount', String(Math.round(x.price * 1e4) / 1e4), { currencyID: cur }); close('cac:Price');
    close(LT);
  }
  close(root);
  return o.join('\n') + '\n';
}

export async function enPreview(tx: Tx, invoiceId: string, profile: EnProfile) {
  const { m } = await enModel(tx, invoiceId, profile);
  const problems = validateEn(m, profile);
  return { ready: problems.length === 0, problems, profile: PROFILES[profile].id, xml: problems.length ? null : enXml(m, profile) };
}

export async function enIssue(tx: Tx, ctx: Ctx, invoiceId: string, profile: EnProfile) {
  const { inv, m } = await enModel(tx, invoiceId, profile);
  if (await one(tx, 'SELECT 1 FROM fin.einvoices WHERE invoice_id = $1', [invoiceId])) throw new ConflictError('the e-invoice for this document is already issued');
  const problems = validateEn(m, profile);
  if (problems.length) throw new ValidationError(`fix before issuing: ${problems.map((p) => `${p.message} [${p.rule}]`).join('; ')}`);
  const id = (await one(tx, 'SELECT gen_random_uuid() AS u')).u as string;
  const xml = enXml(m, profile);
  return one(tx, `INSERT INTO fin.einvoices (tenant_id, company_id, invoice_id, uuid, profile, xml, xml_sha256, created_by)
    VALUES (app.tenant(), $1, $2, $3, $4, $5, $6, $7) RETURNING id, invoice_id, uuid, profile, status, xml_sha256, created_at`,
    [inv.company_id, invoiceId, id, PROFILES[profile].id, xml, createHash('sha256').update(xml).digest('hex'), ctx.userId]);
}
