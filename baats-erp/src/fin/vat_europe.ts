import { fixed } from '../core/money.ts';
import { many, type Tx } from '../core/db.ts';
import { roundMoney } from './ledger.ts';
import { EU } from './europe.ts';
import type { VatBox } from './tax.ts';

/**
 * VAT returns for the UK and EU packs. The ledger's VAT-coded lines of the period
 * are summed by tax code, and each country's form takes its boxes from the codes:
 * domestic rates (SR, RR, RR2, RR3), zero rated (ZR), exempt (EX), intra-community
 * supplies of goods (IC) and services (ICS), exports (EXP), out of scope (OS), and
 * the self-assessed purchases: intra-community acquisitions (ICA), services from
 * abroad (RCS) and, in the UK, imports under postponed VAT accounting (PVA).
 */

const SALES_TYPES = ['sales_invoice', 'sales_credit'];
const PURCHASE_TYPES = ['purchase_invoice', 'purchase_credit', 'fuel', 'expense_claim'];

export interface CodeTotals {
  /** Net sales (credits) by tax code and rate. */
  sales: Map<string, { net: number; vat: number; rate: number }>;
  /** Net purchases (debits) by tax code: the input VAT recovered and the output VAT self-assessed. */
  purchases: Map<string, { net: number; vatIn: number; vatOut: number; rate: number; fromEu: number; fromEuVat: number }>;
}

export async function totalsByCode(tx: Tx, companyId: string, from: string, to: string): Promise<CodeTotals> {
  const rows = await many(tx, `
    SELECT j.type, t.code, t.rate::float AS rate, coalesce(a.system_role, '') AS role,
           (SELECT pt.country_code FROM fin.invoices i JOIN mdm.parties pt ON pt.id = i.party_id WHERE i.journal_id = j.id LIMIT 1) AS party_country,
           sum(l.debit - l.credit)::float AS amount
      FROM fin.journal_lines l
      JOIN fin.journals j ON j.id = l.journal_id AND j.status = 'posted'
      JOIN fin.accounts a ON a.id = l.account_id
      JOIN fin.tax_codes t ON t.id = l.tax_code_id
     WHERE j.company_id = $1 AND j.date BETWEEN $2 AND $3 AND j.type = ANY($4)
     GROUP BY 1, 2, 3, 4, 5`, [companyId, from, to, [...SALES_TYPES, ...PURCHASE_TYPES]]);
  const out: CodeTotals = { sales: new Map(), purchases: new Map() };
  for (const r of rows) {
    if (SALES_TYPES.includes(r.type)) {
      const s = out.sales.get(r.code) ?? { net: 0, vat: 0, rate: r.rate };
      if (r.role === 'vat_output') s.vat += -r.amount; else if (r.role !== 'vat_input') s.net += -r.amount;
      out.sales.set(r.code, s);
    } else {
      const p = out.purchases.get(r.code) ?? { net: 0, vatIn: 0, vatOut: 0, rate: r.rate, fromEu: 0, fromEuVat: 0 };
      const eu = r.party_country ? EU.has(r.party_country) : false;
      if (r.role === 'vat_input') p.vatIn += r.amount;
      else if (r.role === 'vat_output') { p.vatOut += -r.amount; if (eu) p.fromEuVat += -r.amount; }
      else { p.net += r.amount; if (eu) p.fromEu += r.amount; }
      out.purchases.set(r.code, p);
    }
  }
  return out;
}

const box = (): VatBox => ({ amount: 0, vat: 0 });
const tidy = (b: Record<string, VatBox>) => { for (const v of Object.values(b)) { v.amount = roundMoney(v.amount); v.vat = roundMoney(v.vat); } return b; };
const S = (t: CodeTotals, ...codes: string[]) => codes.reduce((x, c) => { const s = t.sales.get(c); return s ? { amount: x.amount + s.net, vat: x.vat + s.vat } : x; }, box());
const P = (t: CodeTotals, ...codes: string[]) => codes.reduce((x, c) => { const p = t.purchases.get(c); return p ? { amount: x.amount + p.net, vat: x.vat + p.vatIn } : x; }, box());
const selfAssessed = (t: CodeTotals, ...codes: string[]) => codes.reduce((x, c) => x + (t.purchases.get(c)?.vatOut ?? 0), 0);
/** Every sales or purchase code but the listed ones. */
const others = (m: Map<string, unknown>, ...skip: string[]) => [...m.keys()].filter((k) => !skip.includes(k));
/** Domestic standard and reduced rate codes, by rate. */
const byRate = (t: CodeTotals, rate: number) => [...t.sales.entries()].filter(([c, s]) => /^(SR|RR\d?)$/.test(c) && s.rate === rate).map(([c]) => c);

export type Return = { boxes: Record<string, VatBox>; labels: Record<string, string>; outputTax: number; inputTax: number; netPayable: number; notes: string[] };
const result = (b: Record<string, VatBox>, labels: Record<string, string>, outputTax: number, inputTax: number, notes: string[]): Return =>
  ({ boxes: tidy(b), labels, outputTax: roundMoney(outputTax), inputTax: roundMoney(inputTax), netPayable: roundMoney(outputTax - inputTax), notes });

export const GB_LABELS: Record<string, string> = {
  '1': 'VAT due on sales and other outputs', '2': 'VAT due on acquisitions from the EU (Northern Ireland goods)', '3': 'Total VAT due',
  '4': 'VAT reclaimed on purchases and other inputs', '5': 'Net VAT to pay to HMRC or reclaim', '6': 'Total value of sales and all other outputs excluding VAT',
  '7': 'Total value of purchases and all other inputs excluding VAT', '8': 'Total value of supplies of goods to the EU (Northern Ireland)',
  '9': 'Total value of acquisitions of goods from the EU (Northern Ireland)',
};

/** The HMRC nine-box return. Reverse-charge and postponed import VAT is in box 1 and box 4 alike. */
export async function ukVatReturn(tx: Tx, companyId: string, from: string, to: string): Promise<Return> {
  const t = await totalsByCode(tx, companyId, from, to);
  const b: Record<string, VatBox> = Object.fromEntries(Object.keys(GB_LABELS).map((k) => [k, box()]));
  const sales = S(t, ...others(t.sales, 'OS'));
  const rc = selfAssessed(t, 'RCS', 'PVA');
  b['1'].vat = sales.vat + rc;
  b['3'].vat = b['1'].vat;
  const inputs = P(t, ...t.purchases.keys());
  b['4'].vat = inputs.vat;
  b['5'].vat = Math.abs(b['3'].vat - b['4'].vat);
  b['6'].amount = Math.trunc(sales.amount + (t.purchases.get('RCS')?.net ?? 0));
  b['7'].amount = Math.trunc(P(t, ...others(t.purchases, 'OS')).amount);
  return result(b, GB_LABELS, b['3'].vat, b['4'].vat, [
    `Box 1 includes ${fixed(rc)} of VAT self-assessed on services from abroad and postponed import VAT, which box 4 reclaims.`,
    'Boxes 6 and 7 are in whole pounds. Boxes 2, 8 and 9 apply to Northern Ireland goods trade with the EU only.',
    'Box 5 is always positive; whether it is to pay or to reclaim is shown by the net figure.',
  ]);
}

/** The body of the Making Tax Digital VAT return (POST /organisations/vat/{vrn}/returns), for the period key HMRC gives. */
export function mtdBody(r: Return, periodKey: string) {
  const v = (k: string) => r.boxes[k].vat, a = (k: string) => r.boxes[k].amount;
  return { periodKey, vatDueSales: v('1'), vatDueAcquisitions: v('2'), totalVatDue: v('3'), vatReclaimedCurrPeriod: v('4'), netVatDue: v('5'),
    totalValueSalesExVAT: a('6'), totalValuePurchasesExVAT: a('7'), totalValueGoodsSuppliedExVAT: a('8'), totalAcquisitionsExVAT: a('9'), finalised: true };
}

export const IE_LABELS: Record<string, string> = {
  T1: 'VAT on sales (including VAT self-assessed on EU acquisitions and services from abroad)', T2: 'VAT on purchases',
  T3: 'Net VAT payable', T4: 'Net VAT repayable', E1: 'Intra-EU supplies of goods', E2: 'Intra-EU acquisitions of goods',
  ES1: 'Intra-EU supplies of services', ES2: 'Intra-EU acquisitions of services',
};

/** The Irish VAT3. */
export async function irelandVatReturn(tx: Tx, companyId: string, from: string, to: string): Promise<Return> {
  const t = await totalsByCode(tx, companyId, from, to);
  const b: Record<string, VatBox> = Object.fromEntries(Object.keys(IE_LABELS).map((k) => [k, box()]));
  const out = S(t, ...t.sales.keys()).vat + selfAssessed(t, 'ICA', 'RCS');
  const inp = P(t, ...t.purchases.keys()).vat;
  b.T1.vat = out; b.T2.vat = inp;
  if (out >= inp) b.T3.vat = out - inp; else b.T4.vat = inp - out;
  b.E1.amount = S(t, 'IC').amount; b.E2.amount = t.purchases.get('ICA')?.net ?? 0;
  b.ES1.amount = S(t, 'ICS').amount; b.ES2.amount = t.purchases.get('RCS')?.fromEu ?? 0;
  return result(b, IE_LABELS, out, inp, ['ES2 counts services bought from suppliers in other EU states; services from outside the EU are in T1 and T2 only.']);
}

export const DE_LABELS: Record<string, string> = {
  '81': 'Steuerpflichtige Umsätze 19%', '86': 'Steuerpflichtige Umsätze 7%', '41': 'Innergemeinschaftliche Lieferungen an Abnehmer mit USt-IdNr',
  '43': 'Weitere steuerfreie Umsätze mit Vorsteuerabzug (Ausfuhren)', '48': 'Steuerfreie Umsätze ohne Vorsteuerabzug',
  '21': 'Nicht steuerbare sonstige Leistungen (EU, §18b)', '45': 'Übrige nicht steuerbare Umsätze', '89': 'Innergemeinschaftliche Erwerbe 19%',
  '93': 'Innergemeinschaftliche Erwerbe 7%', '46': 'Sonstige Leistungen eines im übrigen Gemeinschaftsgebiet ansässigen Unternehmers (§13b)',
  '84': 'Andere Leistungen (§13b), z.B. aus Drittländern', '66': 'Vorsteuerbeträge aus Rechnungen von anderen Unternehmern',
  '61': 'Vorsteuer aus innergemeinschaftlichem Erwerb', '67': 'Vorsteuer aus Leistungen im Sinne des §13b', '83': 'Verbleibende Umsatzsteuer-Vorauszahlung (Überschuss)',
};

/** The German Umsatzsteuer-Voranmeldung by Kennzahl: base in amount, tax in vat. */
export async function germanyVatReturn(tx: Tx, companyId: string, from: string, to: string): Promise<Return> {
  const t = await totalsByCode(tx, companyId, from, to);
  const b: Record<string, VatBox> = Object.fromEntries(Object.keys(DE_LABELS).map((k) => [k, box()]));
  b['81'] = S(t, ...byRate(t, 19)); b['86'] = S(t, ...byRate(t, 7));
  b['41'].amount = S(t, 'IC').amount; b['43'].amount = S(t, 'EXP', 'ZR').amount; b['48'].amount = S(t, 'EX').amount;
  b['21'].amount = S(t, 'ICS').amount; b['45'].amount = S(t, 'OS').amount;
  const ica = t.purchases.get('ICA'), rcs = t.purchases.get('RCS');
  if (ica) b[ica.rate === 7 ? '93' : '89'] = { amount: ica.net, vat: ica.vatOut };
  if (rcs) { b['46'] = { amount: rcs.fromEu, vat: rcs.fromEuVat }; b['84'] = { amount: rcs.net - rcs.fromEu, vat: rcs.vatOut - rcs.fromEuVat }; }
  b['61'].vat = ica?.vatIn ?? 0; b['67'].vat = rcs?.vatIn ?? 0;
  b['66'].vat = P(t, ...others(t.purchases, 'ICA', 'RCS')).vat;
  const out = S(t, ...t.sales.keys()).vat + (ica?.vatOut ?? 0) + (rcs?.vatOut ?? 0);
  const inp = b['61'].vat + b['67'].vat + b['66'].vat;
  b['83'].vat = out - inp;
  return result(b, DE_LABELS, out, inp, ['Kennzahl 83 is negative when the Finanzamt owes a refund. Submit the figures through ELSTER.']);
}

export const FR_LABELS: Record<string, string> = {
  A1: 'Ventes, prestations de services', A3: 'Achats de prestations de services intracommunautaires (autoliquidation)', B2: 'Acquisitions intracommunautaires',
  E1: 'Exportations hors UE', E2: 'Autres opérations non imposables', F2: 'Livraisons intracommunautaires', '08': 'Taux normal 20%', '09': 'Taux réduit 5.5%',
  '9B': 'Taux réduit 10%', T2: 'Taux 2.1%', '16': 'Total de la TVA brute due', '17': 'Dont TVA sur acquisitions intracommunautaires',
  '20': 'Autres biens et services (TVA déductible)', '23': 'Total TVA déductible', '28': 'TVA nette due', '25': 'Crédit de TVA',
};

/** The French CA3. Lines 08 to T2 carry the base and the tax by rate, self-assessed VAT included. */
export async function franceVatReturn(tx: Tx, companyId: string, from: string, to: string): Promise<Return> {
  const t = await totalsByCode(tx, companyId, from, to);
  const b: Record<string, VatBox> = Object.fromEntries(Object.keys(FR_LABELS).map((k) => [k, box()]));
  const dom = S(t, ...[20, 10, 5.5, 2.1].flatMap((r) => byRate(t, r)));
  b.A1.amount = dom.amount;
  const ica = t.purchases.get('ICA'), rcs = t.purchases.get('RCS');
  b.A3.amount = rcs?.net ?? 0; b.B2.amount = ica?.net ?? 0;
  b.E1.amount = S(t, 'EXP').amount; b.E2.amount = S(t, 'ICS', 'ZR', 'EX', 'OS').amount; b.F2.amount = S(t, 'IC').amount;
  for (const [k, rate] of [['08', 20], ['09', 5.5], ['9B', 10], ['T2', 2.1]] as const) b[k] = S(t, ...byRate(t, rate));
  b['08'].amount += (ica?.net ?? 0) + (rcs?.net ?? 0); b['08'].vat += (ica?.vatOut ?? 0) + (rcs?.vatOut ?? 0);
  b['17'].vat = ica?.vatOut ?? 0;
  const out = b['08'].vat + b['09'].vat + b['9B'].vat + b.T2.vat;
  b['16'].vat = out;
  const inp = P(t, ...t.purchases.keys()).vat;
  b['20'].vat = inp; b['23'].vat = inp;
  if (out >= inp) b['28'].vat = out - inp; else b['25'].vat = inp - out;
  return result(b, FR_LABELS, out, inp, ['Self-assessed VAT on EU acquisitions and services is in line 08 and deducted in line 20. VAT on fixed assets (line 19) is in line 20; move it on impots.gouv.fr if you report it separately.']);
}

export const NL_LABELS: Record<string, string> = {
  '1a': 'Leveringen/diensten belast met hoog tarief (21%)', '1b': 'Leveringen/diensten belast met laag tarief (9%)', '1e': 'Leveringen/diensten belast met 0% of niet bij u belast',
  '3a': 'Leveringen naar landen buiten de EU', '3b': 'Leveringen naar of diensten in landen binnen de EU', '4a': 'Leveringen/diensten uit landen buiten de EU',
  '4b': 'Leveringen/diensten uit landen binnen de EU', '5a': 'Verschuldigde omzetbelasting', '5b': 'Voorbelasting', '5c': 'Subtotaal', '5g': 'Totaal te betalen / terug te vragen',
};

/** The Dutch aangifte omzetbelasting. */
export async function netherlandsVatReturn(tx: Tx, companyId: string, from: string, to: string): Promise<Return> {
  const t = await totalsByCode(tx, companyId, from, to);
  const b: Record<string, VatBox> = Object.fromEntries(Object.keys(NL_LABELS).map((k) => [k, box()]));
  b['1a'] = S(t, ...byRate(t, 21)); b['1b'] = S(t, ...byRate(t, 9)); b['1e'].amount = S(t, 'ZR', 'EX').amount;
  b['3a'].amount = S(t, 'EXP').amount; b['3b'].amount = S(t, 'IC', 'ICS').amount;
  const ica = t.purchases.get('ICA'), rcs = t.purchases.get('RCS');
  b['4a'] = { amount: (rcs?.net ?? 0) - (rcs?.fromEu ?? 0), vat: (rcs?.vatOut ?? 0) - (rcs?.fromEuVat ?? 0) };
  b['4b'] = { amount: (ica?.net ?? 0) + (rcs?.fromEu ?? 0), vat: (ica?.vatOut ?? 0) + (rcs?.fromEuVat ?? 0) };
  const out = b['1a'].vat + b['1b'].vat + b['4a'].vat + b['4b'].vat;
  const inp = P(t, ...t.purchases.keys()).vat;
  b['5a'].vat = out; b['5b'].vat = inp; b['5c'].vat = out - inp; b['5g'].vat = out - inp;
  return result(b, NL_LABELS, out, inp, ['Rubriek 5g is negative when you get money back. The amounts are rounded to whole euros on the Belastingdienst portal.']);
}

export const ES_LABELS: Record<string, string> = {
  '01': 'Régimen general 4% (base y cuota)', '04': 'Régimen general 10%', '07': 'Régimen general 21%', '10': 'Adquisiciones intracomunitarias de bienes y servicios',
  '12': 'Otras operaciones con inversión del sujeto pasivo', '27': 'Total cuota devengada', '28': 'Por cuotas soportadas en operaciones interiores corrientes',
  '36': 'En adquisiciones intracomunitarias de bienes y servicios corrientes', '45': 'Total a deducir', '46': 'Resultado régimen general',
  '59': 'Entregas intracomunitarias de bienes y servicios', '60': 'Exportaciones y operaciones asimiladas', '120': 'Operaciones no sujetas o con inversión del sujeto pasivo',
};

/** Spanish modelo 303 (main casillas). */
export async function spainVatReturn(tx: Tx, companyId: string, from: string, to: string): Promise<Return> {
  const t = await totalsByCode(tx, companyId, from, to);
  const b: Record<string, VatBox> = Object.fromEntries(Object.keys(ES_LABELS).map((k) => [k, box()]));
  b['01'] = S(t, ...byRate(t, 4)); b['04'] = S(t, ...byRate(t, 10)); b['07'] = S(t, ...byRate(t, 21));
  const ica = t.purchases.get('ICA'), rcs = t.purchases.get('RCS');
  b['10'] = { amount: (ica?.net ?? 0) + (rcs?.fromEu ?? 0), vat: (ica?.vatOut ?? 0) + (rcs?.fromEuVat ?? 0) };
  b['12'] = { amount: (rcs?.net ?? 0) - (rcs?.fromEu ?? 0), vat: (rcs?.vatOut ?? 0) - (rcs?.fromEuVat ?? 0) };
  const out = b['01'].vat + b['04'].vat + b['07'].vat + b['10'].vat + b['12'].vat;
  b['27'].vat = out;
  // Input VAT on services from EU suppliers, in proportion to their share of the reverse-charged services.
  const euShare = rcs && rcs.net ? rcs.fromEu / rcs.net : 0;
  b['36'].vat = (ica?.vatIn ?? 0) + (rcs?.vatIn ?? 0) * euShare;
  const inp = P(t, ...t.purchases.keys()).vat;
  b['28'].vat = inp - b['36'].vat; b['45'].vat = inp; b['46'].vat = out - inp;
  b['59'].amount = S(t, 'IC', 'ICS').amount; b['60'].amount = S(t, 'EXP').amount; b['120'].amount = S(t, 'OS').amount;
  return result(b, ES_LABELS, out, inp, ['Casilla 46 is negative when it is to be compensated or refunded. Equivalence surcharge (recargo de equivalencia) is not covered.']);
}

export const IT_LABELS: Record<string, string> = {
  VP2: 'Totale operazioni attive (al netto dell\'IVA)', VP3: 'Totale operazioni passive (al netto dell\'IVA)', VP4: 'IVA esigibile',
  VP5: 'IVA detratta', VP6: 'IVA dovuta (o a credito)',
};

/** The Italian periodic VAT settlement (LIPE quadro VP). Reverse charge (integrazione) counts on both sides. */
export async function italyVatReturn(tx: Tx, companyId: string, from: string, to: string): Promise<Return> {
  const t = await totalsByCode(tx, companyId, from, to);
  const b: Record<string, VatBox> = Object.fromEntries(Object.keys(IT_LABELS).map((k) => [k, box()]));
  b.VP2.amount = S(t, ...others(t.sales, 'OS')).amount; b.VP3.amount = P(t, ...others(t.purchases, 'OS')).amount;
  const out = S(t, ...t.sales.keys()).vat + selfAssessed(t, 'ICA', 'RCS');
  const inp = P(t, ...t.purchases.keys()).vat;
  b.VP4.vat = out; b.VP5.vat = inp; b.VP6.vat = out - inp;
  return result(b, IT_LABELS, out, inp, ['VP6 is negative when the period ends in credit. Previous credits, advance payments and interest for quarterly filers (VP7 to VP14) are added in the filing software.']);
}

export const EUROPE_RETURNS: Record<string, (tx: Tx, companyId: string, from: string, to: string) => Promise<Return>> = {
  GB: ukVatReturn, IE: irelandVatReturn, DE: germanyVatReturn, FR: franceVatReturn, NL: netherlandsVatReturn, ES: spainVatReturn, IT: italyVatReturn,
};

/**
 * The EC sales list (recapitulative statement): each EU business customer's VAT
 * number and the value of goods (IC) and services (ICS) supplied in the period,
 * credit notes netted off.
 */
export async function ecSalesRows(tx: Tx, companyId: string, from: string, to: string) {
  const rows = await many(tx, `
    SELECT p.country_code AS country, p.tax_registration_no AS vat_number, p.name AS customer,
           sum(CASE WHEN t.code = 'IC' THEN (CASE WHEN i.kind = 'sales_credit' THEN -1 ELSE 1 END) * l.net_amount * i.fx_rate ELSE 0 END)::float AS goods,
           sum(CASE WHEN t.code = 'ICS' THEN (CASE WHEN i.kind = 'sales_credit' THEN -1 ELSE 1 END) * l.net_amount * i.fx_rate ELSE 0 END)::float AS services
      FROM fin.invoices i JOIN fin.invoice_lines l ON l.invoice_id = i.id JOIN fin.tax_codes t ON t.id = l.tax_code_id
      JOIN mdm.parties p ON p.id = i.party_id
     WHERE i.company_id = $1 AND i.status = 'posted' AND i.kind IN ('sales_invoice','sales_credit') AND i.date BETWEEN $2 AND $3 AND t.code IN ('IC','ICS')
     GROUP BY 1, 2, 3 ORDER BY 1, 3`, [companyId, from, to]);
  return rows.map((r) => ({ ...r, goods: roundMoney(r.goods), services: roundMoney(r.services) }));
}
