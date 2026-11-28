import { ValidationError } from '../core/errors.ts';
import { roundMoney } from '../core/money.ts';
import { indiaAnnualTax, pakistanAnnualTax } from '../hr/incometax.ts';
import { UAE_CHART, type AccountTemplate } from './coa.ts';
import type { ContributionTemplate, CountryPack, EndReason, TaxCodeTemplate } from './country.ts';

/**
 * India and Pakistan.
 *
 * India: GST in two shapes. A sale inside the seller's state carries CGST and SGST
 * (half the rate each), a sale to another state IGST; the tax codes say which
 * (G5, G18, G40 against I5, I18, I40) and posting a sales invoice checks the
 * customer's state against the company's. GSTR-3B and GSTR-1 are built from the
 * ledger and the invoices; e-invoices are the IRP JSON (schema 1.1). Payroll has
 * EPF, EPS, EDLI and ESI, income tax withheld on salary under the new regime
 * (projected over the financial year, April to March), and gratuity under the
 * Payment of Gratuity Act.
 *
 * Pakistan: sales tax on goods with the FBR (18%) and on services with the
 * provinces (SRB, PRA, KPRA, BRA), each authority's return built from its codes;
 * FBR digital invoices as the DI JSON. Payroll has EOBI and provincial social
 * security, income tax withheld on salary (tax year July to June) and gratuity.
 */

const chart = (names: Record<string, string>, withheld: string): AccountTemplate[] => {
  const out = UAE_CHART.map((a) => (names[a.code] ? { ...a, name: names[a.code] } : a));
  const at = out.findIndex((a) => a.code === '2230');
  out.splice(at + 1, 0, { code: '2240', name: withheld, type: 'liability', parent: '21', kind: 'L', role: 'income_tax_withheld', manual: false });
  return out;
};

/** Indian state and union territory codes (the first two digits of a GSTIN). */
export const IN_STATES: Record<string, string> = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand', '06': 'Haryana', '07': 'Delhi',
  '08': 'Rajasthan', '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim', '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur', '15': 'Mizoram',
  '16': 'Tripura', '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal', '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh',
  '24': 'Gujarat', '26': 'Dadra and Nagar Haveli and Daman and Diu', '27': 'Maharashtra', '29': 'Karnataka', '30': 'Goa', '31': 'Lakshadweep', '32': 'Kerala',
  '33': 'Tamil Nadu', '34': 'Puducherry', '35': 'Andaman and Nicobar Islands', '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh', '97': 'Other Territory',
};

const GSTIN_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
/** A GSTIN: state code, PAN, entity number, Z, and a check character (base-36 weighted sum). */
export function validGstin(raw: string): boolean {
  const g = raw.toUpperCase().replace(/\s/g, '');
  if (!/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(g) || !IN_STATES[g.slice(0, 2)]) return false;
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = GSTIN_CHARS.indexOf(g[i]) * (i % 2 ? 2 : 1);
    sum += Math.floor(v / 36) + (v % 36);
  }
  return GSTIN_CHARS[(36 - (sum % 36)) % 36] === g[14];
}
/** The state of a GSTIN, or null. */
export const gstinState = (g: string | null | undefined) => (g && /^\d{2}/.test(g) && IN_STATES[g.slice(0, 2)] ? g.slice(0, 2) : null);

/**
 * GST codes. The e-invoice category follows the IRP: S taxable, Z nil rated,
 * E exempt, O non-GST, G export. The code's first letter tells intra-state (G,
 * CGST and SGST) from inter-state (I, IGST); reverse charge codes likewise.
 */
const IN_CODES: TaxCodeTemplate[] = [
  ...[5, 18, 40].map((r) => ({ code: `G${r}`, name: `GST ${r}% within the state (CGST ${r / 2}% + SGST ${r / 2}%)`, category: 'standard' as const, rate: r, einvoice: 'S' })),
  ...[5, 18, 40].map((r) => ({ code: `I${r}`, name: `IGST ${r}% (to another state)`, category: 'standard' as const, rate: r, einvoice: 'S' })),
  { code: 'NIL', name: 'Nil rated', category: 'zero', rate: 0, einvoice: 'Z' },
  { code: 'EX', name: 'Exempt', category: 'exempt', rate: 0, einvoice: 'E' },
  { code: 'NG', name: 'Non-GST supply', category: 'out_of_scope', rate: 0, einvoice: 'O' },
  { code: 'EXP', name: 'Export under LUT, without IGST (zero rated)', category: 'zero', rate: 0, einvoice: 'G' },
  { code: 'RCM5', name: 'Reverse charge 5% within the state (CGST + SGST)', category: 'reverse_charge', rate: 5, einvoice: null },
  { code: 'RCM18', name: 'Reverse charge 18% within the state (CGST + SGST)', category: 'reverse_charge', rate: 18, einvoice: null },
  { code: 'RCMI18', name: 'Reverse charge 18% IGST (imported services, other states)', category: 'reverse_charge', rate: 18, einvoice: null },
];
/** Which GST heads a code's tax goes to. */
export const gstHead = (code: string): 'igst' | 'cgst_sgst' | null =>
  /^(I\d|RCMI)/.test(code) ? 'igst' : /^(G\d|RCM\d)/.test(code) ? 'cgst_sgst' : null;

/**
 * Payment of Gratuity Act 1972: 15 days' wages (basic, over 26 working days) for
 * each completed year, more than six months counting as a year, from five years'
 * service (any service on death), at most INR 20 lakh.
 */
export const IN_GRATUITY_CAP = 2000000;
export function indiaGratuity(pay: { basic: number; housing: number }, joined: string, at: string, reason?: EndReason | null): number {
  if (at <= joined) return 0;
  const exact = (Date.parse(`${at}T00:00:00Z`) - Date.parse(`${joined}T00:00:00Z`)) / 86_400_000 / 365.25;
  if (exact < 5 && reason !== 'death') return 0;
  const years = Math.floor(exact) + (exact - Math.floor(exact) > 0.5 ? 1 : 0);
  return roundMoney(Math.min(15 / 26 * pay.basic * years, IN_GRATUITY_CAP));
}

/** Pakistan (Standing Orders Ordinance, order 12(6)): 30 days' wages for each completed year, more than six months counting as a year. */
export function pakistanGratuity(pay: { basic: number; housing: number }, joined: string, at: string): number {
  if (at <= joined) return 0;
  const exact = (Date.parse(`${at}T00:00:00Z`) - Date.parse(`${joined}T00:00:00Z`)) / 86_400_000 / 365.25;
  const years = Math.floor(exact) + (exact - Math.floor(exact) > 0.5 ? 1 : 0);
  return roundMoney(years * pay.basic);
}

const C = (code: string, name: string, employeePct: number, employerPct: number, base: ContributionTemplate['base'], monthlyCap: number | null,
  extra: Partial<ContributionTemplate> = {}): ContributionTemplate => ({ code, name, appliesTo: 'all', employeePct, employerPct, base, monthlyCap, ...extra });

export const INDIA: CountryPack = {
  country: 'IN', name: 'India', currency: 'INR', taxAuthority: 'GSTN', vatForm: 'IN-GSTR3B', vatFormName: 'GSTR-3B (monthly GST return)', region: 'SA',
  chart: chart({ '2100': 'Output GST (CGST, SGST, IGST)', '1200': 'Input Tax Credit (CGST, SGST, IGST)', '2110': 'GST Payable (electronic cash ledger)',
    '2220': 'EPF and ESI Contributions Payable', '5930': 'Employer EPF, EPS, EDLI and ESI', '2400': 'Income Tax Payable', '5950': 'Income Tax Expense',
    '2500': 'Gratuity Provision', '5920': 'Gratuity Expense' }, 'TDS on Salaries Payable (section 192)'),
  taxCodes: IN_CODES,
  taxNumber: { test: validGstin, message: 'a GSTIN has 15 characters: state code, PAN, entity number, Z and a check character' },
  iban: { re: /^[A-Z]{4}0[A-Z0-9]{6}-\d{9,18}$/, message: 'India has no IBAN: enter the IFSC and the account number as IFSC-ACCOUNT, for example HDFC0001234-50100123456789' },
  defaults: { corporateTaxRate: 25.17, corporateTaxThreshold: 0 },
  corporateTaxGap: null,
  corporateTaxRule: '22% under section 115BAA with 10% surcharge and 4% cess (25.17%); MAT, older regimes and deferred tax are not covered',
  einvoice: 'in_irp', wps: false, sepa: false,
  payrollFileGap: 'the ECR for EPFO, the ESIC return and Form 24Q are not filed from BAATS yet; prepare them from the payslips',
  incomeTax: { method: 'annual_slab', annualTax: indiaAnnualTax, yearStartMonth: 4,
    rule: 'TDS on salary under the new regime (FY 2025-26 slabs, standard deduction INR 75,000, rebate up to INR 12 lakh, surcharge above INR 50 lakh, 4% cess), the year\'s tax spread over the months left (April to March)',
    gap: 'the old regime and its investment declarations are not covered; an employee who chooses it needs the TDS worked out outside BAATS' },
  contributions: [
    C('EPF', 'Employees\' Provident Fund (employer 3.67% after EPS)', 12, 3.67, 'basic', 15000),
    C('EPS', 'Employees\' Pension Scheme', 0, 8.33, 'basic', 15000),
    C('EDLI', 'Employees\' Deposit Linked Insurance', 0, 0.5, 'basic', 15000),
    C('EPF_ADMIN', 'EPF administration charges', 0, 0.5, 'basic', 15000),
    C('ESI', 'Employees\' State Insurance (wages up to INR 21,000)', 0.75, 3.25, 'gross', null, { eligibleUpTo: 21000 }),
  ],
  endOfServiceRule: 'gratuity: 15 days\' basic (over 26 days) for each year from 5 years\' service, more than 6 months counting as a year, at most INR 20 lakh',
  endOfService: indiaGratuity,
};

/**
 * Pakistan. Sales tax on goods is federal (FBR, 18%); sales tax on services is
 * provincial: Sindh (SRB) 15%, Punjab (PRA) 16%, Khyber Pakhtunkhwa (KPRA) 15%,
 * Balochistan (BRA) 15%.
 */
const PK_CODES: TaxCodeTemplate[] = [
  { code: 'ST18', name: 'Sales tax on goods 18% (FBR)', category: 'standard', rate: 18, einvoice: 'S' },
  { code: 'SRB15', name: 'Sindh sales tax on services 15% (SRB)', category: 'standard', rate: 15, einvoice: 'S' },
  { code: 'PRA16', name: 'Punjab sales tax on services 16% (PRA)', category: 'standard', rate: 16, einvoice: 'S' },
  { code: 'KPRA15', name: 'Khyber Pakhtunkhwa sales tax on services 15% (KPRA)', category: 'standard', rate: 15, einvoice: 'S' },
  { code: 'BRA15', name: 'Balochistan sales tax on services 15% (BRA)', category: 'standard', rate: 15, einvoice: 'S' },
  { code: 'ZR', name: 'Zero rated (Fifth Schedule, exports)', category: 'zero', rate: 0, einvoice: 'Z' },
  { code: 'EX', name: 'Exempt (Sixth Schedule)', category: 'exempt', rate: 0, einvoice: 'E' },
  { code: 'OS', name: 'Out of scope', category: 'out_of_scope', rate: 0, einvoice: 'O' },
];
/** The sales tax authority of each Pakistani code. */
export const PK_AUTHORITY: Record<string, string> = { ST18: 'FBR', ZR: 'FBR', EX: 'FBR', SRB15: 'SRB', PRA16: 'PRA', KPRA15: 'KPRA', BRA15: 'BRA' };

export const PAKISTAN: CountryPack = {
  country: 'PK', name: 'Pakistan', currency: 'PKR', taxAuthority: 'FBR', vatForm: 'PK-STR', vatFormName: 'Sales tax returns (FBR and provincial)', region: 'SA',
  chart: chart({ '2100': 'Sales Tax Payable (output)', '1200': 'Sales Tax Recoverable (input)', '2110': 'Sales Tax Payable to FBR and provinces',
    '2220': 'EOBI and Social Security Payable', '5930': 'Employer EOBI and Social Security', '2400': 'Income Tax Payable', '5950': 'Income Tax Expense',
    '2500': 'Gratuity Provision', '5920': 'Gratuity Expense' }, 'Income Tax Deducted from Salaries (section 149)'),
  taxCodes: PK_CODES,
  taxNumber: { test: (s) => /^\d{7}-?\d$/.test(s) || /^\d{13}$/.test(s), message: 'enter the NTN (7 digits and a check digit) or the 13-digit sales tax registration number' },
  iban: { re: /^PK\d{2}[A-Z]{4}[A-Z0-9]{16}$/, message: 'a Pakistani IBAN is PK, 2 check digits, a 4-letter bank code and 16 characters' },
  defaults: { corporateTaxRate: 29, corporateTaxThreshold: 0 },
  corporateTaxGap: null,
  corporateTaxRule: '29% for companies; super tax (section 4C), minimum and final taxes are not covered',
  einvoice: 'pk_fbr', wps: false, sepa: false,
  payrollFileGap: 'the annual and monthly salary withholding statements (section 165) and EOBI challans are not filed from BAATS yet; prepare them from the payslips',
  incomeTax: { method: 'annual_slab', annualTax: pakistanAnnualTax, yearStartMonth: 7, rule: 'income tax on salary at the tax year 2025-26 rates for salaried persons (with the 9% surcharge above PKR 10 million), the year\'s tax spread over the months left (July to June)' },
  contributions: [
    C('EOBI', 'EOBI old-age benefits (on the minimum wage)', 1, 5, 'gross', 37000),
    C('PK_SOCIAL_SECURITY', 'Provincial social security (PESSI, SESSI; on wages up to the minimum wage)', 0, 6, 'gross', 37000),
  ],
  endOfServiceRule: 'gratuity: 30 days\' basic for each completed year, more than 6 months counting as a year',
  endOfService: (pay, joined, at) => pakistanGratuity(pay, joined, at),
};

export const SOUTH_ASIA_PACKS = { IN: INDIA, PK: PAKISTAN };

/** A party's Indian state: from its GSTIN, else its state_code attribute (unregistered customers). */
export const partyState = (p: { country_code: string; tax_registration_no: string | null; attributes?: Record<string, any> | null }) =>
  p.country_code !== 'IN' ? null : gstinState(p.tax_registration_no) ?? (IN_STATES[String(p.attributes?.state_code ?? '')] ? String(p.attributes!.state_code) : null);

/**
 * India: CGST and SGST apply to a supply inside the supplier's state, IGST to one
 * that crosses a state line (Integrated GST Act, sections 7 and 8). A line coded the
 * wrong way is refused, naming the code to use. Supplies to and from abroad are
 * inter-state, so a foreign party may not carry CGST and SGST.
 */
export function checkPlaceOfSupply(companyGstin: string | null, party: Parameters<typeof partyState>[0], code: string, line: number) {
  const head = gstHead(code);
  if (!head) return;
  const ours = gstinState(companyGstin);
  if (!ours) throw new ValidationError('enter the company\'s GSTIN under company details before invoicing with GST codes; its state decides CGST and SGST against IGST');
  if (party.country_code !== 'IN') {
    if (head === 'cgst_sgst') throw new ValidationError(`line ${line}: a supply to or from abroad is inter-state; use an IGST code (I or RCMI) or EXP, not ${code}`);
    return;
  }
  const theirs = partyState(party);
  if (!theirs) throw new ValidationError(`line ${line}: the party has no GSTIN or state_code, so the place of supply is unknown; add one to the party`);
  const intra = theirs === ours;
  if (intra && head === 'igst') throw new ValidationError(`line ${line}: the party is in ${IN_STATES[ours]} like the company, so the supply is within the state; use ${code.replace(/^I/, 'G').replace(/^RCMI/, 'RCM')} (CGST and SGST)`);
  if (!intra && head === 'cgst_sgst') throw new ValidationError(`line ${line}: the party is in ${IN_STATES[theirs]} and the company in ${IN_STATES[ours]}, so the supply is inter-state; use ${code.replace(/^G/, 'I').replace(/^RCM(\d)/, 'RCMI$1')} (IGST)`);
}
